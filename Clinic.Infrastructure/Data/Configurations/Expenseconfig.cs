// Place in Clinic.Infrastructure next to your other *Config classes.
// ClinicDbContext picks it up through ApplyConfigurationsFromAssembly - nothing to register.
//
// The composite index leads with TenantId, so ConfigureTenantLinks sees it and does not add a
// second standalone TenantId index.

using Clinic.Domain.Entites;

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Clinic.Infrastructure.Data.Configurations
{
    public class ExpenseConfig : IEntityTypeConfiguration<Expense>
    {
        public void Configure(EntityTypeBuilder<Expense> builder)
        {
            builder.Property(x => x.Title).HasMaxLength(120).IsRequired();
            builder.Property(x => x.Category).HasMaxLength(30).IsRequired();
            builder.Property(x => x.PaymentMethod).HasMaxLength(20).IsRequired();
            builder.Property(x => x.Amount).HasPrecision(18, 2);
            builder.Property(x => x.Notes).HasMaxLength(500);

            builder.HasIndex(x => new { x.TenantId, x.ExpenseDate });
        }
    }
}