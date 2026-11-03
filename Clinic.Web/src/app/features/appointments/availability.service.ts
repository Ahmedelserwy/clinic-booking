import { Injectable, inject } from '@angular/core';

import { ClinicSettingsStore } from '../../core/data/clinic-settings.store';
import { Appointment } from '../../core/models/appointment.model';
import { DoctorSchedule, WeekDay } from '../../core/models/schedule.model';
import { dateToMinutes, isSameDay, parseDate, timeToMinutes } from '../../core/utils/date.util';

export interface TimeSlot {
  /** Minutes since midnight. */
  start: number;
  end: number;
  /** 12-hour label, e.g. `2:15 PM`. */
  label: string;
  available: boolean;
  /** Set when the slot is taken — shown so staff can see who has it. */
  takenBy?: string;
  /** Already in the past on today's date. */
  past: boolean;
}

export interface DayAvailability {
  working: boolean;
  /** The doctor's shifts on this weekday. */
  shifts: DoctorSchedule[];
  slots: TimeSlot[];
  availableCount: number;
}

/**
 * Turns a doctor's weekly schedule into bookable times.
 *
 * This is the rule the booking screen is built on: **a time exists only if the
 * doctor's schedule says it does.** Days the doctor does not work never become
 * selectable, times outside their hours are never generated, and a slot that is
 * already taken is rendered as taken rather than silently rejected on submit —
 * which is how the reference system produced double bookings.
 *
 * Slot length and the gap between appointments come from clinic settings, so
 * changing the diary granularity re-slices every doctor's day at once.
 */
@Injectable({ providedIn: 'root' })
export class AvailabilityService {
  private readonly settings = inject(ClinicSettingsStore);

  /** The weekdays this doctor works, derived from their schedule rows. */
  workingDays(schedules: readonly DoctorSchedule[], doctorId: number | null): Set<WeekDay> {
    if (doctorId === null) {
      return new Set();
    }

    return new Set(
      schedules
        .filter((schedule) => schedule.doctorId === doctorId)
        .map((schedule) => schedule.weekDay)
    );
  }

  /**
   * The `dateFilter` for `mat-datepicker`.
   *
   * Returning false greys the day out *and* blocks typing it, so an
   * unavailable date cannot enter the form by any route.
   */
  dateFilter(
    schedules: readonly DoctorSchedule[],
    doctorId: number | null
  ): (date: Date | null) => boolean {
    const days = this.workingDays(schedules, doctorId);

    return (date: Date | null): boolean => {
      if (!date) {
        return false;
      }
      return days.has(date.getDay() as WeekDay);
    };
  }

  /**
   * Every slot on `date` for `doctorId`, marked available or taken.
   *
   * `excludeAppointmentId` keeps a rescheduled appointment from colliding with
   * itself — without it, editing an appointment would report its own slot as
   * unavailable.
   */
  slotsFor(
    date: Date | null,
    doctorId: number | null,
    schedules: readonly DoctorSchedule[],
    appointments: readonly Appointment[],
    excludeAppointmentId?: number
  ): DayAvailability {
    if (!date || doctorId === null) {
      return { working: false, shifts: [], slots: [], availableCount: 0 };
    }

    const weekday = date.getDay() as WeekDay;
    const shifts = schedules
      .filter((schedule) => schedule.doctorId === doctorId && schedule.weekDay === weekday)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    if (!shifts.length) {
      return { working: false, shifts: [], slots: [], availableCount: 0 };
    }

    const { slotMinutes, bufferMinutes } = this.settings.settings();
    const step = Math.max(5, slotMinutes + bufferMinutes);

    const taken = this.takenSlots(date, doctorId, appointments, excludeAppointmentId);
    const now = new Date();
    const isToday = isSameDay(date, now);
    const nowMinutes = dateToMinutes(now);

    const slots: TimeSlot[] = [];

    for (const shift of shifts) {
      const shiftStart = timeToMinutes(shift.startTime);
      const shiftEnd = timeToMinutes(shift.endTime);

      // A slot must fit entirely inside the shift — a 30-minute appointment
      // starting 10 minutes before closing is not a real option.
      for (let start = shiftStart; start + slotMinutes <= shiftEnd; start += step) {
        const end = start + slotMinutes;
        const conflict = taken.find((entry) => overlaps(start, end, entry.start, entry.end));
        const past = isToday && start < nowMinutes;

        slots.push({
          start,
          end,
          label: format12(start),
          available: !conflict && !past,
          takenBy: conflict?.patientName,
          past,
        });
      }
    }

    // Overlapping shifts (a split day entered twice) would otherwise duplicate
    // the same time in the picker.
    const unique = new Map<number, TimeSlot>();
    for (const slot of slots) {
      const existing = unique.get(slot.start);
      if (!existing || (existing.available && !slot.available)) {
        unique.set(slot.start, slot);
      }
    }

    const deduped = [...unique.values()].sort((a, b) => a.start - b.start);

    return {
      working: true,
      shifts,
      slots: deduped,
      availableCount: deduped.filter((slot) => slot.available).length,
    };
  }

  /** Guard used at submit time, in case the slot was taken while the form was open. */
  isSlotAvailable(
    date: Date,
    startMinutes: number,
    doctorId: number,
    schedules: readonly DoctorSchedule[],
    appointments: readonly Appointment[],
    excludeAppointmentId?: number
  ): boolean {
    const availability = this.slotsFor(
      date,
      doctorId,
      schedules,
      appointments,
      excludeAppointmentId
    );
    return availability.slots.some((slot) => slot.start === startMinutes && slot.available);
  }

  private takenSlots(
    date: Date,
    doctorId: number,
    appointments: readonly Appointment[],
    excludeAppointmentId?: number
  ): { start: number; end: number; patientName: string }[] {
    const { slotMinutes } = this.settings.settings();

    return appointments
      .filter((appointment) => {
        if (appointment.id === excludeAppointmentId) {
          return false;
        }
        // A cancelled booking is kept on record but no longer holds its slot.
        if (appointment.status === 'Cancelled') {
          return false;
        }
        const when = parseDate(appointment.appointmentDate);
        if (!when || !isSameDay(when, date)) {
          return false;
        }
        // The list endpoint returns `doctorName` reliably but `doctorId` only
        // sometimes, so fall back to matching on whichever is present.
        return appointment.doctorId === undefined || appointment.doctorId === doctorId;
      })
      .map((appointment) => {
        const when = parseDate(appointment.appointmentDate)!;
        const start = dateToMinutes(when);
        return { start, end: start + slotMinutes, patientName: appointment.patientName };
      });
  }
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function format12(minutes: number): string {
  const hours24 = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${`${mins}`.padStart(2, '0')} ${suffix}`;
}