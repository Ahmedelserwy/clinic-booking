using Clinic.Domain.Interfaces;

namespace Clinic.Domain.Entites
{
    /// <summary>
    /// Money received at the desk for one appointment.
    ///
    /// The clinic is pay-first: nobody is examined until the fee is paid, so there is exactly one
    /// payment per appointment (enforced by a unique index) and no balances, partial payments or
    /// invoices to chase.
    ///
    /// Patient and doctor NAMES are copied onto the row on purpose. A financial record has to keep
    /// reading the same after a patient is deleted or a doctor is renamed.
    /// </summary>
    public class Payment : BaseEntity, ITenantEntity
    {
        public int TenantId { get; set; }

        public int AppointmentId { get; set; }
        public int? PatientId { get; set; }
        public string PatientName { get; set; } = string.Empty;
        public int? DoctorId { get; set; }
        public string DoctorName { get; set; } = string.Empty;

        /// <summary>examination (first visit, full fee) | visit (follow-up, cheaper) | free (waived)</summary>
        public string Kind { get; set; } = "examination";

        /// <summary>What was actually charged. 0 only for a free visit.</summary>
        public decimal Amount { get; set; }

        /// <summary>cash | card | wallet | bank</summary>
        public string Method { get; set; } = "cash";

        /// <summary>Set by the server when the payment is recorded - never taken from the client.</summary>
        public DateTime PaidAtUtc { get; set; }

        /// <summary>The signed-in user who took the money.</summary>
        public string ReceivedBy { get; set; } = string.Empty;

        public string? Notes { get; set; }

        // A payment can be refunded once, in full or in part. A single date column is enough
        // because a second refund is refused - see PaymentsController.Refund.
        public decimal RefundedAmount { get; set; }
        public DateTime? RefundedAtUtc { get; set; }
        public string? RefundReason { get; set; }
    }


    /// <summary>
    /// The end-of-day cash count (تقفيل اليومية). One row per clinic per day.
    /// ExpectedCash is a snapshot of what the system calculated when the day was closed;
    /// CountedCash is what was really in the drawer.
    /// </summary>
    public class DailyClosing : BaseEntity, ITenantEntity
    {
        public int TenantId { get; set; }

        public DateOnly Date { get; set; }
        public decimal OpeningCash { get; set; }
        public decimal ExpectedCash { get; set; }
        public decimal CountedCash { get; set; }

        /// <summary>CountedCash - ExpectedCash. Negative = money missing.</summary>
        public decimal Difference { get; set; }

        public string? Notes { get; set; }
        public string ClosedBy { get; set; } = string.Empty;
        public DateTime ClosedAtUtc { get; set; }
    }
}