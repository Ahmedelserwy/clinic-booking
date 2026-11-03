using Clinic.Domain.Entites;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Clinic.Infrastructure.Data.Config
{
    // Picked up by ApplyConfigurationsFromAssembly in ClinicDbContext - nothing to register.
    // Both declare an index that LEADS with TenantId, so ConfigureTenantLinks does not add a
    // second, redundant one.

    public class PaymentConfig : IEntityTypeConfiguration<Payment>
    {
        public void Configure(EntityTypeBuilder<Payment> b)
        {
            b.Property(p => p.PatientName).HasMaxLength(120).IsRequired();
            b.Property(p => p.DoctorName).HasMaxLength(120);
            b.Property(p => p.Kind).HasMaxLength(20).IsRequired();
            b.Property(p => p.Method).HasMaxLength(20).IsRequired();
            b.Property(p => p.ReceivedBy).HasMaxLength(200);
            b.Property(p => p.Notes).HasMaxLength(300);
            b.Property(p => p.RefundReason).HasMaxLength(300);
            b.Property(p => p.Amount).HasPrecision(18, 2);
            b.Property(p => p.RefundedAmount).HasPrecision(18, 2);

            // Pay-first: one payment per appointment, enforced by the database so two receptionists
            // clicking at once cannot both collect.
            b.HasIndex(p => p.AppointmentId).IsUnique();
            b.HasIndex(p => new { p.TenantId, p.PaidAtUtc });
        }
    }

    public class DailyClosingConfig : IEntityTypeConfiguration<DailyClosing>
    {
        public void Configure(EntityTypeBuilder<DailyClosing> b)
        {
            b.Property(c => c.OpeningCash).HasPrecision(18, 2);
            b.Property(c => c.ExpectedCash).HasPrecision(18, 2);
            b.Property(c => c.CountedCash).HasPrecision(18, 2);
            b.Property(c => c.Difference).HasPrecision(18, 2);
            b.Property(c => c.Notes).HasMaxLength(500);
            b.Property(c => c.ClosedBy).HasMaxLength(200);

            b.HasIndex(c => new { c.TenantId, c.Date }).IsUnique();
        }
    }
}