// Place in Clinic.Domain/Entites (next to Patient, Doctor...).
// Id, CreatedAtUtc, CreatedBy, ModifiedAtUtc, ModifiedBy and RowVersion come from BaseEntity and are
// stamped by ClinicDbContext. TenantId is stamped on insert and filtered on read by the same context.

using Clinic.Domain.Interfaces;

namespace Clinic.Domain.Entites
{
    public class Expense : BaseEntity, ITenantEntity
    {
        public int TenantId { get; set; }

        public string Title { get; set; } = string.Empty;

        /// <summary>rent | electricity | water | internet | salaries | transport | maintenance | marketing | taxes | supplies | other</summary>
        public string Category { get; set; } = "other";

        public decimal Amount { get; set; }

        public DateOnly ExpenseDate { get; set; }

        /// <summary>cash | bank | wallet</summary>
        public string PaymentMethod { get; set; } = "cash";

        public bool IsRecurring { get; set; }

        public string? Notes { get; set; }
    }
}