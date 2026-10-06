using FluentValidation;

namespace Clinic.Api.DTOs.AppointmentDto.Validators
{
    public class CreateAppointmentDtoValidator : AbstractValidator<CreateAppointmentDto>
    {
        public CreateAppointmentDtoValidator()
        {
            RuleFor(x => x.PatientId)
                .NotEmpty().WithMessage("PatientId is required.")
                .GreaterThan(0).WithMessage("PatientId must be greater than 0.");
            RuleFor(x => x.DoctorId)
                .NotEmpty().WithMessage("DoctorId is required.")
                .GreaterThan(0).WithMessage("DoctorId must be greater than 0.");
            RuleFor(x => x.AppointmentDate)
                .NotEmpty().WithMessage("AppointmentDate is required.")
                .Must(BeAValidDate).WithMessage("AppointmentDate must be a valid date.");
            

        }
        private bool BeAValidDate(DateTimeOffset date)
        {
            return date > DateTimeOffset.MinValue;
        }
    }   
}
