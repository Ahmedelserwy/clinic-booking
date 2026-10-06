using AutoMapper;
using Clinic.Api.DTOs.AppointmentDto;
using Clinic.Api.DTOs.DoctorDto;
using Clinic.Api.DTOs.PatientDto;
using Clinic.Api.DTOs.ScheduleDto;
using Clinic.Api.Helper;
using Clinic.Domain.Entites;
using Microsoft.Extensions.Logging.Abstractions;

namespace Clinic.Tests.Mapping
{
    /// <summary>
    /// Behaviour tests for TODO #4 (finding C4).
    ///
    /// AssertConfigurationIsValid only proves every destination member is accounted for. These tests
    /// prove the maps actually produce the right values - and that the removed ReverseMap() calls
    /// stay removed.
    /// </summary>
    public sealed class MappingProfileTests
    {
        private static readonly MapperConfiguration Configuration =
            new(cfg => cfg.AddProfile<MappingProfile>(), NullLoggerFactory.Instance);

        private static readonly IMapper Mapper = Configuration.CreateMapper();

        private static Doctor NewDoctor(int id = 1) =>
            new() { Id = id, Name = "Dr. Aya", Specialization = "Cardiology" };

        private static Patient NewPatient(int id = 2) =>
            new() { Id = id, Name = "Sara", Phone = "01000000000", Gender = "Female",
                    DateOfBirth = new DateTime(1995, 4, 12) };

        [Fact]
        public void Configuration_Is_Valid()
            => Configuration.AssertConfigurationIsValid();

        #region Appointment -> AppointmentDto (the map that did not exist)

        [Fact]
        public void Appointment_Maps_To_AppointmentDto_Flattening_Doctor_And_Patient_Names()
        {
            var appointment = new Appointment
            {
                Id = 7,
                DoctorId = 1,
                PatientId = 2,
                Doctor = NewDoctor(),
                Patient = NewPatient(),
                AppointmentDate = new DateTime(2026, 8, 3, 10, 0, 0)
            };

            var dto = Mapper.Map<AppointmentDto>(appointment);

            Assert.Equal(7, dto.Id);
            Assert.Equal("Dr. Aya", dto.DoctorName);
            Assert.Equal("Sara", dto.PatientName);
            Assert.Equal(new DateTime(2026, 8, 3, 10, 0, 0), dto.AppointmentDate);
        }

        [Fact]
        public void Appointment_With_Unloaded_Navigations_Maps_Without_Throwing()
        {
            // A spec that forgets its Includes must not turn into a 500. AutoMapper null-checks the
            // source member chain, so the names come back null instead.
            var appointment = new Appointment { Id = 7, DoctorId = 1, PatientId = 2 };

            var dto = Mapper.Map<AppointmentDto>(appointment);

            Assert.Equal(7, dto.Id);
            Assert.Null(dto.DoctorName);
            Assert.Null(dto.PatientName);
        }

        [Fact]
        public void Appointment_Collection_Maps_To_Dto_Collection()
        {
            IReadOnlyList<Appointment> appointments =
            [
                new() { Id = 1, Doctor = NewDoctor(), Patient = NewPatient() },
                new() { Id = 2, Doctor = NewDoctor(), Patient = NewPatient() }
            ];

            var dtos = Mapper.Map<IReadOnlyList<AppointmentDto>>(appointments);

            Assert.Equal(2, dtos.Count);
            Assert.All(dtos, d => Assert.Equal("Dr. Aya", d.DoctorName));
        }

        [Fact]
        public void CreateAppointmentDto_Does_Not_Set_Key_Navigations_Or_Times()
        {
            var dto = new CreateAppointmentDto
            {
                DoctorId = 1,
                PatientId = 2,
                AppointmentDate = new DateTimeOffset(2026, 8, 3, 10, 0, 0, TimeSpan.FromHours(3))
            };

            var appointment = Mapper.Map<Appointment>(dto);

            Assert.Equal(0, appointment.Id);              // key is the database's to assign
            Assert.Null(appointment.Doctor);
            Assert.Null(appointment.Patient);
            Assert.Equal(1, appointment.DoctorId);
            Assert.Equal(2, appointment.PatientId);
            Assert.Equal(
                new DateTime(2026, 8, 3, 7, 0, 0, DateTimeKind.Utc),
                appointment.AppointmentDate);
        }

