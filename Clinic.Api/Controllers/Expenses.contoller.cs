// Place in your API project (Controllers folder). The former ExpenseService now lives here, so there
// is no service to register.
//
// Tenant handling is entirely ClinicDbContext's job, so nothing below mentions it:
//   - reads: the query filter on ITenantEntity limits every query to the caller's clinic
//     (so Update/Delete by id cannot reach another clinic's rows)
//   - inserts: StampTenantId assigns TenantId on SaveChanges
//   - audit columns and RowVersion: StampAuditColumns

using Clinic.Domain.Entites;
using Clinic.Infrastructure.Data.Context;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
// DTOs from ExpenseDtos.cs - adjust this using to the namespace you put that file in.

using Application.DTOs.Expenses;
 

namespace Clinic.API.Controllers
{
    [ApiController]
    [Authorize]
    [Route("api/expenses")]
    public class ExpensesController : ControllerBase
    {
        private static readonly HashSet<string> Categories = new()
        {
            "rent", "electricity", "water", "internet", "salaries",
            "transport", "maintenance", "marketing", "taxes", "supplies", "other"
        };
        private static readonly HashSet<string> Methods = new() { "cash", "bank", "wallet" };

        private readonly ClinicDbContext _db;

        public ExpensesController(ClinicDbContext db) => _db = db;

        // GET api/expenses?page=1&pageSize=10&search=&category=&from=&to=
        [HttpGet]
        public async Task<ActionResult<ExpensePage<ExpenseDto>>> List([FromQuery] ExpenseQueryDto q, CancellationToken ct)
        {
            var page = Math.Max(1, q.Page);
            var size = Math.Clamp(q.PageSize, 1, 100);

            var query = _db.Expenses.AsNoTracking().AsQueryable();

            if (!string.IsNullOrWhiteSpace(q.Search))
            {
                var s = q.Search.Trim().ToLower();
                query = query.Where(e => e.Title.ToLower().Contains(s) ||
                                         (e.Notes != null && e.Notes.ToLower().Contains(s)));
            }
            if (!string.IsNullOrWhiteSpace(q.Category))
                query = query.Where(e => e.Category == q.Category);
            if (q.From.HasValue)
                query = query.Where(e => e.ExpenseDate >= q.From.Value);
            if (q.To.HasValue)
                query = query.Where(e => e.ExpenseDate <= q.To.Value);

            var total = await query.CountAsync(ct);
            var items = await query
                .OrderByDescending(e => e.ExpenseDate).ThenByDescending(e => e.Id)
                .Skip((page - 1) * size).Take(size)
                .Select(e => new ExpenseDto(e.Id, e.Title, e.Category, e.Amount, e.ExpenseDate,
                                            e.PaymentMethod, e.IsRecurring, e.Notes))
                .ToListAsync(ct);

            return Ok(new ExpensePage<ExpenseDto> { Items = items, TotalCount = total, Page = page, PageSize = size });
        }

        // GET api/expenses/summary
        [HttpGet("summary")]
        public async Task<ActionResult<ExpenseSummaryDto>> Summary(CancellationToken ct)
        {
            // Egypt local "today" so the month boundary matches what the user sees.
            var tz = TimeZoneInfo.FindSystemTimeZoneById(OperatingSystem.IsWindows() ? "Egypt Standard Time" : "Africa/Cairo");
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));

            var monthStart = new DateOnly(today.Year, today.Month, 1);
            var nextMonth = monthStart.AddMonths(1);
            var prevStart = monthStart.AddMonths(-1);
            var yearStart = new DateOnly(today.Year, 1, 1);

            var q = _db.Expenses.AsNoTracking();

            var monthTotal = await q.Where(e => e.ExpenseDate >= monthStart && e.ExpenseDate < nextMonth)
                                    .SumAsync(e => (decimal?)e.Amount, ct) ?? 0;
            var monthCount = await q.CountAsync(e => e.ExpenseDate >= monthStart && e.ExpenseDate < nextMonth, ct);
            var prevTotal = await q.Where(e => e.ExpenseDate >= prevStart && e.ExpenseDate < monthStart)
                                   .SumAsync(e => (decimal?)e.Amount, ct) ?? 0;
            var yearTotal = await q.Where(e => e.ExpenseDate >= yearStart && e.ExpenseDate < yearStart.AddYears(1))
                                   .SumAsync(e => (decimal?)e.Amount, ct) ?? 0;

            var byCat = await q.Where(e => e.ExpenseDate >= monthStart && e.ExpenseDate < nextMonth)
                               .GroupBy(e => e.Category)
                               .Select(g => new CategoryTotalDto(g.Key, g.Sum(x => x.Amount)))
                               .ToListAsync(ct);

            return Ok(new ExpenseSummaryDto(monthTotal, prevTotal, monthCount, yearTotal, byCat));
        }

        // POST api/expenses
        [HttpPost]
        public async Task<ActionResult<ExpenseDto>> Create([FromBody] ExpenseInputDto input, CancellationToken ct)
        {
            var e = new Expense();
            Apply(e, input);
            _db.Expenses.Add(e);
            await _db.SaveChangesAsync(ct);
            return Ok(ToDto(e));
        }

        // PUT api/expenses/{id}
        [HttpPut("{id:int}")]
        public async Task<ActionResult<ExpenseDto>> Update(int id, [FromBody] ExpenseInputDto input, CancellationToken ct)
        {
            var e = await _db.Expenses.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (e is null) return NotFound(new { message = "المصروف غير موجود" });

            Apply(e, input);
            await _db.SaveChangesAsync(ct);
            return Ok(ToDto(e));
        }

        // DELETE api/expenses/{id}
        [HttpDelete("{id:int}")]
        public async Task<IActionResult> Delete(int id, CancellationToken ct)
        {
            var e = await _db.Expenses.FirstOrDefaultAsync(x => x.Id == id, ct);
            if (e is null) return NotFound(new { message = "المصروف غير موجود" });

            _db.Expenses.Remove(e);
            await _db.SaveChangesAsync(ct);
            return NoContent();
        }

        private static void Apply(Expense e, ExpenseInputDto i)
        {
            e.Title = i.Title.Trim();
            e.Category = Categories.Contains(i.Category) ? i.Category : "other";
            e.Amount = decimal.Round(i.Amount, 2);
            e.ExpenseDate = i.ExpenseDate;
            e.PaymentMethod = Methods.Contains(i.PaymentMethod) ? i.PaymentMethod : "cash";
            e.IsRecurring = i.IsRecurring;
            e.Notes = string.IsNullOrWhiteSpace(i.Notes) ? null : i.Notes.Trim();
        }

        private static ExpenseDto ToDto(Expense e) =>
            new(e.Id, e.Title, e.Category, e.Amount, e.ExpenseDate, e.PaymentMethod, e.IsRecurring, e.Notes);
    }
}