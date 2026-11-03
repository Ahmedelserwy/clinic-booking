using System.ComponentModel.DataAnnotations;

namespace Clinic.Api.DTOs.AppointmentDto
{
    public class UpdateAppointmentStatusDto
    {
        [Required(AllowEmptyStrings = false)]
        public string Status { get; set; } = string.Empty;
    }
}