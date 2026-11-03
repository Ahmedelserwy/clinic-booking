// reports-data.service.ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, forkJoin, of } from 'rxjs';

import { AccountsStore } from '../../core/data/accounts.store';
import { Appointment } from '../../core/models/appointment.model';
import { Doctor } from '../../core/models/doctor.model';
import { Patient } from '../../core/models/patient.model';
import { ApiService } from '../../core/services/api.service';
import { AppointmentsService } from '../../core/services/appointments.service';
import { DoctorsService } from '../../core/services/doctors.service';
import { PatientsService } from '../../core/services/patients.service';
import { addDays, parseDate, startOfDay, startOfMonth } from '../../core/utils/date.util';

const EMPTY = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

// ----------------------------------------------------------------------------
// Financial data (mirrors Application.DTOs.Finance on the API)
//
// The clinic is pay-first, so there are no invoices or balances: one payment per
// appointment, taken before the examination.
// ----------------------------------------------------------------------------

/** examination = first visit, full fee · visit = follow-up, cheaper · free = waived. */
export type CollectionKind = 'examination' | 'visit' | 'free';
export type CollectionMethod = 'cash' | 'card' | 'wallet' | 'bank';

export const COLLECTION_KINDS: CollectionKind[] = ['examination', 'visit', 'free'];
export const COLLECTION_METHODS: CollectionMethod[] = ['cash', 'card', 'wallet', 'bank'];

export interface PaymentRecord {
  id: number;
  appointmentId: number;
  patientId: number | null;
  patientName: string;
  doctorId: number | null;
  doctorName: string;
  kind: CollectionKind;
  amount: number;
  method: CollectionMethod;
  paidAt: string;
  notes?: string | null;
  refundedAmount: number;
  refundedAt?: string | null;
  refundReason?: string | null;
  receivedBy: string;
}

export interface PaymentList {
  items: PaymentRecord[];
  /** Everything that matches the filters, even when `items` is capped. */
  totalCount: number;
  totalCollected: number;
  totalRefunded: number;
}

export interface PaymentQuery {
  from?: string;
  to?: string;
  search?: string;
  kind?: CollectionKind;
  method?: CollectionMethod;
}

export interface PaymentInput {
  appointmentId: number;
  patientName: string;
  kind: CollectionKind;
  amount: number;
  method: CollectionMethod;
  notes?: string | null;
}

export interface RefundInput {
  amount: number;
  reason: string;
}

// ---------------------------------------------------------------- reports --

export interface IncomeBreakdown {
  examinationCount: number;
  examinationAmount: number;
  visitCount: number;
  visitAmount: number;
  freeCount: number;
  collected: number;
  refunded: number;
  net: number;
}

export interface MethodTotal {
  method: CollectionMethod | string;
  collected: number;
  refunded: number;
  net: number;
}

export interface SavedClosing {
  openingCash: number;
  expectedCash: number;
  countedCash: number;
  difference: number;
  notes?: string | null;
  closedBy: string;
  closedAt: string;
}

export interface DailyClosing {
  date: string;
  breakdown: IncomeBreakdown;
  byMethod: MethodTotal[];
  cashCollected: number;
  cashRefunded: number;
  cashExpenses: number;
  suggestedOpeningCash: number;
  openingCash: number;
  expectedCash: number;
  saved: SavedClosing | null;
}

export interface ClosingInput {
  date: string;
  openingCash: number;
  countedCash: number;
  notes?: string | null;
}

export interface RevenueDay {
  date: string;
  examinations: number;
  visits: number;
  free: number;
  collected: number;
  refunded: number;
  net: number;
}

export interface DoctorRevenue {
  doctor: string;
  examinations: number;
  visits: number;
  free: number;
  collected: number;
  refunded: number;
  net: number;
}

export interface Revenue {
  from: string;
  to: string;
  breakdown: IncomeBreakdown;
  previousNet: number;
  days: RevenueDay[];
  doctors: DoctorRevenue[];
  byMethod: MethodTotal[];
}

export interface PeriodRow {
  /** `yyyy-MM-dd` when grouped by day, `yyyy-MM` when grouped by month. */
  key: string;
  income: number;
  expenses: number;
  net: number;
}

export interface CategoryTotalRow {
  category: string;
  total: number;
}

export interface Period {
  from: string;
  to: string;
  group: 'day' | 'month';
  breakdown: IncomeBreakdown;
  expenses: number;
  netProfit: number;
  byMethod: MethodTotal[];
  expensesByCategory: CategoryTotalRow[];
  rows: PeriodRow[];
}

