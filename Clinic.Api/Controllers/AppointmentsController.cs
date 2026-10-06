using AutoMapper;
using Clinic.Api.DTOs.AppointmentDto;
using Clinic.Api.Helper;
using Clinic.Api.Logging;
using Clinic.Domain.Entites;
using Clinic.Domain.Entites.Identity;
using Clinic.Domain.Interfaces;
using Clinic.Domain.Interfaces.Specifications.AppointmentSpec;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Npgsql;
using Microsoft.EntityFrameworkCore;

namespace Clinic.Api.Controllers
{

    // Every action here reads or writes protected health information.
    [AuditPhiAccess("Appointment")]
    public class AppointmentsController : APIBaseController
    {
        private readonly IMapper _mapper;
        private readonly IAppointmentRepository _appointmentRepository;
        private readonly IUnitOfWork _unitOfWork;

        public AppointmentsController(
             IMapper mapper
            , IAppointmentRepository appointmentRepository
            , IUnitOfWork unitOfWork)
        {
            _appointmentRepository = appointmentRepository;
            _unitOfWork = unitOfWork;
            _mapper = mapper;
            _appointmentRepository = appointmentRepository;
        }

        [HttpPost]
        public async Task<ActionResult> Create(CreateAppointmentDto dto)
        {

            var doctor = await _unitOfWork.Repository<Doctor>().GetByIdAsync(dto.DoctorId);
            if (doctor == null)
                return NotFound($"Doctor with id {dto.DoctorId} not found.");
            var patient = await _unitOfWork.Repository<Patient>().GetByIdAsync(dto.PatientId);
            if (patient == null)
                return NotFound($"Patient with id {dto.PatientId} not found.");
            var slot = Slot.From(dto.AppointmentDate, dto.DurationMinutes);

            var rejection = await CheckSlotAsync(dto.DoctorId, slot, excludeAppointmentId: null);
            if (rejection is not null) return rejection;

            var mappedAppointment = _mapper.Map<Appointment>(dto); // Map the DTO to the Appointment entity
            slot.ApplyTo(mappedAppointment);
            await _appointmentRepository.AddAsync(mappedAppointment);

            try
            {
                await _unitOfWork.CompleteAsync(); // commit before mapping so the generated Id is populated
            }
            catch (DbUpdateException ex) when (IsDuplicateBooking(ex))
            {
                return SlotTaken();
            }

            var result = _mapper.Map<AppointmentDto>(mappedAppointment); // Map the saved Appointment entity to the AppointmentDto
            return Ok(result);
        }

        // Delete an appointment by id
        [Authorize(Roles = $"{ClinicRoles.Admin},{ClinicRoles.Doctor}")]
        [HttpDelete("{id}")]
        public async Task<ActionResult> Delete(int id)
        {
            var appointment = await _appointmentRepository.GetByIdAsync(id);
            if (appointment == null)
                return NotFound($"Appointment with id {id} not found.");
            await _appointmentRepository.DeleteAsync(appointment);
            await _unitOfWork.CompleteAsync();
            return NoContent();
        }
        // Update an existing appointment
        [Authorize(Roles = $"{ClinicRoles.Admin},{ClinicRoles.Doctor}")]
        [HttpPut("{id}")]
        public async Task<ActionResult> Update(int id, UpdateAppointmentDto dto)
        {
            var appointment = await _appointmentRepository.GetByIdAsync(id);
            if (appointment == null)
                return NotFound($"Appointment with id {id} not found.");
            var doctor = await _unitOfWork.Repository<Doctor>().GetByIdAsync(dto.DoctorId);
            if (doctor == null)
                return NotFound($"Doctor with id {dto.DoctorId} not found.");
            var patient = await _unitOfWork.Repository<Patient>().GetByIdAsync(dto.PatientId);
            if (patient == null)
                return NotFound($"Patient with id {dto.PatientId} not found.");
            var slot = Slot.From(dto.AppointmentDate, dto.DurationMinutes);

            // The appointment being moved must not collide with itself.
            var rejection = await CheckSlotAsync(dto.DoctorId, slot, excludeAppointmentId: id);
            if (rejection is not null) return rejection;

            _mapper.Map(dto, appointment);
            slot.ApplyTo(appointment);
            await _appointmentRepository.UpdateAsync(appointment);

            try
            {
                await _unitOfWork.CompleteAsync();
            }
            catch (DbUpdateException ex) when (IsDuplicateBooking(ex))
            {
                return SlotTaken();
            }

            var result = _mapper.Map<AppointmentDto>(appointment);
            return Ok(result);
        }

        #region Booking rules

        /// <summary>The local schedule interval and its absolute UTC interval.</summary>
        private readonly record struct Slot(DateTimeOffset LocalStartsAt, DateTimeOffset LocalEndsAt)
        {
            public DateTime StartsAtUtc => LocalStartsAt.UtcDateTime;
            public DateTime EndsAtUtc => LocalEndsAt.UtcDateTime;

            public static Slot From(DateTimeOffset startsAt, int durationMinutes) =>
                new(startsAt, startsAt.AddMinutes(durationMinutes));

            /// <summary>
            /// AppointmentDate is the start instant; StartTime mirrors it and EndTime closes the
            /// interval. Collapsing these three columns into one time range is TODO #44 - until
            /// then EndTime must be populated or the overlap query cannot see the appointment.
            /// </summary>
            public void ApplyTo(Appointment appointment)
            {
                appointment.AppointmentDate = StartsAtUtc;
                appointment.StartTime = StartsAtUtc;
                appointment.EndTime = EndsAtUtc;
            }
        }

