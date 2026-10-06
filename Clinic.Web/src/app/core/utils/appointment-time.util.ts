import { Appointment, UpdateAppointmentRequest } from '../models/appointment.model';
import { parseDate, toLocalIso } from './date.util';

/** Sanity bound: nothing in a clinic diary legitimately runs longer than a day. */
const MAX_DURATION_MINUTES = 24 * 60;

/**
 * How long an appointment runs, in minutes.
 *
 * Derived from `startTime`/`endTime` rather than assumed from clinic settings,
 * because that is what the API actually stored and what the overlap check on the
 * server compares against.
 *
 * `fallback` covers rows written before the API populated `EndTime`: it defaults
 * to `DateTime.MinValue`, which parses to a date in year 1 and would otherwise
 * yield a hugely negative duration and a block with a negative height.
 */
export function appointmentDuration(appointment: Appointment, fallback: number): number {
  const start = parseDate(appointment.startTime) ?? parseDate(appointment.appointmentDate);
  const end = parseDate(appointment.endTime);

  if (start && end) {
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (minutes > 0 && minutes <= MAX_DURATION_MINUTES) {
      return minutes;
    }
  }

  return fallback;
}

/** When an appointment starts. `appointmentDate` is the authoritative instant. */
export function appointmentStart(appointment: Appointment): Date | null {
  return parseDate(appointment.appointmentDate) ?? parseDate(appointment.startTime);
}

/**
 * An appointment expressed as an update payload.
 *
 * `PUT /Appointments/{id}` replaces the record: any field left out falls back to
 * the DTO's default, so a partial payload silently rewrites data the caller
 * never meant to touch — notably shortening the appointment to 30 minutes and,
 * were `status` not optional, reverting a confirmed booking to pending.
 * Everything is resent, and callers override only what they are changing.
 */
export function toUpdateRequest(
  appointment: Appointment,
  fallbackDurationMinutes: number
): UpdateAppointmentRequest {
  const startsAt = appointmentStart(appointment);

  return {
    doctorId: appointment.doctorId,
    patientId: appointment.patientId,
    appointmentDate: startsAt ? toLocalIso(startsAt) : appointment.appointmentDate,
    durationMinutes: appointmentDuration(appointment, fallbackDurationMinutes),
    status: appointment.status,
    notes: appointment.notes ?? null,
  };
}
