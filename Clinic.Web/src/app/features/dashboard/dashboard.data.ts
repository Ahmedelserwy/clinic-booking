import { Injectable, inject } from '@angular/core';
import { Observable, catchError, combineLatest, map, of, skip, startWith } from 'rxjs';

import { Appointment } from '../../core/models/appointment.model';
import { Doctor } from '../../core/models/doctor.model';
import { Pagination } from '../../core/models/pagination.model';
import { DoctorSchedule } from '../../core/models/schedule.model';
import { AppointmentsService } from '../../core/services/appointments.service';
import { DoctorsService } from '../../core/services/doctors.service';
import { PatientsService } from '../../core/services/patients.service';
import { SchedulesService } from '../../core/services/schedules.service';

/** Which parts of the snapshot already hold real data. */
export interface DashboardReady {
  patients: boolean;
  doctors: boolean;
  schedules: boolean;
  appointments: boolean;
}

export interface DashboardSnapshot {
  totalPatients: number;
  totalDoctors: number;
  doctors: Doctor[];
  schedules: DoctorSchedule[];
  appointments: Appointment[];
  totalAppointments: number;
  /** A card shows a placeholder until its own data is in. */
  ready: DashboardReady;
}

const EMPTY_PAGE = <T,>(): Pagination<T> => ({ pageIndex: 1, pageSize: 0, count: 0, data: [] });

/**
 * Loads everything the dashboard needs.
 *
 * The API has no aggregate endpoint, so the figures are composed here from the
 * list endpoints rather than in the component — which keeps the component about
 * presentation and means a future `/dashboard` endpoint replaces this one file.
 *
 * The four requests run in parallel and the snapshot is emitted again each time
 * one of them answers, with `ready` saying which parts are in. Each card can
 * therefore replace its placeholder as soon as its own data arrives, instead of
 * everything waiting for the slowest call.
 *
 * When a previous snapshot is passed (a refresh), its data stays in place for
 * the parts that have not answered yet, so the figures never blank out.
 *
 * Every call is wrapped in `catchError`: these endpoints answer **404 when a
 * collection is empty**, and a brand-new clinic would otherwise see an error
 * screen instead of an empty dashboard.
 */
@Injectable({ providedIn: 'root' })
export class DashboardData {
  private readonly appointments = inject(AppointmentsService);
  private readonly doctors = inject(DoctorsService);
  private readonly patients = inject(PatientsService);
  private readonly schedules = inject(SchedulesService);

  load(previous: DashboardSnapshot | null = null): Observable<DashboardSnapshot> {
    return combineLatest({
      patients: this.part(this.patients.getPatients({ pageIndex: 1, pageSize: 1 })),
      doctors: this.part(this.doctors.getDoctors({ pageIndex: 1, pageSize: 100 })),
      schedules: this.part(this.schedules.getSchedules({ pageIndex: 1, pageSize: 200 })),
      // A wide page rather than several filtered calls: the endpoint cannot
      // filter by date range, so the slicing happens client-side anyway.
      appointments: this.part(
        this.appointments.getAppointments({ pageIndex: 1, pageSize: 200, sort: 'Descending' })
      ),
    }).pipe(
      // Drop the initial "nothing has answered yet" emission; the first real one
      // is the first request to come back.
      skip(1),
      map(({ patients, doctors, schedules, appointments }): DashboardSnapshot => ({
        totalPatients: patients?.count ?? previous?.totalPatients ?? 0,
        totalDoctors: doctors?.count ?? previous?.totalDoctors ?? 0,
        doctors: doctors?.data ?? previous?.doctors ?? [],
        schedules: schedules?.data ?? previous?.schedules ?? [],
        appointments: appointments?.data ?? previous?.appointments ?? [],
        totalAppointments: appointments?.count ?? previous?.totalAppointments ?? 0,
        ready: {
          patients: !!patients || !!previous?.ready.patients,
          doctors: !!doctors || !!previous?.ready.doctors,
          schedules: !!schedules || !!previous?.ready.schedules,
          appointments: !!appointments || !!previous?.ready.appointments,
        },
      }))
    );
  }

  /** `null` until the request answers; an empty page if it fails. */
  private part<T>(source: Observable<Pagination<T>>): Observable<Pagination<T> | null> {
    return source.pipe(
      catchError(() => of(EMPTY_PAGE<T>())),
      startWith(null)
    );
  }
}