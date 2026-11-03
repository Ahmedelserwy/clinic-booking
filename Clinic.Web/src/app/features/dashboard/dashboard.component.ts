import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';

import { PermissionService } from '../../core/authz/permission.service';
import { AccountsStore } from '../../core/data/accounts.store';
import { ClinicSettingsStore } from '../../core/data/clinic-settings.store';
import { Appointment } from '../../core/models/appointment.model';
import { WeekDay } from '../../core/models/schedule.model';
import { AuthService } from '../../core/services/auth.service';
import { addDays, isSameDay, parseDate, startOfDay } from '../../core/utils/date.util';
import { CardComponent } from '../../shared/ui/card/card.component';
import { EmptyStateComponent } from '../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../shared/ui/page-header/page-header.component';
import { DashboardData, DashboardSnapshot } from './dashboard.data';

type StatusGroup = 'completed' | 'cancelled' | 'inProgress' | 'upcoming';
type QueuePhase = 'now' | 'next' | 'wait' | 'later';
type LoadLevel = 'high' | 'mid' | 'low';

/** Appointments one doctor can take in a day. Used only to draw the load bars. */
const DOCTOR_DAILY_CAPACITY = 10;

/** The week on the chart starts on Saturday (0 = Sunday ... 6 = Saturday). */
const WEEK_START_DAY = 6;

interface QueueItem {
  appointment: Appointment;
  phase: QueuePhase;
  /** Minutes until the start time; negative once the slot has started. */
  minutes: number;
}

interface AttentionItem {
  id: string;
  icon: 'doctors' | 'calendarCheck';
  tone: 'warning' | 'info' | 'danger';
  messageKey: string;
  count: number;
  route: string;
  hint: string;
  action: string;
}

interface WeekColumn {
  key: number;
  /** Bar height as a share of the chart, 0-100. */
  pct: number;
  today: boolean;
  future: boolean;
  label: string;
  /** Short value printed above the bar. */
  display: string;
  /** Native tooltip. */
  tip: string;
}

interface ServiceShare {
  name: string;
  pct: number;
  tone: number;
}

interface DoctorLoad {
  id: unknown;
  name: string;
  count: number;
  capacity: number;
  free: number;
  pct: number;
  level: LoadLevel;
}

/**
 * Status of an appointment, read defensively: the dashboard only needs to know
 * "done", "cancelled" or "still open", whether the API sends a string or an enum name.
 */
function statusText(appointment: Appointment): string {
  return String((appointment as { status?: unknown }).status ?? '').toLowerCase();
}

const isCancelled = (status: string) => status.includes('cancel');
const isDone = (status: string) => status.includes('complet');
const isInProgress = (status: string) =>
  status.includes('progress') || status.includes('examin') || status.includes('consult');
const isNoShow = (status: string) => {
  const flat = status.replace(/[\s_-]/g, '');
  return flat.includes('noshow') || flat.includes('absent') || flat.includes('missed');
};
/** Cancelled or no-show: the slot will not be used. */
const isOff = (status: string) => isCancelled(status) || isNoShow(status);
const isOpen = (status: string) => !isOff(status) && !isDone(status);

