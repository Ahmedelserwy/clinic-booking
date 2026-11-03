// Place in your API project (Controllers folder).
//
// Money received at the desk. Pay-first clinic: one payment per appointment, taken before the
// examination, so there is no balance, no partial payment and no invoice here.
//
// Tenant handling is entirely ClinicDbContext's job (query filter + insert stamping), exactly as in
// ExpensesController, so nothing below mentions it.
//
// There is deliberately NO delete endpoint. A payment that was taken by mistake is refunded, which
// leaves a trail; deleting it would silently change a day that may already have been closed.
//
// Also in this file: FinanceController (daily closing and the financial reports).

using System.Globalization;
using Application.DTOs.Expenses;
using Application.DTOs.Finance;
using Clinic.Domain.Entites;
using Clinic.Infrastructure.Data.Context;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Clinic.API.Controllers
{
    [ApiController]
    [Authorize(Roles = FinanceRules.AdminRole + "," + FinanceRules.ReceptionistRole)]
    [Route("api/payments")]
    public class PaymentsController : ControllerBase
    {
        // A month is a few hundred rows; this only stops an unbounded range from being serialised.
        private const int MaxRows = 2000;

        private readonly ClinicDbContext _db;

        public PaymentsController(ClinicDbContext db) => _db = db;

        // GET api/payments?from=2026-10-01&to=2026-10-25&search=&kind=&method=
        [HttpGet]
        public async Task<ActionResult<PaymentListDto>> List([FromQuery] PaymentQueryDto q, CancellationToken ct)
        {
            var query = _db.Payments.AsNoTracking().AsQueryable();

            if (q.From.HasValue)
            {
                var start = FinanceTime.StartOfDayUtc(q.From.Value);
                query = query.Where(p => p.PaidAtUtc >= start);
            }
            if (q.To.HasValue)
            {
                var end = FinanceTime.EndOfDayUtc(q.To.Value);
                query = query.Where(p => p.PaidAtUtc < end);
            }
            if (!string.IsNullOrWhiteSpace(q.Search))
            {
                var s = q.Search.Trim().ToLower();
                query = query.Where(p => p.PatientName.ToLower().Contains(s) ||
                                         p.DoctorName.ToLower().Contains(s) ||
                                         (p.Notes != null && p.Notes.ToLower().Contains(s)));
            }
            if (!string.IsNullOrWhiteSpace(q.Kind))
                query = query.Where(p => p.Kind == q.Kind);
            if (!string.IsNullOrWhiteSpace(q.Method))
                query = query.Where(p => p.Method == q.Method);

            var totalCount = await query.CountAsync(ct);
            var collected = await query.SumAsync(p => (decimal?)p.Amount, ct) ?? 0m;
            var refunded = await query.SumAsync(p => (decimal?)p.RefundedAmount, ct) ?? 0m;

            var items = await query
                .OrderByDescending(p => p.PaidAtUtc).ThenByDescending(p => p.Id)
                .Take(MaxRows)
                .Select(p => new PaymentDto(p.Id, p.AppointmentId, p.PatientId, p.PatientName, p.DoctorId,
                                            p.DoctorName, p.Kind, p.Amount, p.Method, p.PaidAtUtc, p.Notes,
                                            p.RefundedAmount, p.RefundedAtUtc, p.RefundReason, p.ReceivedBy))
                .ToListAsync(ct);

            return Ok(new PaymentListDto
            {
                Items = items,
                TotalCount = totalCount,
                TotalCollected = collected,
                TotalRefunded = refunded
            });
        }

        // POST api/payments
        [HttpPost]
        public async Task<ActionResult<PaymentDto>> Create([FromBody] PaymentInputDto input, CancellationToken ct)
        {
            if (!FinanceRules.Kinds.Contains(input.Kind))
                return BadRequest(new { message = "Unknown payment type." });
            if (!FinanceRules.Methods.Contains(input.Method))
                return BadRequest(new { message = "Unknown payment method." });

            var free = input.Kind == "free";
            if (!free && input.Amount <= 0)
                return BadRequest(new { message = "The amount must be greater than zero." });

            // Patient and doctor come from the appointment itself, not from the request, so a
            // payment cannot be attached to a doctor the appointment does not belong to.
            var appointment = await _db.Appointments.AsNoTracking()
                .Where(a => a.Id == input.AppointmentId)
                .Select(a => new { a.PatientId, a.DoctorId, DoctorName = a.Doctor.Name, a.Status })
                .FirstOrDefaultAsync(ct);

            if (appointment is null)
                return NotFound(new { message = "Appointment not found." });
            if (appointment.Status.ToString() == "Cancelled")
                return BadRequest(new { message = "This appointment is cancelled." });

            if (await _db.Payments.AnyAsync(p => p.AppointmentId == input.AppointmentId, ct))
                return Conflict(new { message = "This appointment has already been paid." });

            var payment = new Payment
            {
                AppointmentId = input.AppointmentId,
                PatientId = appointment.PatientId,
                PatientName = input.PatientName.Trim(),
                DoctorId = appointment.DoctorId,
                DoctorName = appointment.DoctorName ?? string.Empty,
                Kind = input.Kind,
                Amount = free ? 0m : decimal.Round(input.Amount, 2),
                Method = input.Method,
                PaidAtUtc = DateTime.UtcNow,
                ReceivedBy = User.Identity?.Name ?? string.Empty,
                Notes = string.IsNullOrWhiteSpace(input.Notes) ? null : input.Notes.Trim()
            };

            _db.Payments.Add(payment);

            try
            {
                await _db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // The unique index on AppointmentId: someone else collected between our check and our insert.
                return Conflict(new { message = "This appointment has already been paid." });
            }

            return Ok(ToDto(payment));
        }

        // POST api/payments/{id}/refund   (administrators only: a refund is money leaving the clinic)
        [HttpPost("{id:int}/refund")]
        [Authorize(Roles = FinanceRules.AdminRole)]
        public async Task<ActionResult<PaymentDto>> Refund(int id, [FromBody] RefundInputDto input, CancellationToken ct)
        {
            var payment = await _db.Payments.FirstOrDefaultAsync(p => p.Id == id, ct);
            if (payment is null)
                return NotFound(new { message = "Payment not found." });

            // One refund per payment: the report places a refund on the day it happened, and a
            // single date column cannot hold two of them.
            if (payment.RefundedAmount > 0)
                return Conflict(new { message = "This payment has already been refunded." });

            var amount = decimal.Round(input.Amount, 2);
            if (amount > payment.Amount)
                return BadRequest(new { message = "The refund cannot be more than the amount paid." });

            payment.RefundedAmount = amount;
            payment.RefundedAtUtc = DateTime.UtcNow;
            payment.RefundReason = input.Reason.Trim();

            await _db.SaveChangesAsync(ct);
            return Ok(ToDto(payment));
        }

        private static PaymentDto ToDto(Payment p) =>
            new(p.Id, p.AppointmentId, p.PatientId, p.PatientName, p.DoctorId, p.DoctorName, p.Kind, p.Amount,
                p.Method, p.PaidAtUtc, p.Notes, p.RefundedAmount, p.RefundedAtUtc, p.RefundReason, p.ReceivedBy);
    }

    // ======================================================================
    // The financial reports
    // ======================================================================

    [ApiController]
    [Authorize(Roles = FinanceRules.AdminRole + "," + FinanceRules.ReceptionistRole)]
    [Route("api/finance")]
    public class FinanceController : ControllerBase
    {
        private readonly ClinicDbContext _db;

        public FinanceController(ClinicDbContext db) => _db = db;

        /// <summary>One movement of money: a payment received, or a refund given.</summary>
        private sealed record Flow(DateOnly Day, string Kind, string Method, string Doctor, decimal Amount, bool IsRefund);

        // ----------------------------------------------------------- daily closing --

        // GET api/finance/daily-closing?date=2026-10-25
        [HttpGet("daily-closing")]
        public async Task<ActionResult<DailyClosingDto>> DailyClosing([FromQuery] DateOnly date, CancellationToken ct)
            => Ok(await BuildClosingAsync(date, null, ct));

        // POST api/finance/daily-closing
        [HttpPost("daily-closing")]
        public async Task<ActionResult<DailyClosingDto>> SaveClosing([FromBody] DailyClosingInputDto input, CancellationToken ct)
        {
            if (input.Date > FinanceTime.Today)
                return BadRequest(new { message = "A day cannot be closed before it happens." });

            // What the system expects in the drawer, given the opening cash the receptionist entered.
            var preview = await BuildClosingAsync(input.Date, input.OpeningCash, ct);

            var closing = await _db.DailyClosings.FirstOrDefaultAsync(c => c.Date == input.Date, ct);
            if (closing is null)
            {
                closing = new DailyClosing { Date = input.Date };
                _db.DailyClosings.Add(closing);
            }

            // Closing the same day again replaces the earlier count; the audit columns keep who and when.
            closing.OpeningCash = input.OpeningCash;
            closing.ExpectedCash = preview.ExpectedCash;
            closing.CountedCash = input.CountedCash;
            closing.Difference = input.CountedCash - preview.ExpectedCash;
            closing.Notes = string.IsNullOrWhiteSpace(input.Notes) ? null : input.Notes.Trim();
            closing.ClosedBy = User.Identity?.Name ?? string.Empty;
            closing.ClosedAtUtc = DateTime.UtcNow;

            await _db.SaveChangesAsync(ct);
            return Ok(await BuildClosingAsync(input.Date, null, ct));
        }

        private async Task<DailyClosingDto> BuildClosingAsync(DateOnly date, decimal? openingOverride, CancellationToken ct)
        {
            var flows = await LoadFlowsAsync(date, date, ct);

            var saved = await _db.DailyClosings.AsNoTracking().FirstOrDefaultAsync(c => c.Date == date, ct);

            // Yesterday's counted cash is today's natural starting point.
            var suggested = await _db.DailyClosings.AsNoTracking()
                .Where(c => c.Date < date)
                .OrderByDescending(c => c.Date)
                .Select(c => (decimal?)c.CountedCash)
                .FirstOrDefaultAsync(ct) ?? 0m;

            var cashCollected = flows.Where(f => !f.IsRefund && f.Method == "cash").Sum(f => f.Amount);
            var cashRefunded = flows.Where(f => f.IsRefund && f.Method == "cash").Sum(f => f.Amount);

            // Only expenses paid in cash come out of the drawer.
            var cashExpenses = await _db.Expenses.AsNoTracking()
                .Where(e => e.ExpenseDate == date && e.PaymentMethod == "cash")
                .SumAsync(e => (decimal?)e.Amount, ct) ?? 0m;

            var opening = openingOverride ?? saved?.OpeningCash ?? suggested;
            var expected = opening + cashCollected - cashRefunded - cashExpenses;

            var savedDto = saved is null
                ? null
                : new SavedClosingDto(saved.OpeningCash, saved.ExpectedCash, saved.CountedCash, saved.Difference,
                                      saved.Notes, saved.ClosedBy, saved.ClosedAtUtc);

            return new DailyClosingDto(date, Break(flows), ByMethod(flows), cashCollected, cashRefunded, cashExpenses,
                                       suggested, opening, expected, savedDto);
        }

        // ------------------------------------------------------------------ revenue --

        // GET api/finance/revenue?from=2026-10-01&to=2026-10-31
        [HttpGet("revenue")]
        [Authorize(Roles = FinanceRules.AdminRole)]
        public async Task<ActionResult<RevenueDto>> Revenue([FromQuery] DateOnly from, [FromQuery] DateOnly to, CancellationToken ct)
        {
            if (!ValidRange(from, to))
                return BadRequest(new { message = "Choose a range of at most one year." });

            var flows = await LoadFlowsAsync(from, to, ct);

            var days = flows
                .GroupBy(f => f.Day)
                .OrderBy(g => g.Key)
                .Select(g =>
                {
                    var b = Break(g);
                    return new RevenueDayDto(g.Key, b.ExaminationCount, b.VisitCount, b.FreeCount, b.Collected, b.Refunded, b.Net);
                })
                .ToList();

            var doctors = flows
                .GroupBy(f => string.IsNullOrWhiteSpace(f.Doctor) ? "—" : f.Doctor)
                .Select(g =>
                {
                    var b = Break(g);
                    return new DoctorRevenueDto(g.Key, b.ExaminationCount, b.VisitCount, b.FreeCount, b.Collected, b.Refunded, b.Net);
                })
                .OrderByDescending(d => d.Net)
                .ToList();

            // The period of the same length immediately before, for "up or down?".
            var length = to.DayNumber - from.DayNumber + 1;
            var previousTo = from.AddDays(-1);
            var previousFrom = previousTo.AddDays(-(length - 1));
            var previous = Break(await LoadFlowsAsync(previousFrom, previousTo, ct));

            return Ok(new RevenueDto(from, to, Break(flows), previous.Net, days, doctors, ByMethod(flows)));
        }

        // ------------------------------------------------------- income vs expenses --

        // GET api/finance/period?from=2026-01-01&to=2026-12-31&group=month
        // Serves both "income vs expenses" and the financial summary.
        [HttpGet("period")]
        [Authorize(Roles = FinanceRules.AdminRole)]
        public async Task<ActionResult<PeriodDto>> Period(
            [FromQuery] DateOnly from, [FromQuery] DateOnly to, [FromQuery] string group = "month", CancellationToken ct = default)
        {
            if (!ValidRange(from, to))
                return BadRequest(new { message = "Choose a range of at most one year." });

            var byMonth = group != "day";
            var flows = await LoadFlowsAsync(from, to, ct);

            var expenses = await _db.Expenses.AsNoTracking()
                .Where(e => e.ExpenseDate >= from && e.ExpenseDate <= to)
                .Select(e => new { e.ExpenseDate, e.Category, e.Amount })
                .ToListAsync(ct);

            string KeyOf(DateOnly d) => byMonth
                ? $"{d.Year:D4}-{d.Month:D2}"
                : d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

            var income = flows
                .GroupBy(f => KeyOf(f.Day))
                .ToDictionary(g => g.Key, g => g.Where(f => !f.IsRefund).Sum(f => f.Amount) - g.Where(f => f.IsRefund).Sum(f => f.Amount));

            var spent = expenses
                .GroupBy(e => KeyOf(e.ExpenseDate))
                .ToDictionary(g => g.Key, g => g.Sum(e => e.Amount));

            IEnumerable<string> keys;
            if (byMonth)
            {
                // Every month in the range, quiet ones included, so a year always reads as 12 rows.
                var months = new List<string>();
                for (var cursor = new DateOnly(from.Year, from.Month, 1); cursor <= to; cursor = cursor.AddMonths(1))
                    months.Add(KeyOf(cursor));
                keys = months;
            }
            else
            {
                keys = income.Keys.Union(spent.Keys).OrderBy(k => k, StringComparer.Ordinal);
            }

            var rows = keys
                .Select(k =>
                {
                    var i = income.GetValueOrDefault(k);
                    var x = spent.GetValueOrDefault(k);
                    return new PeriodRowDto(k, i, x, i - x);
                })
                .ToList();

            var breakdown = Break(flows);
            var totalExpenses = expenses.Sum(e => e.Amount);

            var categories = expenses
                .GroupBy(e => e.Category)
                .Select(g => new CategoryTotalDto(g.Key, g.Sum(e => e.Amount)))
                .OrderByDescending(c => c.Total)
                .ToList();

            return Ok(new PeriodDto(from, to, byMonth ? "month" : "day", breakdown, totalExpenses,
                                    breakdown.Net - totalExpenses, ByMethod(flows), categories, rows));
        }

        // ----------------------------------------------------------------- helpers --

        private static bool ValidRange(DateOnly from, DateOnly to) =>
            to >= from && to.DayNumber - from.DayNumber <= 366;

        /// <summary>
        /// Every payment received and every refund given inside [from, to], as Egypt days.
        /// A payment that was later refunded appears twice: once as money in, once as money out.
        /// </summary>
        private async Task<List<Flow>> LoadFlowsAsync(DateOnly from, DateOnly to, CancellationToken ct)
        {
            var start = FinanceTime.StartOfDayUtc(from);
            var end = FinanceTime.EndOfDayUtc(to);

            var rows = await _db.Payments.AsNoTracking()
                .Where(p => (p.PaidAtUtc >= start && p.PaidAtUtc < end) ||
                            (p.RefundedAtUtc != null && p.RefundedAtUtc >= start && p.RefundedAtUtc < end))
                .Select(p => new { p.Kind, p.Method, p.DoctorName, p.Amount, p.PaidAtUtc, p.RefundedAmount, p.RefundedAtUtc })
                .ToListAsync(ct);

            var flows = new List<Flow>();
            foreach (var r in rows)
            {
                if (r.PaidAtUtc >= start && r.PaidAtUtc < end)
                {
                    flows.Add(new Flow(FinanceTime.LocalDay(r.PaidAtUtc), r.Kind, r.Method, r.DoctorName, r.Amount, false));
                }

                if (r.RefundedAtUtc is { } refundedAt && refundedAt >= start && refundedAt < end && r.RefundedAmount > 0)
                {
                    flows.Add(new Flow(FinanceTime.LocalDay(refundedAt), r.Kind, r.Method, r.DoctorName, r.RefundedAmount, true));
                }
            }

            return flows;
        }

        private static IncomeBreakdownDto Break(IEnumerable<Flow> source)
        {
            var flows = source as IReadOnlyCollection<Flow> ?? source.ToList();
            var sales = flows.Where(f => !f.IsRefund).ToList();
            var examinations = sales.Where(f => f.Kind == "examination").ToList();
            var visits = sales.Where(f => f.Kind == "visit").ToList();

            var collected = sales.Sum(f => f.Amount);
            var refunded = flows.Where(f => f.IsRefund).Sum(f => f.Amount);

            return new IncomeBreakdownDto(
                examinations.Count, examinations.Sum(f => f.Amount),
                visits.Count, visits.Sum(f => f.Amount),
                sales.Count(f => f.Kind == "free"),
                collected, refunded, collected - refunded);
        }

        private static List<MethodTotalDto> ByMethod(IEnumerable<Flow> flows) =>
            flows
                .GroupBy(f => f.Method)
                .Select(g =>
                {
                    var collected = g.Where(f => !f.IsRefund).Sum(f => f.Amount);
                    var refunded = g.Where(f => f.IsRefund).Sum(f => f.Amount);
                    return new MethodTotalDto(g.Key, collected, refunded, collected - refunded);
                })
                .OrderByDescending(m => m.Net)
                .ToList();
    }
}