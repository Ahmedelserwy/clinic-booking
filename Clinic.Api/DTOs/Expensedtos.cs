// Place in your Application project (DTOs folder).
using System.ComponentModel.DataAnnotations;

namespace Application.DTOs.Expenses;

public record ExpenseDto(
    int Id,
    string Title,
    string Category,
    decimal Amount,
    DateOnly ExpenseDate,
    string PaymentMethod,
    bool IsRecurring,
    string? Notes);

public class ExpenseInputDto
{
    [Required, MaxLength(120)]
    public string Title { get; set; } = string.Empty;

    [Required]
    public string Category { get; set; } = "other";

    [Range(0.01, 999999999)]
    public decimal Amount { get; set; }

    public DateOnly ExpenseDate { get; set; }

    [Required]
    public string PaymentMethod { get; set; } = "cash";

    public bool IsRecurring { get; set; }

    [MaxLength(500)]
    public string? Notes { get; set; }
}

public class ExpenseQueryDto
{
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 10;
    public string? Search { get; set; }
    public string? Category { get; set; }
    public DateOnly? From { get; set; }
    public DateOnly? To { get; set; }
}

public record CategoryTotalDto(string Category, decimal Total);

public record ExpenseSummaryDto(
    decimal MonthTotal,
    decimal PrevMonthTotal,
    int MonthCount,
    decimal YearTotal,
    List<CategoryTotalDto> ByCategory);

// If you already have a PageResult<T> in your shared project, delete this one and use yours
// (it must serialize as items / totalCount / page / pageSize).
public class ExpensePage<T>
{
    public List<T> Items { get; set; } = new();
    public int TotalCount { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}