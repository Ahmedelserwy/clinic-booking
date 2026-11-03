using System.ComponentModel.DataAnnotations;
using Application.DTOs.Expenses;   // CategoryTotalDto

namespace Application.DTOs.Finance;

public static class FinanceRules
{
    public const string AdminRole = "Admin";
    public const string ReceptionistRole = "Receptionist";

    public static readonly HashSet<string> Kinds = new() { "examination", "visit", "free" };
    public static readonly HashSet<string> Methods = new() { "cash", "card", "wallet", "bank" };
}

// ------------------------------------------------------------------ payments --

public record PaymentDto(
    int Id,
    int AppointmentId,
    int? PatientId,
    string PatientName,
    int? DoctorId,
    string DoctorName,
    string Kind,
    decimal Amount,
    string Method,
    DateTime PaidAt,
    string? Notes,
    decimal RefundedAmount,
    DateTime? RefundedAt,
    string? RefundReason,
    string ReceivedBy);

public class PaymentInputDto
{
    [Required]
    public int AppointmentId { get; set; }

    [Required, MaxLength(120)]
    public string PatientName { get; set; } = string.Empty;

    [Required]
    public string Kind { get; set; } = "examination";

    [Range(0, 999999999)]
    public decimal Amount { get; set; }

    [Required]
    public string Method { get; set; } = "cash";

    [MaxLength(300)]
    public string? Notes { get; set; }
}

public class RefundInputDto
{
    [Range(0.01, 999999999)]
    public decimal Amount { get; set; }

    [Required, MaxLength(300)]
    public string Reason { get; set; } = string.Empty;
}

public class PaymentQueryDto
{
    public DateOnly? From { get; set; }
    public DateOnly? To { get; set; }
    public string? Search { get; set; }
    public string? Kind { get; set; }
    public string? Method { get; set; }
}

public class PaymentListDto
{
    public List<PaymentDto> Items { get; set; } = new();

    /// <summary>Every payment that matches the filters, even when Items is capped.</summary>
    public int TotalCount { get; set; }
    public decimal TotalCollected { get; set; }
    public decimal TotalRefunded { get; set; }
}

// ------------------------------------------------------------------- reports --

public record IncomeBreakdownDto(
    int ExaminationCount,
    decimal ExaminationAmount,
    int VisitCount,
    decimal VisitAmount,
    int FreeCount,
    decimal Collected,
    decimal Refunded,
    decimal Net);

public record MethodTotalDto(string Method, decimal Collected, decimal Refunded, decimal Net);

public record SavedClosingDto(
    decimal OpeningCash,
    decimal ExpectedCash,
    decimal CountedCash,
    decimal Difference,
    string? Notes,
    string ClosedBy,
    DateTime ClosedAt);

public record DailyClosingDto(
    DateOnly Date,
    IncomeBreakdownDto Breakdown,
    List<MethodTotalDto> ByMethod,
    decimal CashCollected,
    decimal CashRefunded,
    decimal CashExpenses,
    decimal SuggestedOpeningCash,
    decimal OpeningCash,
    decimal ExpectedCash,
    SavedClosingDto? Saved);

public class DailyClosingInputDto
{
    public DateOnly Date { get; set; }

    [Range(0, 999999999)]
    public decimal OpeningCash { get; set; }

    [Range(0, 999999999)]
    public decimal CountedCash { get; set; }

    [MaxLength(500)]
    public string? Notes { get; set; }
}

public record RevenueDayDto(
    DateOnly Date, int Examinations, int Visits, int Free, decimal Collected, decimal Refunded, decimal Net);

public record DoctorRevenueDto(
    string Doctor, int Examinations, int Visits, int Free, decimal Collected, decimal Refunded, decimal Net);

public record RevenueDto(
    DateOnly From,
    DateOnly To,
    IncomeBreakdownDto Breakdown,
    decimal PreviousNet,
    List<RevenueDayDto> Days,
    List<DoctorRevenueDto> Doctors,
    List<MethodTotalDto> ByMethod);

public record PeriodRowDto(string Key, decimal Income, decimal Expenses, decimal Net);

public record PeriodDto(
    DateOnly From,
    DateOnly To,
    string Group,
    IncomeBreakdownDto Breakdown,
    decimal Expenses,
    decimal NetProfit,
    List<MethodTotalDto> ByMethod,
    List<CategoryTotalDto> ExpensesByCategory,
    List<PeriodRowDto> Rows);

// ------------------------------------------------------------------- time --

/// <summary>
/// "Which day was this?" is a question about the clinic's wall clock, not about UTC. A payment
/// taken at 11:30 pm in Cairo belongs to that day's cash count even though it is already tomorrow
/// in UTC, so every day boundary here is Egypt local time.
/// </summary>
public static class FinanceTime
{
    public static readonly TimeZoneInfo Cairo = TimeZoneInfo.FindSystemTimeZoneById(
        OperatingSystem.IsWindows() ? "Egypt Standard Time" : "Africa/Cairo");

    public static DateOnly Today => LocalDay(DateTime.UtcNow);

    public static DateOnly LocalDay(DateTime utc) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), Cairo));

    /// <summary>The UTC instant at which the given Egypt day begins. Inclusive lower bound.</summary>
    public static DateTime StartOfDayUtc(DateOnly day)
    {
        var local = day.ToDateTime(TimeOnly.MinValue);

        // Egypt moves its clocks at midnight, so 00:00 can be a time that does not exist.
        if (Cairo.IsInvalidTime(local))
        {
            local = local.AddHours(1);
        }

        return TimeZoneInfo.ConvertTimeToUtc(local, Cairo);
    }

    /// <summary>The UTC instant at which the NEXT Egypt day begins. Exclusive upper bound.</summary>
    public static DateTime EndOfDayUtc(DateOnly day) => StartOfDayUtc(day.AddDays(1));
}