        [Fact]
        public void UpdateAppointmentDto_Onto_Existing_Entity_Preserves_Key_And_Navigations()
        {
            var existing = new Appointment
            {
                Id = 7,
                DoctorId = 1,
                PatientId = 2,
                Doctor = NewDoctor(),
                Patient = NewPatient(),
                AppointmentDate = new DateTime(2026, 8, 3, 10, 0, 0)
            };

            Mapper.Map(new UpdateAppointmentDto
            {
                DoctorId = 3,
                PatientId = 4,
                AppointmentDate = new DateTimeOffset(2026, 9, 1, 9, 0, 0, TimeSpan.FromHours(3))
            }, existing);

            Assert.Equal(7, existing.Id);                 // route id stays authoritative
            Assert.NotNull(existing.Doctor);              // tracked graph not wiped
            Assert.NotNull(existing.Patient);
            Assert.Equal(3, existing.DoctorId);
            Assert.Equal(4, existing.PatientId);
            Assert.Equal(
                new DateTime(2026, 9, 1, 6, 0, 0, DateTimeKind.Utc),
                existing.AppointmentDate);
        }

        #endregion

        #region Schedule: DayOfWeek <-> WeekDay and TimeSpan <-> TimeOnly

        [Fact]
        public void DoctorSchedule_Maps_DayOfWeek_To_WeekDay_And_TimeSpan_To_TimeOnly()
        {
            var schedule = new DoctorSchedule
            {
                Id = 5,
                DoctorId = 1,
                Doctor = NewDoctor(),
                DayOfWeek = WeekDay.Wednesday,
                StartTime = new TimeSpan(9, 30, 0),
                EndTime = new TimeSpan(17, 0, 0)
            };

            var dto = Mapper.Map<DoctorScheduleDto>(schedule);

            Assert.Equal(5, dto.Id);
            Assert.Equal(1, dto.DoctorId);
            Assert.Equal("Dr. Aya", dto.DoctorName);
            Assert.Equal(WeekDay.Wednesday, dto.WeekDay);          // was silently unmapped
            Assert.Equal(new TimeOnly(9, 30), dto.StartTime);      // TimeSpan -> TimeOnly
            Assert.Equal(new TimeOnly(17, 0), dto.EndTime);
        }

        [Fact]
        public void CreateDoctorScheduleDto_Maps_WeekDay_To_DayOfWeek_And_TimeOnly_To_TimeSpan()
        {
            var dto = new CreateDoctorScheduleDto
            {
                DoctorId = 1,
                WeekDay = WeekDay.Monday,
                StartTime = new TimeOnly(8, 0),
                EndTime = new TimeOnly(14, 15)
            };

            var schedule = Mapper.Map<DoctorSchedule>(dto);

            Assert.Equal(0, schedule.Id);
            Assert.Null(schedule.Doctor);
            Assert.Equal(1, schedule.DoctorId);
            Assert.Equal(WeekDay.Monday, schedule.DayOfWeek);
            Assert.Equal(new TimeSpan(8, 0, 0), schedule.StartTime);
            Assert.Equal(new TimeSpan(14, 15, 0), schedule.EndTime);
        }

        [Fact]
        public void UpdateDoctorScheduleDto_Cannot_Reassign_The_Schedule_To_Another_Doctor()
        {
            var existing = new DoctorSchedule
            {
                Id = 5,
                DoctorId = 1,
                Doctor = NewDoctor(),
                DayOfWeek = WeekDay.Monday,
                StartTime = new TimeSpan(8, 0, 0),
                EndTime = new TimeSpan(14, 0, 0)
            };

            Mapper.Map(new UpdateDoctorScheduleDto
            {
                WeekDay = WeekDay.Friday,
                StartTime = new TimeOnly(10, 0),
                EndTime = new TimeOnly(16, 0)
            }, existing);

            Assert.Equal(5, existing.Id);
            Assert.Equal(1, existing.DoctorId);            // untouched
            Assert.NotNull(existing.Doctor);
            Assert.Equal(WeekDay.Friday, existing.DayOfWeek);
            Assert.Equal(new TimeSpan(10, 0, 0), existing.StartTime);
        }

