using System.ComponentModel.DataAnnotations;

namespace Clinic.Api.DTOs.AppointmentDto
{
    public class CreateAppointmentDto
    {
        [Range(1, int.MaxValue, ErrorMessage = "PatientId is required.")]
        public int PatientId { get; set; }

        [Range(1, int.MaxValue, ErrorMessage = "DoctorId is required.")]
        public int DoctorId { get; set; }

        /// <summary>
        /// When the appointment starts, including the clinic device's local offset.
        /// The interval booked is [AppointmentDate, +Duration).
        /// </summary>
        [Required]
        public DateTimeOffset AppointmentDate { get; set; }

        /// <summary>
        /// How long the appointment runs, in minutes.
        ///
        /// Without a duration there is no interval, and without an interval there is no way to
        /// detect that two appointments collide - which is why the old exact-equality check let a
        /// doctor be booked twice one minute apart.
        /// </summary>
        [Range(AppointmentDurations.MinimumMinutes, AppointmentDurations.MaximumMinutes)]
        public int DurationMinutes { get; set; } = AppointmentDurations.DefaultMinutes;

        /// <summary>Reason for the visit. Optional.</summary>
        [MaxLength(AppointmentDurations.NotesMaxLength)]
        public string? Notes { get; set; }

        // Status is deliberately absent. A new booking is always Pending; letting the caller choose
        // would allow a client to create an appointment that is already "Completed".
    }

    /// <summary>Shared so the create and update contracts cannot drift apart.</summary>
    public static class AppointmentDurations
    {
        public const int MinimumMinutes = 5;
        public const int MaximumMinutes = 240;
        public const int DefaultMinutes = 30;
        public const int NotesMaxLength = 1000;
    }
}
