using Clinic.Domain.Entites;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

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
        ///
        /// Read from its name ("Confirmed"), which is the form the client holds: AppointmentDto
        /// sends the status as a string, and the client sends it back unchanged when it
        /// reschedules. Without this converter the name could not bind to the enum and every
        /// reschedule failed with a 400.
        /// </summary>
        [JsonConverter(typeof(JsonStringEnumConverter))]
        public AppointmentStatus? Status { get; set; }

        [MaxLength(AppointmentDurations.NotesMaxLength)]
        public string? Notes { get; set; }
    }
}