        [Fact]
        public void TimeSpan_And_TimeOnly_Round_Trip()
        {
            var original = new TimeSpan(13, 45, 30);

            var asTimeOnly = Mapper.Map<TimeOnly>(original);
            var back = Mapper.Map<TimeSpan>(asTimeOnly);

            Assert.Equal(new TimeOnly(13, 45, 30), asTimeOnly);
            Assert.Equal(original, back);
        }

        #endregion

        #region Doctor and Patient

        [Fact]
        public void Doctor_Maps_To_Response_Dtos()
        {
            var doctor = NewDoctor(9);

            var getDto = Mapper.Map<GetDoctorDto>(doctor);
            var dto = Mapper.Map<DoctorDto>(doctor);

            Assert.Equal(9, getDto.Id);
            Assert.Equal("Dr. Aya", getDto.Name);
            Assert.Equal("Cardiology", dto.Specialization);
        }

        [Fact]
        public void CreateDoctorDto_Does_Not_Set_The_Key_Or_Collections()
        {
            // The DTO no longer exposes an Id - that was TODO #35, now done. The map still ignores
            // the key explicitly, because a mapped key would make EF attempt an explicit identity
            // insert and fail.
            var dto = new CreateDoctorDto { Name = "Dr. Omar", Specialization = "Neurology" };

            var doctor = Mapper.Map<Doctor>(dto);

            Assert.Equal(0, doctor.Id);
            Assert.Empty(doctor.Appointments);
            Assert.Empty(doctor.DoctorSchedules);
            Assert.Equal("Dr. Omar", doctor.Name);
        }

        [Fact]
        public void UpdateDoctorDto_Onto_Existing_Entity_Preserves_Key_And_Collections()
        {
            var existing = NewDoctor(4);
            existing.Appointments.Add(new Appointment { Id = 1 });

            Mapper.Map(new UpdateDoctorDto { Id = 999, Name = "Dr. Aya Hassan", Specialization = "Neurology" },
                       existing);

            Assert.Equal(4, existing.Id);
            Assert.Single(existing.Appointments);
            Assert.Equal("Dr. Aya Hassan", existing.Name);
            Assert.Equal("Neurology", existing.Specialization);
        }

        [Fact]
        public void Patient_Maps_To_Response_Dtos()
        {
            var patient = NewPatient(3);

            var getDto = Mapper.Map<GetPatientDto>(patient);
            var dto = Mapper.Map<PatientDto>(patient);

            Assert.Equal(3, getDto.Id);
            Assert.Equal("Sara", getDto.Name);
            Assert.Equal("01000000000", dto.Phone);
        }

        [Fact]
        public void CreatePatientDto_Does_Not_Set_The_Key_Or_Appointments()
        {
            var dto = new CreatePatientDto
            {
                Id = 999,
                Name = "Nour",
                Phone = "01111111111",
                Gender = "Female",
                DateOfBirth = new DateTime(2000, 1, 1)
            };

            var patient = Mapper.Map<Patient>(dto);

            Assert.Equal(0, patient.Id);
            Assert.Empty(patient.Appointments);
            Assert.Equal("Nour", patient.Name);
        }

        #endregion

        #region Mass-assignment guard: response DTOs must not map back to entities

        [Fact]
        public void Response_Dtos_Have_No_Reverse_Map_To_Entities()
        {
            // These maps existed only because of ReverseMap(). Their return would reopen the
            // mass-assignment hole and re-break AssertConfigurationIsValid.
            Assert.Throws<AutoMapperMappingException>(() => Mapper.Map<Doctor>(new GetDoctorDto()));
            Assert.Throws<AutoMapperMappingException>(() => Mapper.Map<Doctor>(new DoctorDto()));
            Assert.Throws<AutoMapperMappingException>(() => Mapper.Map<Patient>(new GetPatientDto()));
            Assert.Throws<AutoMapperMappingException>(() => Mapper.Map<Patient>(new PatientDto()));
        }

        [Fact]
        public void AppointmentDto_Has_No_Reverse_Map_To_Appointment()
        {
            // The old map tried to assign the string DoctorName to the Doctor navigation property.
            Assert.Throws<AutoMapperMappingException>(() => Mapper.Map<Appointment>(new AppointmentDto()));
        }

        [Fact]
        public void DoctorScheduleDto_Has_No_Reverse_Map_To_DoctorSchedule()
        {
            Assert.Throws<AutoMapperMappingException>(
                () => Mapper.Map<DoctorSchedule>(new DoctorScheduleDto()));
        }

        #endregion
    }
}