/** Name of the service/treatment on an appointment, whichever field the API uses. */
function serviceOf(appointment: Appointment): string {
  const record = appointment as unknown as Record<string, unknown>;
  for (const key of [
    'serviceName',
    'service',
    'treatmentName',
    'treatment',
    'procedureName',
    'procedure',
    'appointmentType',
    'type',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

@Component({
  selector: 'app-dashboard',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    TranslatePipe,
    CardComponent,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  private readonly auth = inject(AuthService);
  private readonly data = inject(DashboardData);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly accounts = inject(AccountsStore);
  protected readonly permissions = inject(PermissionService);
  protected readonly settings = inject(ClinicSettingsStore);

  private readonly snapshot = signal<DashboardSnapshot | null>(null);
  protected readonly loading = signal(true);

  /** Which parts of the page already have their data. A card shows a placeholder until its own data is in. */
  protected readonly ready = computed(
    () =>
      this.snapshot()?.ready ?? {
        patients: false,
        doctors: false,
        schedules: false,
        appointments: false,
      }
  );

  protected readonly appointmentsReady = computed(() => this.ready().appointments);

  protected readonly patientsReady = computed(() => this.ready().patients);

  /** The attention list and doctor load need doctors, their schedules and the appointments together. */
  protected readonly staffReady = computed(() => {
    const ready = this.ready();
    return ready.appointments && ready.doctors && ready.schedules;
  });

  /** When the data last arrived; shown in the page subtitle. */
  protected readonly updatedAt = signal<Date | null>(null);

  private readonly lang = toSignal(this.translate.onLangChange.pipe(map((event) => event.lang)), {
    initialValue: (typeof document !== 'undefined' && document.documentElement.lang) || 'ar',
  });

  protected readonly isArabic = computed(() => this.lang().toLowerCase().startsWith('ar'));

  /** Latin digits in both languages, to match the numbers shown everywhere else in the app. */
  private readonly locale = computed(() => `${this.isArabic() ? 'ar' : 'en'}-u-nu-latn`);

  /** Ticks every minute so the queue, wait times and the date move. */
  private readonly now = signal(new Date());

  /** Midnight of the current day. Follows `now`, so the dashboard rolls over after midnight. */
  protected readonly today = computed(() => startOfDay(this.now()));

  private readonly timeFormat = computed(
    () => new Intl.DateTimeFormat(this.locale(), { hour: 'numeric', minute: '2-digit', hour12: true })
  );

  /** The appointment id the queue was last scrolled to, so a manual scroll is not undone every minute. */
  private revealedId: unknown = null;

  constructor() {
    this.load(true);

    const timer = setInterval(() => {
      this.now.set(new Date());
      // Quiet refresh: no loading state, and skipped while the tab is hidden.
      if (typeof document === 'undefined' || !document.hidden) {
        this.load(false);
      }
    }, 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    // Keep the "next" appointment in view inside the scrollable queue.
    effect(() => {
      const id = this.nextId();
      if (id === null || id === this.revealedId) {
        return;
      }
      this.revealedId = id;
      setTimeout(() => this.revealNext());
    });
  }

  // --------------------------------------------------------------- header --

  /** Page title: "Good morning, Ahmed". */
  protected readonly greeting = computed(() => {
    this.lang();
    const hour = this.now().getHours();
    const key =
      hour < 12
        ? 'dashboard.greetingMorning'
        : hour < 17
          ? 'dashboard.greetingAfternoon'
          : 'dashboard.greetingEvening';

    const name = this.auth.currentUser?.displayName?.split(/\s+/)[0] ?? '';
    return this.translate.instant(key, { name });
  });

  /** Today's date, how often the page refreshes, and when it last did. */
  protected readonly subtitle = computed(() => {
    const date = this.now().toLocaleDateString(this.locale(), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const auto = this.text(
      'dashboard.autoRefresh',
      'يتحدّث تلقائيًا كل دقيقة',
      'Updates automatically every minute'
    );
    const stamp = this.updatedAt();
    const updated = stamp
      ? `${this.text('dashboard.lastUpdated', 'آخر تحديث', 'Last updated')} ${this.timeFormat().format(stamp)}`
      : '';
    return [date, auto, updated].filter(Boolean).join(' · ');
  });

  protected readonly showMoney = computed(() => this.permissions.can('accounts.view'));

  // ---------------------------------------------------------- appointments --

  private readonly appointments = computed(() => this.snapshot()?.appointments ?? []);

  protected readonly todaysAppointments = computed(() =>
    this.appointments()
      .filter((appointment) => this.isOnDay(appointment, this.today()))
      .sort((a, b) => a.appointmentDate.localeCompare(b.appointmentDate))
  );

  protected readonly todaysPatients = computed(
    () => new Set(this.todaysAppointments().map((appointment) => appointment.patientName)).size
  );

  protected readonly totalPatients = computed(() => this.snapshot()?.totalPatients ?? 0);

  /** Today's appointments grouped for the hero card. No-shows are counted with cancelled. */
  protected readonly statusCounts = computed<Record<StatusGroup, number>>(() => {
    const now = this.now().getTime();
    const counts: Record<StatusGroup, number> = {
      completed: 0,
      cancelled: 0,
      inProgress: 0,
      upcoming: 0,
    };

    for (const appointment of this.todaysAppointments()) {
      const status = statusText(appointment);
      const time = parseDate(appointment.appointmentDate)?.getTime() ?? 0;

      if (isOff(status)) {
        counts.cancelled++;
      } else if (isDone(status)) {
        counts.completed++;
      } else if (time <= now) {
        counts.inProgress++;
      } else {
        counts.upcoming++;
      }
    }
    return counts;
  });

  /** Coloured parts of the hero bar; what is left over shows as the empty track. */
  protected readonly segments = computed(() => {
    const total = this.todaysAppointments().length;
    if (total === 0) {
      return [];
    }
    const c = this.statusCounts();
    const parts: { key: StatusGroup; n: number }[] = [
      { key: 'completed', n: c.completed },
      { key: 'inProgress', n: c.inProgress },
      { key: 'cancelled', n: c.cancelled },
    ];
    return parts.filter((part) => part.n > 0).map((part) => ({ key: part.key, pct: (part.n / total) * 100 }));
  });

  // ----------------------------------------------------------------- queue --

  /** Open appointments today, in time order, with minutes until (or since) their start. */
  protected readonly queue = computed<QueueItem[]>(() => {
    const now = this.now().getTime();
    let nextTaken = false;

    return this.todaysAppointments()
      .filter((appointment) => isOpen(statusText(appointment)))
      .map((appointment) => {
        const time = parseDate(appointment.appointmentDate)?.getTime() ?? now;
        const minutes = Math.round((time - now) / 60_000);

        let phase: QueuePhase;
        if (isInProgress(statusText(appointment))) {
          phase = 'now';
        } else if (time <= now) {
          phase = 'wait';
        } else if (!nextTaken) {
          nextTaken = true;
          phase = 'next';
        } else {
          phase = 'later';
        }
        return { appointment, phase, minutes };
      });
  });

  private readonly nextId = computed(
    () => this.queue().find((item) => item.phase === 'next')?.appointment.id ?? null
  );

  /** Patients whose slot has started and who have not been seen yet. */
  protected readonly waitingNow = computed(() => this.queue().filter((item) => item.phase === 'wait'));

  protected readonly avgWait = computed(() => {
    const waiting = this.waitingNow();
    if (!waiting.length) {
      return 0;
    }
    return Math.round(waiting.reduce((sum, item) => sum + -item.minutes, 0) / waiting.length);
  });

  /** Missed appointments over the last 7 days (up to now). */
  protected readonly noShow = computed(() => {
    const from = addDays(this.today(), -6).getTime();
    const now = this.now().getTime();

    const past = this.appointments().filter((appointment) => {
      const time = parseDate(appointment.appointmentDate)?.getTime();
      return time !== undefined && time >= from && time <= now && !isCancelled(statusText(appointment));
    });
    const missed = past.filter((appointment) => isNoShow(statusText(appointment))).length;

    return {
      missed,
      total: past.length,
      pct: past.length ? Math.round((missed / past.length) * 100) : 0,
    };
  });

  // ------------------------------------------------------ needs attention --

  protected readonly attention = computed<AttentionItem[]>(() => {
    const snapshot = this.snapshot();
    if (!snapshot) {
      return [];
    }

    const items: AttentionItem[] = [];

    const pending = this.appointments().filter(
      (appointment) =>
        statusText(appointment).includes('pending') &&
        (parseDate(appointment.appointmentDate)?.getTime() ?? 0) >= this.today().getTime()
    ).length;

    if (pending > 0) {
      items.push({
        id: 'pending',
        icon: 'calendarCheck',
        tone: 'warning',
        messageKey: 'dashboard.attentionPending',
        count: pending,
        route: '/appointments',
        hint: this.text('dashboard.hintPending', 'بانتظار التأكيد', 'Waiting for confirmation'),
        action: this.text('dashboard.actionConfirm', 'تأكيد', 'Confirm'),
      });
    }

    const tomorrow = addDays(this.today(), 1);
    const tomorrowCount = this.appointments().filter((appointment) =>
      this.isOnDay(appointment, tomorrow)
    ).length;

    if (tomorrowCount > 0) {
      items.push({
        id: 'tomorrow',
        icon: 'calendarCheck',
        tone: 'info',
        messageKey: 'dashboard.attentionTomorrow',
        count: tomorrowCount,
        route: '/appointments',
        hint: this.text('dashboard.hintTomorrow', 'مجدولة لغدٍ', 'Scheduled for tomorrow'),
        action: this.text('dashboard.actionView', 'عرض', 'View'),
      });
    }

    const weekday = this.today().getDay() as WeekDay;
    const working = new Set(
      snapshot.schedules
        .filter((schedule) => schedule.weekDay === weekday)
        .map((schedule) => schedule.doctorId)
    );
    const offToday = new Set(
      snapshot.doctors.filter((doctor) => !working.has(doctor.id)).map((doctor) => doctor.name)
    );
    const conflicts = this.todaysAppointments().filter((appointment) =>
      offToday.has(appointment.doctorName)
    ).length;

    if (conflicts > 0) {
      items.push({
        id: 'conflict',
        icon: 'doctors',
        tone: 'danger',
        messageKey: 'dashboard.attentionConflict',
        count: conflicts,
        route: '/schedules',
        hint: this.text('dashboard.hintConflict', 'الطبيب غير مجدول اليوم', 'Doctor is not scheduled today'),
        action: this.text('dashboard.actionMove', 'نقل', 'Move'),
      });
    }

    return items;
  });

  // ----------------------------------------------------------- doctor load --

  protected readonly doctorLoad = computed<DoctorLoad[]>(() => {
    const snapshot = this.snapshot();
    if (!snapshot) {
      return [];
    }

    const weekday = this.today().getDay() as WeekDay;
    const working = new Set(
      snapshot.schedules.filter((s) => s.weekDay === weekday).map((s) => s.doctorId)
    );

    const counts = new Map<string, number>();
    for (const appointment of this.todaysAppointments()) {
      if (isOff(statusText(appointment))) {
        continue;
      }
      counts.set(appointment.doctorName, (counts.get(appointment.doctorName) ?? 0) + 1);
    }

    return snapshot.doctors
      .filter((doctor) => working.has(doctor.id) || counts.has(doctor.name))
      .map((doctor) => {
        const count = counts.get(doctor.name) ?? 0;
        const capacity = Math.max(DOCTOR_DAILY_CAPACITY, count);
        const pct = Math.round((count / capacity) * 100);
        const level: LoadLevel = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low';
        return { id: doctor.id, name: doctor.name, count, capacity, free: capacity - count, pct, level };
      })
      .sort((a, b) => b.pct - a.pct);
  });

  // -------------------------------------------------------------- services --

  /** Top services among this month's appointments (empty if the API sends no service field). */
  protected readonly services = computed<ServiceShare[]>(() => {
    const today = this.today();
    const counts = new Map<string, number>();
    let total = 0;

    for (const appointment of this.appointments()) {
      const date = parseDate(appointment.appointmentDate);
      if (
        !date ||
        date.getFullYear() !== today.getFullYear() ||
        date.getMonth() !== today.getMonth() ||
        isOff(statusText(appointment))
      ) {
        continue;
      }
      const name = serviceOf(appointment);
      if (!name) {
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
      total++;
    }

    if (total === 0) {
      return [];
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, n], index) => ({ name, pct: Math.round((n / total) * 100), tone: index + 1 }));
  });

  // -------------------------------------------------------------- finance --

  protected readonly revenueToday = computed(() =>
    this.accounts.incomeBetween(this.today(), this.today())
  );

  protected readonly currency = computed(() => this.settings.settings().currency);

  /** Change in today's revenue against yesterday, in percent (null if yesterday had none). */
  protected readonly revenueDelta = computed<number | null>(() => {
    if (!this.showMoney()) {
      return null;
    }
    const yesterday = addDays(this.today(), -1);
    const before = this.accounts.incomeBetween(yesterday, yesterday);
    if (!before) {
      return null;
    }
    return Math.round(((this.revenueToday() - before) / before) * 100);
  });

  // ------------------------------------------------------------ week chart --

  /**
   * Saturday to Friday. Past days and today show what happened; days still to come
   * show what is booked (for revenue: bookings x this week's average per visit).
   */
  protected readonly week = computed<WeekColumn[]>(() => {
    const money = this.showMoney();
    const locale = this.locale();
    const today = this.today();

    const offset = (today.getDay() - WEEK_START_DAY + 7) % 7;
    const start = addDays(today, -offset);
    const days = Array.from({ length: 7 }, (_, i) => startOfDay(addDays(start, i)));

    const all = this.appointments();
    const booked = days.map(
      (day) => all.filter((a) => this.isOnDay(a, day) && !isOff(statusText(a))).length
    );
    const actual = money ? this.accounts.dailyIncome(days).map((point) => point.value) : booked;

    let doneAmount = 0;
    let doneCount = 0;
    for (let i = 0; i <= offset; i++) {
      doneAmount += actual[i] ?? 0;
      doneCount += booked[i];
    }
    const perVisit = !money ? 1 : doneCount > 0 ? doneAmount / doneCount : 0;

    const values = days.map((_, i) => (i <= offset ? (actual[i] ?? 0) : booked[i] * perVisit));
    const peak = Math.max(0, ...values);

    const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
    const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const expected = this.text('dashboard.expected', 'متوقع', 'expected');

    return days.map((day, i) => {
      const future = i > offset;
      const value = values[i];
      const full = money ? `${plain.format(value)} ${this.currency()}` : plain.format(value);
      const date = day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

      return {
        key: day.getTime(),
        pct: peak ? (value / peak) * 100 : 0,
        today: i === offset,
        future,
        label: day.toLocaleDateString(locale, { weekday: 'short' }),
        display: value > 0 ? compact.format(value) : '',
        tip: `${date} · ${full}${future ? ` (${expected})` : ''}`,
      };
    });
  });

  // ----------------------------------------------------------------- text --

  /** The translation if the key exists, otherwise a built-in line, so no JSON edit is needed to run this. */
  protected text(key: string, ar: string, en: string): string {
    this.lang();
    const value = this.translate.instant(key);
    return value && value !== key ? value : this.isArabic() ? ar : en;
  }

  protected money(value: number): string {
    return new Intl.NumberFormat(this.locale(), { maximumFractionDigits: 2 }).format(value);
  }

  protected patientsSub(): string {
    const total = this.totalPatients();
    return this.isArabic() ? `من إجمالي ${total} مريض` : `of ${total} patients overall`;
  }

  protected weekTitle(): string {
    return this.showMoney()
      ? this.text('dashboard.revenueWeek', 'الإيرادات هذا الأسبوع', 'Revenue this week')
      : this.text('dashboard.appointmentsWeek', 'المواعيد هذا الأسبوع', 'Appointments this week');
  }

  protected weekTag(): string {
    return this.showMoney()
      ? `${this.currency()} · ${this.text('dashboard.futureExpected', 'الأيام القادمة متوقعة', 'coming days are expected')}`
      : this.text('dashboard.futureBooked', 'الأيام القادمة حسب الحجوزات', 'coming days show bookings');
  }

  protected queueCountLabel(): string {
    const n = this.queue().length;
    return this.isArabic() ? `${n} مرضى` : `${n} ${n === 1 ? 'patient' : 'patients'}`;
  }

  protected waitingLabel(): string {
    const n = this.waitingNow().length;
    if (n === 0) {
      return this.text('dashboard.noWaiting', 'لا أحد ينتظر', 'No one waiting');
    }
    return this.isArabic() ? `${n} في الانتظار الآن` : `${n} waiting now`;
  }

  protected noShowLabel(): string {
    const { missed, total } = this.noShow();
    return this.isArabic() ? `${missed} من ${total} مواعيد` : `${missed} of ${total} appointments`;
  }

  protected phaseLabel(phase: QueuePhase): string {
    switch (phase) {
      case 'now':
        return this.text('dashboard.phaseNow', 'قيد الفحص', 'In progress');
      case 'next':
        return this.text('dashboard.phaseNext', 'التالي', 'Next');
      case 'wait':
        return this.text('dashboard.phaseWaiting', 'في الانتظار', 'Waiting');
      default:
        return this.text('dashboard.phaseLater', 'لاحقًا', 'Later');
    }
  }

  protected phaseBadge(phase: QueuePhase): string {
    switch (phase) {
      case 'now':
        return 'badge-success';
      case 'next':
        return 'badge-info';
      case 'wait':
        return 'badge-warning';
      default:
        return 'badge-neutral';
    }
  }

  /** "9 min ago" / "in 5 min" for the queue. */
  protected relative(minutes: number): string {
    if (minutes === 0) {
      return this.text('dashboard.nowShort', 'الآن', 'Now');
    }
    const abs = Math.abs(minutes);
    const ar = this.isArabic();
    const span = abs < 60 ? `${abs} ${ar ? 'د' : 'min'}` : `${Math.round(abs / 60)} ${ar ? 'س' : 'h'}`;

    if (minutes < 0) {
      return ar ? `منذ ${span}` : `${span} ago`;
    }
    return ar ? `بعد ${span}` : `in ${span}`;
  }

  protected loadLine(d: DoctorLoad): string {
    return this.isArabic()
      ? `${d.count} من ${d.capacity} مواعيد`
      : `${d.count} of ${d.capacity} appointments`;
  }

  protected loadNote(d: DoctorLoad): string {
    if (d.level === 'high') {
      return this.text('dashboard.loadFull', 'ممتلئ تقريبًا', 'Almost full');
    }
    if (d.level === 'mid') {
      return this.isArabic() ? `${d.free} أوقات متاحة` : `${d.free} slots free`;
    }
    return this.text('dashboard.loadOpen', 'متاح للحجز', 'Open for booking');
  }

  // -------------------------------------------------------------- actions --

  /** Manual reload from the header button; shows the loading state. */
  protected refresh(): void {
    this.load(true);
  }

  private load(showLoading: boolean): void {
    if (showLoading) {
      this.loading.set(true);
    }
    this.data.load(this.snapshot()).subscribe({
      next: (snapshot) => {
        this.snapshot.set(snapshot);
        this.now.set(new Date());
        this.updatedAt.set(new Date());
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /** Scrolls the queue so the "next" row sits about a third of the way down. */
  private revealNext(): void {
    const next = this.host.nativeElement.querySelector<HTMLElement>('.queue .q.is-next');
    const list = next?.closest<HTMLElement>('.queue');
    if (!next || !list) {
      return;
    }
    const offset = next.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = Math.max(0, list.scrollTop + offset - list.clientHeight / 3);
  }

  private isOnDay(appointment: Appointment, day: Date): boolean {
    const date = parseDate(appointment.appointmentDate);
    return date ? isSameDay(date, day) : false;
  }
}