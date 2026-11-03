import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatStepperModule } from '@angular/material/stepper';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { LocaleService } from '../../../core/i18n/locale.service';
import { NotificationsStore } from '../../../core/data/notifications.store';
import { Appointment } from '../../../core/models/appointment.model';
import { Doctor } from '../../../core/models/doctor.model';
import { Patient } from '../../../core/models/patient.model';
import { DoctorSchedule, WeekDay } from '../../../core/models/schedule.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import { PatientsService } from '../../../core/services/patients.service';
import { SchedulesService } from '../../../core/services/schedules.service';
import {
  addDays,
  formatTimeRange,
  isSameDay,
  minutesToDate,
  parseDate,
  startOfDay,
  toLocalIso,
} from '../../../core/utils/date.util';
import { SpecialtyPipe } from '../../../shared/pipes/specialty.pipe';
import { CardComponent } from '../../../shared/ui/card/card.component';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import { AvailabilityService, TimeSlot } from '../availability.service';

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

/** Days the strip generates at first; it grows as the user scrolls. */
const INITIAL_HORIZON = 90;
const HORIZON_STEP = 90;
/** Two years ahead is as far as a diary is worth scrolling. */
const MAX_HORIZON = 730;
/** Month shortcuts shown above the strip. */
const MONTH_CHIPS = 24;

const DAY_MS = 86_400_000;

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** One selectable day in the strip. */
interface DayOption {
  key: number;
  date: Date;
  weekday: string;
  dayNumber: string;
  isToday: boolean;
  freeCount: number;
  /** "6 free" / "Full", already translated. */
  label: string;
  /** Working day, but nothing left to book. */
  full: boolean;
}

/** A month marker (`day` is null) or a day in the scrolling strip. */
interface StripItem {
  key: string;
  /** `YYYY-MM`, shared by the marker and every day in that month. */
  month: string;
  label: string;
  year: string;
  day: DayOption | null;
}

interface MonthOption {
  key: string;
  label: string;
}