/**
 * The data behind the reports.
 *
 *  - appointments, doctors and patients are loaded once and shared;
 *  - the date range is shared, so it survives moving between reports;
 *  - `finance` talks to the API for everything money-related. Every figure there is computed on
 *    the server from the Payments and Expenses tables, so every computer in the clinic sees the
 *    same numbers.
 */
@Injectable({ providedIn: 'root' })
export class ReportsDataService {
  private readonly api = inject(ApiService);
  private readonly appointmentsApi = inject(AppointmentsService);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly patientsApi = inject(PatientsService);

  /**
   * The old browser-only books (localStorage). Kept so nothing that still reads it breaks, but the
   * financial reports no longer use it: money now lives on the server (see `finance`).
   */
  readonly accounts = inject(AccountsStore);

  readonly appointments = signal<Appointment[]>([]);
  readonly doctors = signal<Doctor[]>([]);
  readonly patients = signal<Patient[]>([]);
  readonly loading = signal(false);
  private loaded = false;

  readonly from = signal<Date>(startOfMonth(new Date()));
  readonly to = signal<Date>(new Date());

  readonly bounds = computed(() => ({
    from: startOfDay(this.from()).getTime(),
    to: startOfDay(addDays(this.to(), 1)).getTime(),
  }));

  readonly inPeriod = computed(() => {
    const { from, to } = this.bounds();
    return this.appointments().filter((a) => {
      const t = parseDate(a.appointmentDate)?.getTime();
      return t !== undefined && t >= from && t < to;
    });
  });

  // ------------------------------------------------------------- date range --

  setFrom(d: Date | null): void {
    if (d) this.from.set(d);
  }

  setTo(d: Date | null): void {
    if (d) this.to.set(d);
  }

  lastDays(n: number): void {
    this.to.set(new Date());
    this.from.set(startOfDay(addDays(new Date(), -n + 1)));
  }

  today(): void {
    const day = startOfDay(new Date());
    this.from.set(day);
    this.to.set(day);
  }

  yesterday(): void {
    const day = startOfDay(addDays(new Date(), -1));
    this.from.set(day);
    this.to.set(day);
  }

  thisMonth(): void {
    this.from.set(startOfMonth(new Date()));
    this.to.set(new Date());
  }

  thisYear(): void {
    this.from.set(new Date(new Date().getFullYear(), 0, 1));
    this.to.set(new Date());
  }

  // --------------------------------------------------------------- finance --

  /** The finance endpoints. Each call returns an Observable; the caller decides how to show it. */
  readonly finance = {
    listPayments: (query: PaymentQuery = {}): Observable<PaymentList> => {
      const params: Record<string, string> = {};
      if (query.from) params['From'] = query.from;
      if (query.to) params['To'] = query.to;
      if (query.search) params['Search'] = query.search;
      if (query.kind) params['Kind'] = query.kind;
      if (query.method) params['Method'] = query.method;
      return this.api.get<PaymentList>('Payments', params);
    },
    createPayment: (body: PaymentInput): Observable<PaymentRecord> =>
      this.api.post<PaymentRecord>('Payments', body),
    refund: (id: number, body: RefundInput): Observable<PaymentRecord> =>
      this.api.post<PaymentRecord>(`Payments/${id}/refund`, body),
    dailyClosing: (date: string): Observable<DailyClosing> =>
      this.api.get<DailyClosing>('Finance/daily-closing', { date }),
    saveClosing: (body: ClosingInput): Observable<DailyClosing> =>
      this.api.post<DailyClosing>('Finance/daily-closing', body),
    revenue: (from: string, to: string): Observable<Revenue> =>
      this.api.get<Revenue>('Finance/revenue', { from, to }),
    period: (from: string, to: string, group: 'day' | 'month'): Observable<Period> =>
      this.api.get<Period>('Finance/period', { from, to, group }),
  };

  // ------------------------------------------------------ shared appointment data --

  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loading.set(true);

    forkJoin({
      a: this.appointmentsApi
        .getAppointments({ pageIndex: 1, pageSize: 1000 })
        .pipe(catchError(() => of(EMPTY))),
      d: this.doctorsApi.getDoctors({ pageIndex: 1, pageSize: 200 }).pipe(catchError(() => of(EMPTY))),
      p: this.patientsApi.getPatients({ pageIndex: 1, pageSize: 1000 }).pipe(catchError(() => of(EMPTY))),
    }).subscribe({
      next: ({ a, d, p }) => {
        this.appointments.set(a.data as Appointment[]);
        this.doctors.set(d.data as Doctor[]);
        this.patients.set(p.data as Patient[]);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}