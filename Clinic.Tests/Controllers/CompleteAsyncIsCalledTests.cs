using AutoMapper;
using Clinic.Api.Controllers;
using Clinic.Api.DTOs.AppointmentDto;
using Clinic.Api.DTOs.DoctorDto;
using Clinic.Api.DTOs.PatientDto;
using Clinic.Api.DTOs.ScheduleDto;
using Clinic.Domain.Entites;
using Clinic.Domain.Interfaces;
using Clinic.Domain.Interfaces.Repository;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace Clinic.Tests.Controllers
{
    /// <summary>
    /// Regression tests for TODO #1 (finding C1): every mutating controller action must commit
    /// the unit of work. Before the fix, all of these passed through the change tracker and were
    /// discarded when the request scope ended, so the API reported success while persisting nothing.
    /// </summary>
    public class CompleteAsyncIsCalledTests
    {
        private readonly Mock<IUnitOfWork> _unitOfWork = new(MockBehavior.Strict);
        private readonly Mock<IMapper> _mapper = new();

        public CompleteAsyncIsCalledTests()
        {
            // Default: a successful commit affecting one row.
            _unitOfWork.Setup(u => u.CompleteAsync()).ReturnsAsync(1);
        }

        private Mock<IGenericRepository<T>> RepositoryFor<T>() where T : BaseEntity
        {
            var repository = new Mock<IGenericRepository<T>>();
            repository.Setup(r => r.AddAsync(It.IsAny<T>())).Returns(Task.CompletedTask);
            repository.Setup(r => r.UpdateAsync(It.IsAny<T>())).Returns(Task.CompletedTask);
            repository.Setup(r => r.DeleteAsync(It.IsAny<T>())).Returns(Task.CompletedTask);
            _unitOfWork.Setup(u => u.Repository<T>()).Returns(repository.Object);
            return repository;
        }

        #region DoctorsController

        [Fact]
        public async Task DoctorsController_Create_Commits_The_UnitOfWork()
        {
            var doctor = new Doctor { Name = "Dr. Aya", Specialization = "Cardiology" };
            var repository = RepositoryFor<Doctor>();
            _mapper.Setup(m => m.Map<CreateDoctorDto, Doctor>(It.IsAny<CreateDoctorDto>())).Returns(doctor);
            _mapper.Setup(m => m.Map<Doctor, GetDoctorDto>(doctor)).Returns(new GetDoctorDto());

            var sut = new DoctorsController(_unitOfWork.Object, _mapper.Object);

            await sut.Create(new CreateDoctorDto { Name = "Dr. Aya", Specialization = "Cardiology" });

            repository.Verify(r => r.AddAsync(doctor), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task DoctorsController_Create_Returns_The_Database_Generated_Id()
        {
            // EF assigns the identity value during SaveChangesAsync. Mapping the entity to a DTO
            // *before* the commit produced a Location header of /api/Doctors/0.
            var doctor = new Doctor { Name = "Dr. Aya", Specialization = "Cardiology" };
            RepositoryFor<Doctor>();

            _unitOfWork.Setup(u => u.CompleteAsync())
                       .Callback(() => doctor.Id = 42)
                       .ReturnsAsync(1);

            _mapper.Setup(m => m.Map<CreateDoctorDto, Doctor>(It.IsAny<CreateDoctorDto>())).Returns(doctor);
            _mapper.Setup(m => m.Map<Doctor, GetDoctorDto>(doctor)).Returns(new GetDoctorDto());

            var sut = new DoctorsController(_unitOfWork.Object, _mapper.Object);

            var response = await sut.Create(new CreateDoctorDto());

            var created = Assert.IsType<CreatedAtActionResult>(response.Result);
            Assert.Equal(42, created.RouteValues!["id"]);
        }

        [Fact]
        public async Task DoctorsController_Update_Commits_The_UnitOfWork()
        {
            var doctor = new Doctor { Id = 1, Name = "Dr. Aya", Specialization = "Cardiology" };
            var repository = RepositoryFor<Doctor>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(doctor);
            _mapper.Setup(m => m.Map<GetDoctorDto>(doctor)).Returns(new GetDoctorDto());

            var sut = new DoctorsController(_unitOfWork.Object, _mapper.Object);

            await sut.Update(1, new UpdateDoctorDto { Id = 1, Name = "Dr. Aya Hassan", Specialization = "Cardiology" });

            repository.Verify(r => r.UpdateAsync(doctor), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task DoctorsController_Delete_Commits_The_UnitOfWork()
        {
            var doctor = new Doctor { Id = 1, Name = "Dr. Aya", Specialization = "Cardiology" };
            var repository = RepositoryFor<Doctor>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(doctor);

            var sut = new DoctorsController(_unitOfWork.Object, _mapper.Object);

            await sut.Delete(1);

            repository.Verify(r => r.DeleteAsync(doctor), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task DoctorsController_Delete_Does_Not_Commit_When_Doctor_Is_Missing()
        {
            var repository = RepositoryFor<Doctor>();
            repository.Setup(r => r.GetByIdAsync(99)).ReturnsAsync((Doctor)null!);

            var sut = new DoctorsController(_unitOfWork.Object, _mapper.Object);

            Assert.IsType<NotFoundResult>(await sut.Delete(99));
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Never);
        }

        #endregion

        #region PatientsController

        [Fact]
        public async Task PatientsController_Create_Commits_The_UnitOfWork()
        {
            var patient = new Patient { Name = "Sara", Phone = "0100", Gender = "F" };
            var repository = RepositoryFor<Patient>();
            _mapper.Setup(m => m.Map<CreatePatientDto, Patient>(It.IsAny<CreatePatientDto>())).Returns(patient);
            _mapper.Setup(m => m.Map<GetPatientDto>(patient)).Returns(new GetPatientDto());

            var sut = new PatientsController(_mapper.Object, _unitOfWork.Object);

            await sut.Create(new CreatePatientDto());

            repository.Verify(r => r.AddAsync(patient), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task PatientsController_Update_Commits_The_UnitOfWork()
        {
            var patient = new Patient { Id = 1, Name = "Sara", Phone = "0100", Gender = "F" };
            var repository = RepositoryFor<Patient>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(patient);

            var sut = new PatientsController(_mapper.Object, _unitOfWork.Object);

            await sut.Update(1, new UpdatePatientDto());

            repository.Verify(r => r.UpdateAsync(patient), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task PatientsController_Delete_Commits_The_UnitOfWork()
        {
            var patient = new Patient { Id = 1, Name = "Sara", Phone = "0100", Gender = "F" };
            var repository = RepositoryFor<Patient>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(patient);

            var sut = new PatientsController(_mapper.Object, _unitOfWork.Object);

            await sut.Delete(1);

            repository.Verify(r => r.DeleteAsync(patient), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        #endregion

        #region ScheduleController

        [Fact]
        public async Task ScheduleController_Create_Commits_The_UnitOfWork()
        {
            var schedule = new DoctorSchedule { DoctorId = 1 };
            var repository = RepositoryFor<DoctorSchedule>();
            _mapper.Setup(m => m.Map<DoctorSchedule>(It.IsAny<CreateDoctorScheduleDto>())).Returns(schedule);
            _mapper.Setup(m => m.Map<DoctorScheduleDto>(schedule)).Returns(new DoctorScheduleDto());

            var sut = new ScheduleController(_unitOfWork.Object, _mapper.Object);

            await sut.Create(new CreateDoctorScheduleDto());

            repository.Verify(r => r.AddAsync(schedule), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task ScheduleController_Update_Commits_The_UnitOfWork()
        {
            var schedule = new DoctorSchedule { Id = 1, DoctorId = 1 };
            var repository = RepositoryFor<DoctorSchedule>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(schedule);

            var sut = new ScheduleController(_unitOfWork.Object, _mapper.Object);

            await sut.Update(1, new UpdateDoctorScheduleDto());

            repository.Verify(r => r.UpdateAsync(schedule), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task ScheduleController_Delete_Commits_The_UnitOfWork()
        {
            var schedule = new DoctorSchedule { Id = 1, DoctorId = 1 };
            var repository = RepositoryFor<DoctorSchedule>();
            repository.Setup(r => r.GetByIdAsync(1)).ReturnsAsync(schedule);

            var sut = new ScheduleController(_unitOfWork.Object, _mapper.Object);

            await sut.DeleteSchedule(1);

            repository.Verify(r => r.DeleteAsync(schedule), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        #endregion

        #region AppointmentsController

        // AppointmentsController writes through IAppointmentRepository rather than IUnitOfWork.Repository<T>().
        // Both are constructed from the same scoped ClinicDbContext, so IUnitOfWork.CompleteAsync() commits
        // those changes too. These tests pin that contract down.

        [Fact]
        public async Task AppointmentsController_Create_Commits_The_UnitOfWork()
        {
            var appointment = new Appointment { DoctorId = 1, PatientId = 2 };
            var appointments = new Mock<IAppointmentRepository>();
            appointments.Setup(r => r.AddAsync(It.IsAny<Appointment>())).Returns(Task.CompletedTask);
            // TODO #17 replaced the exact-equality availability check with an interval overlap
            // check plus a working-hours check. Here the slot is free and inside published hours.
            appointments.Setup(r => r.IsWithinWorkingHoursAsync(1, It.IsAny<DateTime>(), It.IsAny<DateTime>()))
                        .ReturnsAsync(true);
            appointments.Setup(r => r.HasOverlappingAppointmentAsync(
                            1, It.IsAny<DateTime>(), It.IsAny<DateTime>(), null))
                        .ReturnsAsync(false);

            RepositoryFor<Doctor>().Setup(r => r.GetByIdAsync(1))
                .ReturnsAsync(new Doctor { Id = 1, Name = "Dr. Aya", Specialization = "Cardiology" });
            RepositoryFor<Patient>().Setup(r => r.GetByIdAsync(2))
                .ReturnsAsync(new Patient { Id = 2, Name = "Sara", Phone = "0100", Gender = "F" });

            _mapper.Setup(m => m.Map<Appointment>(It.IsAny<CreateAppointmentDto>())).Returns(appointment);
            _mapper.Setup(m => m.Map<AppointmentDto>(appointment)).Returns(new AppointmentDto());

            var sut = new AppointmentsController(_mapper.Object, appointments.Object, _unitOfWork.Object);

            await sut.Create(new CreateAppointmentDto { DoctorId = 1, PatientId = 2, AppointmentDate = DateTime.UtcNow });

            appointments.Verify(r => r.AddAsync(appointment), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task AppointmentsController_Create_Preserves_Local_Schedule_Time_And_Stores_Utc()
        {
            var localStart = new DateTimeOffset(2026, 8, 3, 23, 0, 0, TimeSpan.FromHours(3));
            var appointment = new Appointment { DoctorId = 1, PatientId = 2 };
            var appointments = new Mock<IAppointmentRepository>();
            appointments.Setup(r => r.AddAsync(It.IsAny<Appointment>())).Returns(Task.CompletedTask);
            appointments.Setup(r => r.IsWithinWorkingHoursAsync(1, It.IsAny<DateTime>(), It.IsAny<DateTime>()))
                .ReturnsAsync(true);
            appointments.Setup(r => r.HasOverlappingAppointmentAsync(
                    1, It.IsAny<DateTime>(), It.IsAny<DateTime>(), null))
                .ReturnsAsync(false);

            RepositoryFor<Doctor>().Setup(r => r.GetByIdAsync(1))
                .ReturnsAsync(new Doctor { Id = 1, Name = "Dr. Aya", Specialization = "Cardiology" });
            RepositoryFor<Patient>().Setup(r => r.GetByIdAsync(2))
                .ReturnsAsync(new Patient { Id = 2, Name = "Sara", Phone = "0100", Gender = "F" });

            _mapper.Setup(m => m.Map<Appointment>(It.IsAny<CreateAppointmentDto>())).Returns(appointment);
            _mapper.Setup(m => m.Map<AppointmentDto>(appointment)).Returns(new AppointmentDto());

            var sut = new AppointmentsController(_mapper.Object, appointments.Object, _unitOfWork.Object);

            await sut.Create(new CreateAppointmentDto
            {
                DoctorId = 1,
                PatientId = 2,
                AppointmentDate = localStart,
                DurationMinutes = 30
            });

            appointments.Verify(r => r.IsWithinWorkingHoursAsync(
                1, localStart.DateTime, localStart.AddMinutes(30).DateTime), Times.Once);
            appointments.Verify(r => r.HasOverlappingAppointmentAsync(
                1, localStart.UtcDateTime, localStart.AddMinutes(30).UtcDateTime, null), Times.Once);
            Assert.Equal(localStart.UtcDateTime, appointment.AppointmentDate);
            Assert.Equal(localStart.UtcDateTime, appointment.StartTime);
            Assert.Equal(localStart.AddMinutes(30).UtcDateTime, appointment.EndTime);
        }

        [Fact]
        public async Task AppointmentsController_Delete_Commits_The_UnitOfWork()
        {
            var appointment = new Appointment { Id = 5, DoctorId = 1, PatientId = 2 };
            var appointments = new Mock<IAppointmentRepository>();
            appointments.Setup(r => r.GetByIdAsync(5)).ReturnsAsync(appointment);
            appointments.Setup(r => r.DeleteAsync(appointment)).Returns(Task.CompletedTask);

            var sut = new AppointmentsController(_mapper.Object, appointments.Object, _unitOfWork.Object);

            await sut.Delete(5);

            appointments.Verify(r => r.DeleteAsync(appointment), Times.Once);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Once);
        }

        [Fact]
        public async Task AppointmentsController_Create_Does_Not_Commit_When_The_Slot_Overlaps()
        {
            var appointments = new Mock<IAppointmentRepository>();
            appointments.Setup(r => r.IsWithinWorkingHoursAsync(1, It.IsAny<DateTime>(), It.IsAny<DateTime>()))
                        .ReturnsAsync(true);
            appointments.Setup(r => r.HasOverlappingAppointmentAsync(
                            1, It.IsAny<DateTime>(), It.IsAny<DateTime>(), null))
                        .ReturnsAsync(true);

            RepositoryFor<Doctor>().Setup(r => r.GetByIdAsync(1))
                .ReturnsAsync(new Doctor { Id = 1, Name = "Dr. Aya", Specialization = "Cardiology" });
            RepositoryFor<Patient>().Setup(r => r.GetByIdAsync(2))
                .ReturnsAsync(new Patient { Id = 2, Name = "Sara", Phone = "0100", Gender = "F" });

            var sut = new AppointmentsController(_mapper.Object, appointments.Object, _unitOfWork.Object);

            // An occupied slot is a 409, not a 400: the request is well formed, the state conflicts.
            Assert.IsType<ConflictObjectResult>(
                await sut.Create(new CreateAppointmentDto { DoctorId = 1, PatientId = 2 }));

            appointments.Verify(r => r.AddAsync(It.IsAny<Appointment>()), Times.Never);
            _unitOfWork.Verify(u => u.CompleteAsync(), Times.Never);
        }

        #endregion
    }
}