@Component({
  selector: 'app-appointment-form',
  imports: [
    ReactiveFormsModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatStepperModule,
    TranslatePipe,
    SpecialtyPipe,
    CardComponent,
    EmptyStateComponent,
    FieldErrorComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appointment-form.component.html',
  styleUrl: './appointment-form.component.scss',
})
export class AppointmentFormComponent {
  private readonly api = inject(AppointmentsService);
  private readonly availability = inject(AvailabilityService);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly locale = inject(LocaleService);
  private readonly notifications = inject(NotificationService);
  private readonly notificationsStore = inject(NotificationsStore);
  private readonly patientsApi = inject(PatientsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly schedulesApi = inject(SchedulesService);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly translate = inject(TranslateService);

  /** Present when rescheduling. */
  readonly id = input<string | undefined>();

  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly patients = signal<Patient[]>([]);
  protected readonly schedules = signal<DoctorSchedule[]>([]);
  protected readonly appointments = signal<Appointment[]>([]);

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);
  protected readonly patientFilter = signal('');

  protected readonly form = this.formBuilder.nonNullable.group({
    doctorId: this.formBuilder.control<number | null>(null, [Validators.required]),
    // Typing in the autocomplete puts a string in this control; only a picked option is a number.
    patientId: this.formBuilder.control<number | null>(null, [
      Validators.required,
      (control) => (typeof control.value === 'number' ? null : { required: true }),
    ]),
    date: this.formBuilder.control<Date | null>(null, [Validators.required]),
    startMinutes: this.formBuilder.control<number | null>(null, [Validators.required]),
    reason: ['', [Validators.maxLength(200)]],
  });

  /** Mirrors the reactive controls into signals so `computed` can depend on them. */
  protected readonly selectedDoctorId = signal<number | null>(null);
  protected readonly selectedPatientId = signal<number | null>(null);
  protected readonly selectedDate = signal<Date | null>(null);
  protected readonly selectedSlot = signal<number | null>(null);

  /** How many days ahead the strip has generated so far. */
  private readonly horizon = signal(INITIAL_HORIZON);

  /** The month at the start of the visible strip; highlights its chip. */
  protected readonly activeMonth = signal('');
  protected readonly atStart = signal(true);
  protected readonly atEnd = signal(false);
  protected readonly monthsAtStart = signal(true);
  protected readonly monthsAtEnd = signal(false);

  private readonly dayScroller = viewChild<ElementRef<HTMLElement>>('dayScroller');
  private readonly monthRow = viewChild<ElementRef<HTMLElement>>('monthRow');

  private scrollFrame = 0;
  /** While a month jump is animating, the strip must not re-highlight months on the way. */
  private holdActiveUntil = 0;

  protected readonly appointmentId = computed(() => {
    const raw = this.id();
    return raw ? Number(raw) : null;
  });

  protected readonly isEdit = computed(() => this.appointmentId() !== null);

  protected readonly minDate = new Date();

  constructor() {
    this.form.controls.doctorId.valueChanges.subscribe((doctorId) => {
      this.selectedDoctorId.set(doctorId);
      // A date valid for the previous doctor is rarely valid for the new one,
      // and a stale slot would submit a time this doctor does not work.
      this.form.controls.date.setValue(null);
      this.form.controls.startMinutes.setValue(null);
      this.selectedDate.set(null);
      this.selectedSlot.set(null);
      this.resetStrip();
    });

    this.form.controls.patientId.valueChanges.subscribe((value) =>
      this.selectedPatientId.set(typeof value === 'number' ? value : null)
    );

    this.form.controls.date.valueChanges.subscribe((date) => {
      this.selectedDate.set(date);
      // A date picked from the calendar may sit on a later page of the strip.
      this.revealDate(date);
      this.form.controls.startMinutes.setValue(null);
      this.selectedSlot.set(null);
    });

    this.form.controls.startMinutes.valueChanges.subscribe((value) =>
      this.selectedSlot.set(value)
    );

    // Keep the arrows, the highlighted month and the lazy loading in step with the strip
    // whenever its content changes (new doctor, more days loaded, bookings reloaded).
    effect(() => {
      this.stripItems();
      setTimeout(() => this.syncStrip());
    });

    effect(() => {
      this.monthOptions();
      setTimeout(() => this.syncMonths());
    });

    queueMicrotask(() => this.load());
  }

  // --------------------------------------------------------- derived data --

  protected readonly selectedDoctor = computed(() =>
    this.doctors().find((doctor) => doctor.id === this.selectedDoctorId()) ?? null
  );

  protected readonly selectedPatient = computed(() =>
    this.patients().find((patient) => patient.id === this.selectedPatientId()) ?? null
  );

  protected readonly filteredPatients = computed(() => {
    const term = this.patientFilter().trim().toLowerCase();
    if (!term) {
      return this.patients().slice(0, 50);
    }

    // Matches on name or phone, because reception searches by whichever the
    // caller gives them first.
    return this.patients()
      .filter(
        (patient) =>
          patient.name.toLowerCase().includes(term) ||
          patient.phone.replace(/\D/g, '').includes(term.replace(/\D/g, ''))
      )
      .slice(0, 50);
  });

  /** Working days for the chosen doctor, as a datepicker filter. */
  protected readonly dateFilter = computed(() =>
    this.availability.dateFilter(this.schedules(), this.selectedDoctorId())
  );

  protected readonly isRtl = computed(() => this.locale.isRtl());

  /**
   * Texts for the day strip.
   *
   * Each falls back to a built-in Arabic or English string when the key is not in the
   * translation catalogue, so the strip never shows a raw key like `appointments.slotsFree`.
   */
  protected readonly labels = computed(() => {
    const rtl = this.isRtl();
    const pick = (key: string, ar: string, en: string): string => {
      const value = this.translate.instant(key);
      return value && value !== key ? value : rtl ? ar : en;
    };

    return {
      chooseDay: pick('appointments.chooseDay', 'اختر اليوم', 'Choose a day'),
      otherDate: pick('appointments.otherDate', 'تاريخ آخر', 'Other date'),
      dayFull: pick('appointments.dayFull', 'ممتلئ', 'Full'),
    };
  });

  private freeLabel(count: number): string {
    const key = 'appointments.slotsFree';
    const value = this.translate.instant(key, { count });
    if (value && value !== key) {
      return value;
    }
    return this.isRtl() ? `${count} متاح` : `${count} free`;
  }

  /**
   * Every day this doctor works, from today on.
   *
   * Only working days exist here — a day the doctor is off never appears, so there
   * is nothing to grey out. A date already chosen (an appointment being edited, or a
   * far-off day picked from the calendar) is merged in so the strip can always show it.
   */
  private readonly workingDayList = computed<Date[]>(() => {
    const days = this.availability.workingDays(this.schedules(), this.selectedDoctorId());
    if (!days.size) {
      return [];
    }

    const today = startOfDay(new Date());
    const list: Date[] = [];
    for (let offset = 0; offset < this.horizon(); offset += 1) {
      const date = addDays(today, offset);
      if (days.has(date.getDay() as WeekDay)) {
        list.push(date);
      }
    }

    const selected = this.selectedDate();
    if (
      selected &&
      days.has(selected.getDay() as WeekDay) &&
      !list.some((date) => isSameDay(date, selected))
    ) {
      list.push(startOfDay(selected));
      list.sort((a, b) => a.getTime() - b.getTime());
    }

    return list;
  });

  /**
   * The strip: a month marker before the first day of each month, then that month's
   * working days with how many free slots each still has. Grows as the user scrolls.
   */
  protected readonly stripItems = computed<StripItem[]>(() => {
    const doctorId = this.selectedDoctorId();
    const schedules = this.schedules();
    const appointments = this.appointments();
    const excludeId = this.appointmentId() ?? undefined;
    const locale = this.locale.definition().locale;
    const labels = this.labels();
    const today = new Date();

    const items: StripItem[] = [];
    let lastMonth = '';

    for (const date of this.workingDayList()) {
      const month = monthKey(date);
      if (month !== lastMonth) {
        lastMonth = month;
        items.push({
          key: `m-${month}`,
          month,
          label: date.toLocaleDateString(locale, { month: 'long' }),
          year: date.toLocaleDateString(locale, { year: 'numeric' }),
          day: null,
        });
      }

      const freeCount = this.availability.slotsFor(
        date,
        doctorId,
        schedules,
        appointments,
        excludeId
      ).availableCount;

      items.push({
        key: `d-${date.getTime()}`,
        month,
        label: '',
        year: '',
        day: {
          key: date.getTime(),
          date,
          weekday: date.toLocaleDateString(locale, { weekday: 'short' }),
          dayNumber: date.toLocaleDateString(locale, { day: 'numeric' }),
          isToday: isSameDay(date, today),
          freeCount,
          label: freeCount === 0 ? labels.dayFull : this.freeLabel(freeCount),
          full: freeCount === 0,
        },
      });
    }

    return items;
  });

  /** One chip per upcoming month in which the doctor still has a working day. */
  protected readonly monthOptions = computed<MonthOption[]>(() => {
    const days = this.availability.workingDays(this.schedules(), this.selectedDoctorId());
    if (!days.size) {
      return [];
    }

    const locale = this.locale.definition().locale;
    const today = startOfDay(new Date());
    const options: MonthOption[] = [];

    for (let index = 0; index < MONTH_CHIPS; index += 1) {
      const first = new Date(today.getFullYear(), today.getMonth() + index, 1);
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
      const from = index === 0 ? today : first;

      let hasDay = false;
      for (let day = new Date(from); day <= last; day = addDays(day, 1)) {
        if (days.has(day.getDay() as WeekDay)) {
          hasDay = true;
          break;
        }
      }
      if (!hasDay) {
        continue;
      }

      const month = first.toLocaleDateString(locale, { month: 'long' });
      options.push({
        key: monthKey(first),
        // The year only where it differs from this one, so "January 2027" is unambiguous.
        label:
          first.getFullYear() === today.getFullYear()
            ? month
            : `${month} ${first.toLocaleDateString(locale, { year: 'numeric' })}`,
      });
    }

    return options;
  });

  protected readonly workingDayLabels = computed(() => {
    const days = [...this.availability.workingDays(this.schedules(), this.selectedDoctorId())];
    return days
      .sort((a, b) => a - b)
      .map((day) => this.translate.instant(`weekday.short.${day}`))
      .join(' · ');
  });

  protected readonly dayAvailability = computed(() =>
    this.availability.slotsFor(
      this.selectedDate(),
      this.selectedDoctorId(),
      this.schedules(),
      this.appointments(),
      this.appointmentId() ?? undefined
    )
  );

  /** Only what can still be booked: taken and past times are not offered at all. */
  protected readonly freeSlots = computed(() =>
    this.dayAvailability().slots.filter((slot) => slot.available)
  );

  protected readonly shiftLabel = computed(() =>
    this.dayAvailability()
      .shifts.map((shift) => formatTimeRange(shift.startTime, shift.endTime))
      .join(', ')
  );

  protected readonly selectedSlotLabel = computed(() => {
    const minutes = this.selectedSlot();
    return minutes === null
      ? null
      : (this.dayAvailability().slots.find((slot) => slot.start === minutes)?.label ?? null);
  });

  /** The chosen day in the active language, for the review panel. */
  protected readonly selectedDateLabel = computed(() => {
    const date = this.selectedDate();
    return date
      ? date.toLocaleDateString(this.locale.definition().locale, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null;
  });

  protected readonly hasDoctorsWithSchedules = computed(() =>
    this.doctors().some((doctor) =>
      this.schedules().some((schedule) => schedule.doctorId === doctor.id)
    )
  );

  // -------------------------------------------------------------- actions --

  protected pickDay(day: DayOption): void {
    // Re-picking the day already chosen would clear the time for nothing.
    if (day.full || this.isDaySelected(day.date)) {
      return;
    }
    this.form.controls.date.setValue(day.date);
    this.form.controls.date.markAsTouched();
  }

  protected isDaySelected(date: Date): boolean {
    const selected = this.selectedDate();
    return !!selected && isSameDay(selected, date);
  }

  /** Scrolls the strip by most of a screenful, towards later (+1) or earlier (-1) days. */
  protected scrollDays(direction: -1 | 1): void {
    const element = this.dayScroller()?.nativeElement;
    if (!element) {
      return;
    }
    // In a right-to-left page later days are to the left, which is negative scroll.
    const sign = this.isRtl() ? -1 : 1;
    element.scrollBy({ left: direction * sign * element.clientWidth * 0.8, behavior: 'smooth' });
  }

  /** Scrolls the month chips by most of a screenful, towards later (+1) or earlier (-1) months. */
  protected scrollMonths(direction: -1 | 1): void {
    const element = this.monthRow()?.nativeElement;
    if (!element) {
      return;
    }
    const sign = this.isRtl() ? -1 : 1;
    element.scrollBy({ left: direction * sign * element.clientWidth * 0.7, behavior: 'smooth' });
  }

  protected onMonthsScroll(): void {
    this.syncMonths();
  }

  private syncMonths(): void {
    const element = this.monthRow()?.nativeElement;
    if (!element) {
      return;
    }
    const offset = Math.abs(element.scrollLeft);
    this.monthsAtStart.set(offset < 4);
    this.monthsAtEnd.set(offset + element.clientWidth >= element.scrollWidth - 4);
  }

  protected onStripScroll(): void {
    if (this.scrollFrame) {
      return;
    }
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.syncStrip();
    });
  }

  /** Jumps the strip to the first working day of a month, loading days as far as needed. */
  protected goToMonth(key: string): void {
    const [year, month] = key.split('-').map(Number);
    const target = new Date(year, month - 1, 1);
    const ahead = Math.ceil((target.getTime() - startOfDay(new Date()).getTime()) / DAY_MS);

    if (ahead + 45 > this.horizon()) {
      this.horizon.set(Math.min(MAX_HORIZON, ahead + 60));
    }

    this.activeMonth.set(key);
    this.holdActiveUntil = Date.now() + 900;

    // Wait for the new days to render before scrolling to them.
    setTimeout(() => {
      this.dayScroller()
        ?.nativeElement.querySelector<HTMLElement>(`[data-month-start="${key}"]`)
        ?.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
    }, 60);
  }

  /** Arrows, lazy loading and the highlighted month all follow the scroll position. */
  private syncStrip(): void {
    const element = this.dayScroller()?.nativeElement;
    if (!element) {
      return;
    }

    // scrollLeft is negative in right-to-left pages; the distance is what matters.
    const offset = Math.abs(element.scrollLeft);
    const remaining = element.scrollWidth - (offset + element.clientWidth);

    this.atStart.set(offset < 4);
    this.atEnd.set(remaining < 4 && this.horizon() >= MAX_HORIZON);

    if (remaining < element.clientWidth * 1.5 && this.horizon() < MAX_HORIZON) {
      this.horizon.update((days) => Math.min(MAX_HORIZON, days + HORIZON_STEP));
    }

    if (Date.now() < this.holdActiveUntil) {
      return;
    }

    // The first item whose leading edge is on screen decides which month is "current".
    const bounds = element.getBoundingClientRect();
    const rtl = this.isRtl();
    const first = Array.from(element.children).find((child) => {
      const box = child.getBoundingClientRect();
      return rtl ? box.right <= bounds.right + 2 : box.left >= bounds.left - 2;
    }) as HTMLElement | undefined;

    const month = first?.dataset['month'];
    if (month && month !== this.activeMonth()) {
      this.activeMonth.set(month);
      this.monthRow()
        ?.nativeElement.querySelector<HTMLElement>(`[data-chip="${month}"]`)
        ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  private resetStrip(): void {
    this.horizon.set(INITIAL_HORIZON);
    this.activeMonth.set('');
    const element = this.dayScroller()?.nativeElement;
    if (element) {
      element.scrollLeft = 0;
    }
  }

  /** Makes sure the strip reaches `date` and brings it into view if it is off screen. */
  private revealDate(date: Date | null): void {
    if (!date) {
      return;
    }

    const ahead = Math.ceil((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / DAY_MS);
    if (ahead + 14 > this.horizon()) {
      this.horizon.set(Math.min(MAX_HORIZON, ahead + 45));
    }

    this.activeMonth.set(monthKey(date));

    setTimeout(() => {
      const scroller = this.dayScroller()?.nativeElement;
      const target = scroller?.querySelector<HTMLElement>(
        `[data-day="${startOfDay(date).getTime()}"]`
      );
      if (!scroller || !target) {
        return;
      }

      const bounds = scroller.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const visible = box.left >= bounds.left && box.right <= bounds.right;
      if (!visible) {
        target.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      }
    }, 60);
  }

  protected selectSlot(slot: TimeSlot): void {
    if (!slot.available) {
      return;
    }
    this.form.controls.startMinutes.setValue(slot.start);
  }

  protected onPatientInput(value: string): void {
    this.patientFilter.set(value);
  }

  protected displayPatient = (patientId: number | string | null): string => {
    const patient = this.patients().find((entry) => entry.id === patientId);
    return patient ? `${patient.name} — ${patient.phone}` : '';
  };

  protected submit(): void {
    this.submitted.set(true);

    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { doctorId, patientId, date, startMinutes, reason } = this.form.getRawValue();

    // Re-check at submit time: another workstation may have taken this slot
    // while the form was open, and the API has no uniqueness constraint to
    // catch it.
    const stillFree = this.availability.isSlotAvailable(
      date!,
      startMinutes!,
      doctorId!,
      this.schedules(),
      this.appointments(),
      this.appointmentId() ?? undefined
    );

    if (!stillFree) {
      this.form.controls.startMinutes.setErrors({ slotTaken: true });
      this.notifications.error(this.translate.instant('validation.slotTaken'));
      return;
    }

    this.saving.set(true);
    const appointmentDate = toLocalIso(minutesToDate(startMinutes!, date!));
    // The reason for the visit is now persisted. It was collected and silently
    // discarded before, because the API had nowhere to put it.
    const payload = {
      patientId: patientId!,
      doctorId: doctorId!,
      appointmentDate,
      // The length of the slot the user actually picked. Omitted before, so the
      // API fell back to its 30-minute default and a clinic booking in 45-minute
      // slots stored an appointment ending a quarter of an hour early — with the
      // overlap check then guarding the wrong interval.
      durationMinutes: this.settings.slotMinutes(),
      notes: reason.trim() || null,
    };
    const id = this.appointmentId();

    const request = id ? this.api.updateAppointment(id, payload) : this.api.createAppointment(payload);

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.notifications.success(
          this.translate.instant(id ? 'appointments.updated' : 'appointments.created'),
          {
            kind: 'calendar',
            detail: [
              this.selectedPatient()?.name,
              this.selectedDoctor()?.name,
              this.selectedSlotLabel(),
            ]
              .filter(Boolean)
              .join(' · '),
          }
        );

        this.notificationsStore.push({
          title: this.translate.instant(id ? 'appointments.updated' : 'appointments.created'),
          body: `${this.selectedPatient()?.name ?? ''} · ${this.selectedDoctor()?.name ?? ''} · ${
            this.selectedSlotLabel() ?? ''
          }`,
          icon: 'appointments',
          tone: 'success',
          route: '/appointments',
        });

        void this.router.navigate(['/appointments']);
      },
      error: () => this.saving.set(false),
    });
  }

  protected cancel(): void {
    void this.router.navigate(['/appointments']);
  }

  private load(): void {
    this.loading.set(true);

    forkJoin({
      doctors: this.doctorsApi
        .getDoctors({ pageIndex: 1, pageSize: 200 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      patients: this.patientsApi
        .getPatients({ pageIndex: 1, pageSize: 500 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      schedules: this.schedulesApi
        .getSchedules({ pageIndex: 1, pageSize: 500 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      appointments: this.api
        .getAppointments({ pageIndex: 1, pageSize: 500 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
    }).subscribe({
      next: ({ doctors, patients, schedules, appointments }) => {
        this.doctors.set(doctors.data as Doctor[]);
        this.patients.set(patients.data as Patient[]);
        this.schedules.set(schedules.data as DoctorSchedule[]);
        this.appointments.set(appointments.data as Appointment[]);
        this.loading.set(false);

        this.applyPrefill();
      },
      error: () => this.loading.set(false),
    });
  }

  /** Seeds the form from `?patientId=` or from the appointment being edited. */
  private applyPrefill(): void {
    const id = this.appointmentId();

    if (id !== null) {
      const existing = this.appointments().find((appointment) => appointment.id === id);
      if (existing) {
        const when = parseDate(existing.appointmentDate);

        // The ids are used directly. They used to be missing from the list
        // response, so this fell back to matching doctors and patients by name
        // — which silently picked the wrong person whenever two shared one.
        this.form.patchValue({
          doctorId: existing.doctorId,
          patientId: existing.patientId,
          reason: existing.notes ?? '',
        });

        if (when) {
          this.form.controls.date.setValue(when);
          this.form.controls.startMinutes.setValue(when.getHours() * 60 + when.getMinutes());
        }
      }
      return;
    }

    const params = this.route.snapshot.queryParamMap;

    const patientId = Number(params.get('patientId'));
    if (patientId) {
      this.form.controls.patientId.setValue(patientId);
    }

    // Seeded from the calendar, so booking from a day already on screen does not
    // start by re-picking that day. Set before the date: the doctor's
    // `valueChanges` handler clears the date, which would undo the order.
    const doctorId = Number(params.get('doctorId'));
    if (doctorId && this.doctors().some((doctor) => doctor.id === doctorId)) {
      this.form.controls.doctorId.setValue(doctorId);
    }

    const date = parseDate(params.get('date'));
    // Only when it is a day this doctor works — otherwise the slot list would
    // open empty and look broken rather than unavailable.
    if (date && doctorId && this.dateFilter()(date)) {
      this.form.controls.date.setValue(date);
    }
  }
}