        /// <summary>
        /// Returns a rejection response, or null when the slot may be booked.
        ///
        /// Two rules, both previously absent: the appointment has to sit inside the doctor's
        /// published working hours, and it must not overlap an existing appointment. The old check
        /// compared AppointmentDate for exact equality and consulted DoctorSchedule not at all.
        /// </summary>
        private async Task<ActionResult?> CheckSlotAsync(int doctorId, Slot slot, int? excludeAppointmentId)
        {
            if (!await _appointmentRepository.IsWithinWorkingHoursAsync(
                    doctorId, slot.LocalStartsAt.DateTime, slot.LocalEndsAt.DateTime))
            {
                return BadRequest(new ProblemDetails
                {
                    Status = StatusCodes.Status400BadRequest,
                    Title = "The requested time is outside the doctor's published working hours."
                });
            }

            if (await _appointmentRepository.HasOverlappingAppointmentAsync(
                    doctorId, slot.StartsAtUtc, slot.EndsAtUtc, excludeAppointmentId))
            {
                return SlotTaken();
            }

            return null;
        }

        private ConflictObjectResult SlotTaken() => Conflict(new ProblemDetails
        {
            Status = StatusCodes.Status409Conflict,
            Title = "That slot has just been taken. Please choose another time."
        });

        /// <summary>
        /// A unique-index violation from UX_Appointments_DoctorId_AppointmentDate.
        ///
        /// 2601 is "duplicate key row in object with unique index", 2627 is "violation of unique
        /// constraint". Either means a concurrent request won the race between our overlap check and
        /// our insert, which is a 409 for the caller and not a server fault.
        /// </summary>
        private static bool IsDuplicateBooking(DbUpdateException exception) =>
            exception.InnerException is PostgresException { SqlState: "23505" };

        #endregion
        #region GetTypes
        // Get all appointments
        [HttpGet]
        // [FromQuery] is mandatory here. APIBaseController carries [ApiController], whose binding
        // source inference treats an unannotated complex parameter as [FromBody] - and a GET request
        // has no body, so every call returned 415 Unsupported Media Type.
        public async Task<ActionResult<Pagination<AppointmentDto>>> GetAllAppointments([FromQuery] AppointmentSpecParams param)
        {
            var spec = new AppointmentSpecification(param);
            var appointments = await _appointmentRepository.GetAllWithSpecAsync(spec);

            // An empty page is a successful result, not a missing resource - see DoctorsController.

            var TotalCounts = new AppointmentWithCountSpecification(param);
            var count = await _appointmentRepository.CountAsync(TotalCounts);
            var result = _mapper.Map<IReadOnlyList<AppointmentDto>>(appointments);

            return Ok(new Pagination<AppointmentDto>(param.PageIndex, param.PageSize, count, result));
        }
        // Get an appointment by id
        [HttpGet("{id}")]
        public async Task<ActionResult<AppointmentDto>> GetById(int id)
        {
            var spec = new AppointmentWithDoctorAndPatientSpec(id);
            var appointment = await _appointmentRepository.GetEntityWithSpec(spec);
            if (appointment == null)
                return NotFound($"Appointment with id {id} not found.");
            var result = _mapper.Map<Appointment, AppointmentDto>(appointment);
            return Ok(result);
        }
        // Get an appointment by DoctorName
        [HttpGet("doctor/{doctorName}")]
        public async Task<ActionResult<IReadOnlyList<AppointmentDto>>> GetByDoctorName(string doctorName)
        {
            var spec = new AppointmentWithDoctorNameSpec(doctorName);
            var appointment = await _appointmentRepository.ListAsync(spec);
            var result = _mapper.Map<IReadOnlyList<Appointment>, IReadOnlyList<AppointmentDto>>(appointment);
            return Ok(result);
        }
        // Get an appointment by PatientName
        // The template was "patient{patientName}" - no separator - so the route matched
        // /api/appointments/patientSara instead of /api/appointments/patient/Sara.
        [HttpGet("patient/{patientName}")]
        public async Task<ActionResult<IReadOnlyList<AppointmentDto>>> GetByPatientName(string patientName)
        {
            var spec = new AppointmentWithPatientNameSpec(patientName);
            var appointment = await _appointmentRepository.ListAsync(spec);

            // No 404 for "this patient has no appointments" - that is a true and useful answer, and
            // it now matches GetByDoctorName above, which always returned 200. The old 404 also
            // leaked information: it distinguished "no appointments" from "no such patient" only by
            // accident, and its message echoed the searched-for name back to the caller.

            // ListAsync returns a collection, so the destination must be a collection too. Mapping it
            // to a single AppointmentDto threw AutoMapperMappingException and contradicted the
            // declared IReadOnlyList<AppointmentDto> return type. Same form as GetByDoctorName above.
            var result = _mapper.Map<IReadOnlyList<Appointment>, IReadOnlyList<AppointmentDto>>(appointment);
            return Ok(result);
        }
        #endregion

    }
}
