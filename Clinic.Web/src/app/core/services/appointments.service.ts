import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import {
  Appointment,
  AppointmentQuery,
  AppointmentStatus,
  CreateAppointmentRequest,
  UpdateAppointmentRequest
} from '../models/appointment.model';
import { Pagination } from '../models/pagination.model';
import { toUpdateRequest } from '../utils/appointment-time.util';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class AppointmentsService {
  private readonly api = inject(ApiService);

  getAppointments(query: AppointmentQuery = {}): Observable<Pagination<Appointment>> {
    return this.api.get<Pagination<Appointment>>('Appointments', {
      PageIndex: query.pageIndex,
      PageSize: query.pageSize,
      DoctorId: query.doctorId,
      PatientId: query.patientId,
      Status: query.status,
      From: query.from,
      To: query.to,
      Sort: query.sort
    });
  }

  getAppointment(id: number): Observable<Appointment> {
    return this.api.get<Appointment>(`Appointments/${id}`);
  }

  getByDoctorName(doctorName: string): Observable<Appointment[]> {
    return this.api.get<Appointment[]>(`Appointments/doctor/${encodeURIComponent(doctorName)}`);
  }

  getByPatientName(patientName: string): Observable<Appointment[]> {
    return this.api.get<Appointment[]>(`Appointments/patient/${encodeURIComponent(patientName)}`);
  }

  createAppointment(payload: CreateAppointmentRequest): Observable<Appointment> {
    return this.api.post<Appointment>('Appointments', payload);
  }

  updateAppointment(id: number, payload: UpdateAppointmentRequest): Observable<Appointment> {
    return this.api.put<Appointment>(`Appointments/${id}`, payload);
  }

  /**
   * Moves an appointment along its lifecycle: confirm, complete, cancel.
   *
   * Goes through `PUT /Appointments/{id}/status`, which changes the status and
   * nothing else. It used to resend the whole record through
   * `PUT /Appointments/{id}`, which re-runs the doctor, patient, working-hours
   * and overlap checks meant for a booking that is moving — so an appointment
   * that no longer passed them, or whose payload was rebuilt incompletely,
   * could not even be cancelled and came back 400.
   *
   * `_fallbackDurationMinutes` is unused now; it stays so existing callers
   * compile unchanged.
   */
  changeStatus(
    appointment: Appointment,
    status: AppointmentStatus,
    _fallbackDurationMinutes?: number
  ): Observable<Appointment> {
    return this.api.put<Appointment>(`Appointments/${appointment.id}/status`, { status });
  }

  /**
   * Moves an appointment to a new start time and, optionally, a new doctor.
   *
   * The server re-runs both booking rules (inside the doctor's published hours,
   * no overlap) and answers 400 or 409 when the move is not allowed, so a drag
   * on the calendar cannot write a slot the booking form would have refused.
   */
  reschedule(
    appointment: Appointment,
    startsAt: string,
    fallbackDurationMinutes: number,
    doctorId: number = appointment.doctorId
  ): Observable<Appointment> {
    return this.updateAppointment(appointment.id, {
      ...toUpdateRequest(appointment, fallbackDurationMinutes),
      appointmentDate: startsAt,
      doctorId
    });
  }

  /**
   * Cancels an appointment by setting its status to `Cancelled`.
   *
   * The record is kept, so the calendar still shows it (muted) and counts it
   * under "Cancelled". It used to `DELETE` the row, which made a cancelled
   * booking vanish and left the Cancelled status unreachable from this path.
   */
  cancelAppointment(
    appointment: Appointment,
    fallbackDurationMinutes?: number
  ): Observable<Appointment> {
    return this.changeStatus(appointment, 'Cancelled', fallbackDurationMinutes);
  }

  /** Permanently removes the row. Not used by the UI's cancel flow. */
  deleteAppointment(id: number): Observable<void> {
    return this.api.delete<void>(`Appointments/${id}`);
  }
}