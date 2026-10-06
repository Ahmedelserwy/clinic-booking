using Clinic.Domain.Entites;
using System.ComponentModel.DataAnnotations;

namespace Clinic.Api.DTOs.AppointmentDto
{
    public class UpdateAppointmentDto
    {
        [Range(1, int.MaxValue, ErrorMessage = "DoctorId is required.")]
        public int DoctorId { get; set; }

        [Range(1, int.MaxValue, ErrorMessage = "PatientId is required.")]
        public int PatientId { get; set; }

        [Required]
        public DateTimeOffset AppointmentDate { get; set; }

        [Range(AppointmentDurations.MinimumMinutes, AppointmentDurations.MaximumMinutes)]
        public int DurationMinutes { get; set; } = AppointmentDurations.DefaultMinutes;

        /// <summary>
        /// Where the booking now sits in its lifecycle. Optional: an update that only reschedules
        /// leaves it null and the stored status is kept, so a reschedule cannot silently revert a
        /// confirmed appointment to Pending.
        /// </summary>
        public AppointmentStatus? Status { get; set; }

        [MaxLength(AppointmentDurations.NotesMaxLength)]
        public string? Notes { get; set; }
    }
}
