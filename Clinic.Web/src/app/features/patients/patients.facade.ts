import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, switchMap } from 'rxjs';

import { MedicalRecordsStore } from '../../core/data/medical-records.store';
import { PatientProfile, PatientProfileStore } from '../../core/data/patient-profile.store';
import { Pagination } from '../../core/models/pagination.model';
import { CreatePatientRequest, Patient, calculateAge } from '../../core/models/patient.model';
import { PatientsService } from '../../core/services/patients.service';
import { parseDate } from '../../core/utils/date.util';
import { SearchEvent } from '../../shared/ui/search-field/search-field.component';

/** An API patient joined to its locally-held clinical profile. */
export interface PatientView extends Patient {
  profile: PatientProfile;
  age: number | null;
}

/** A follow-up the doctor set that is due today, or was due earlier and has not been honoured. */
export type FollowUpPhase = 'today' | 'overdue';

export interface FollowUpInfo {
  date: Date;
  phase: FollowUpPhase;
  /** Whole days past the due date; 0 when it is due today. */
  daysLate: number;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Decides whether a follow-up date needs the front desk's attention.
 *
 * Future follow-ups return `null` (nothing to do yet), and so does one the
 * patient has already honoured: a visit on or after the due day clears it.
 */
export function followUpInfo(
  due: Date | null | undefined,
  lastVisit: Date | null | undefined,
  now: Date = new Date()
): FollowUpInfo | null {
  if (!due) {
    return null;
  }

  const dueDay = startOfDay(due);
  const today = startOfDay(now);

  if (dueDay.getTime() > today.getTime()) {
    return null;
  }
  if (lastVisit && lastVisit.getTime() >= dueDay.getTime()) {
    return null;
  }

  const daysLate = Math.round((today.getTime() - dueDay.getTime()) / DAY_MS);
  return { date: due, phase: daysLate === 0 ? 'today' : 'overdue', daysLate };
}

export interface PatientListQuery {
  pageIndex: number;
  pageSize: number;
  sort?: string;
  search?: SearchEvent | null;
}

export interface PatientListResult {
  data: PatientView[];
  count: number;
}

/** Wide enough to filter locally when the API cannot express the query. */
const CLIENT_FILTER_PAGE_SIZE = 200;

/**
 * The single entry point for patient data.
 *
 * A patient is stored in two halves — identity in the API, clinical detail in
 * the local profile store — and no component should have to know that. This
 * joins them, keeps profile creation and record cleanup in step with the API
 * calls, and is the one file that changes if the backend ever grows the extra
 * columns.
 *
 * It also resolves the three search modes. The API's `Search` matches names
 * only, so a phone number or file number is answered by pulling a wide page and
 * filtering here — correct results beat a fast query that cannot find anyone.
 */
@Injectable({ providedIn: 'root' })
export class PatientsFacade {
  private readonly api = inject(PatientsService);
  private readonly profiles = inject(PatientProfileStore);
  private readonly records = inject(MedicalRecordsStore);

  list(query: PatientListQuery): Observable<PatientListResult> {
    const search = query.search;
    const needsLocalFilter = search?.kind === 'phone' || search?.kind === 'mrn';

    return this.api
      .getPatients({
        pageIndex: needsLocalFilter ? 1 : query.pageIndex,
        pageSize: needsLocalFilter ? CLIENT_FILTER_PAGE_SIZE : query.pageSize,
        search: search?.kind === 'text' ? search.term : undefined,
        sort: query.sort,
      })
      .pipe(
        // These endpoints answer 404 rather than an empty page.
        catchError(() => of<Pagination<Patient>>({ pageIndex: 1, pageSize: 0, count: 0, data: [] })),
        map((page) => {
          const views = page.data.map((patient) => this.toView(patient));

          if (!needsLocalFilter || !search) {
            return { data: views, count: page.count };
          }

          const matches =
            search.kind === 'phone'
              ? views.filter((view) => digits(view.phone).endsWith(search.term))
              : views.filter((view) => matchesFileNumber(view.profile.fileNumber, search.term));

          // Paginate the filtered set so the pager stays honest.
          const start = (query.pageIndex - 1) * query.pageSize;
          return {
            data: matches.slice(start, start + query.pageSize),
            count: matches.length,
          };
        })
      );
  }

  /**
   * The follow-up date from the patient's most recent record that set one, or
   * `null`. Only the newest counts: a later visit supersedes an older plan.
   */
  followUpDateFor(patientId: number): Date | null {
    const dated = this.records
      .forPatient(patientId)
      .map((record) => ({
        occurredAt: new Date(record.occurredAt).getTime(),
        raw: (record as unknown as { followUpDate?: string | Date | null }).followUpDate,
      }))
      .filter((entry) => Boolean(entry.raw))
      .sort((a, b) => b.occurredAt - a.occurredAt);

    const raw = dated[0]?.raw;
    if (!raw) {
      return null;
    }
    return raw instanceof Date ? raw : parseDate(String(raw));
  }

  get(id: number): Observable<PatientView> {
    return this.api.getPatient(id).pipe(map((patient) => this.toView(patient)));
  }

  create(
    payload: CreatePatientRequest,
    profile: Partial<PatientProfile>
  ): Observable<PatientView> {
    return this.api.createPatient(payload).pipe(
      map((created) => {
        this.profiles.ensure(created.id);
        this.profiles.save(created.id, profile);
        return this.toView(created);
      })
    );
  }

  update(
    id: number,
    payload: CreatePatientRequest,
    profile: Partial<PatientProfile>
  ): Observable<PatientView> {
    return this.api.updatePatient(id, { ...payload, id }).pipe(
      switchMap(() => {
        this.profiles.save(id, profile);
        return this.get(id);
      })
    );
  }

  /**
   * Deletes the patient and everything that only exists because of them.
   *
   * Local data is cleared *after* the API confirms, so a failed delete cannot
   * leave a patient with their clinical history already gone.
   */
  remove(id: number): Observable<void> {
    return this.api.deletePatient(id).pipe(
      map(() => {
        this.records.removeForPatient(id);
        this.profiles.remove(id);
      })
    );
  }

  private toView(patient: Patient): PatientView {
    return {
      ...patient,
      profile: this.profiles.ensure(patient.id),
      age: calculateAge(patient.dateOfBirth),
    };
  }
}

function digits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/** Matches `2026-00007`, `00007` and `7`, which is how staff actually type it. */
function matchesFileNumber(fileNumber: string, term: string): boolean {
  const normalised = term.trim().toLowerCase();
  const sequence = fileNumber.split('-')[1] ?? fileNumber;
  return (
    fileNumber.toLowerCase() === normalised ||
    sequence === normalised ||
    sequence === normalised.padStart(sequence.length, '0')
  );
}