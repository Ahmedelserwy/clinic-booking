import { CdkDragEnd, DragDropModule } from '@angular/cdk/drag-drop';
import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { DateAdapter } from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { LocaleService } from '../../../core/i18n/locale.service';
import { SpecialtyService } from '../../../core/i18n/specialty.service';
import { Appointment } from '../../../core/models/appointment.model';
import { Doctor } from '../../../core/models/doctor.model';
import { DoctorSchedule, WeekDay } from '../../../core/models/schedule.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import { SchedulesService } from '../../../core/services/schedules.service';
import { APPOINTMENT_STATUS_LEGEND } from '../../../core/utils/appointment-status.util';
import { appointmentDuration, appointmentStart } from '../../../core/utils/appointment-time.util';
import {
  addDays,
  dateToMinutes,
  isSameDay,
  minutesToDate,
  startOfDay,
  timeToMinutes,
  toDateOnly,
  toLocalIso,
} from '../../../core/utils/date.util';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import { AppointmentBlockComponent } from './appointment-block.component';
import {
  AppointmentQuickViewComponent,
  AppointmentQuickViewData,
  AppointmentQuickViewResult,
} from './appointment-quick-view.component';
import {
  SLOT_HEIGHT_PX,
  breakIntervals,
  buildSlots,
  mergeIntervals,
  minutesToPx,
  positionLane,
  pxToSnappedMinutes,
  visibleRange,
  withinIntervals,
} from './calendar-layout';
import { DoctorResourceProvider } from './calendar-resources';
import {
  CalendarItem,
  CalendarLane,
  CalendarView,
  PositionedItem,
  TimeInterval,
} from './calendar.model';

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

/** One request per visible range; 500 is the API's ceiling for a range read. */
const RANGE_PAGE_SIZE = 500;

/** How often the "now" line moves. A minute is finer than anyone reads a diary. */
const NOW_TICK_MS = 30_000;

/** The waiting-room screen's route. It lives outside the shell, so it opens full-screen. */
const QUEUE_DISPLAY_ROUTE = '/queue-display';

interface LaneBands {
  working: { topPx: number; heightPx: number }[];
  breaks: { topPx: number; heightPx: number }[];
}

/**
 * The clinic diary.
 *
 * Replaces the appointments table. A table can answer "what is booked" but not
 * the question the front desk actually asks all day — "where is there a gap" —
 * because a list has no shape. This draws the day as it is: time down the side,
 * one column per bookable resource, and every appointment as a box whose height
 * is its duration.
 *
 * Three rules shaped the implementation:
 *
 *  - **Nothing is invented.** The grid renders the API's appointments, the API's
 *    statuses and the doctors' published `DoctorSchedule` rows. Where the design
 *    reference has a concept this system does not have — treatment chairs, a
 *    waiting queue — the UI abstraction exists but no fake data does.
 *  - **The server is the authority.** A drag does not move an appointment; it
 *    asks the API to, and the block returns to where it was unless the API says
 *    yes. Both booking rules (inside published hours, no overlap) live there.
 *  - **One fetch per visible range.** Reference data — doctors, schedules — is
 *    read once. Changing the date refetches appointments for that date and
 *    nothing else; changing a filter refetches nothing at all.
 *
 * Built by hand rather than on a calendar library: the layout needed is a
 * resource grid with RTL support, design-token theming and schedule-aware
 * shading, and every library that does that arrives with its own styling system
 * to fight and ~100 kB to ship.
 */
@Component({
  selector: 'app-appointment-calendar',
  imports: [
    DragDropModule,
    RouterLink,
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    TranslatePipe,
    AppointmentBlockComponent,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appointment-calendar.component.html',
  styleUrl: './appointment-calendar.component.scss',
})
export class AppointmentCalendarComponent {
  private readonly api = inject(AppointmentsService);
  private readonly dateAdapter = inject<DateAdapter<Date>>(DateAdapter);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LocaleService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly schedulesApi = inject(SchedulesService);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly specialty = inject(SpecialtyService);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  // ------------------------------------------------------------------ state --

  protected readonly selectedDate = signal(startOfDay(new Date()));
  protected readonly view = signal<CalendarView>('day');
  protected readonly doctorId = signal<number | 'all'>('all');
  protected readonly specialtyFilter = signal<string | 'all'>('all');

  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly schedules = signal<DoctorSchedule[]>([]);
  protected readonly appointments = signal<Appointment[]>([]);

  protected readonly loadingReference = signal(true);
  protected readonly loadingAppointments = signal(true);
  protected readonly failed = signal(false);

  private readonly now = signal(new Date());
  /** Only the first successful load steers the scroll position. */
  private hasAutoScrolled = false;

  protected readonly legend = APPOINTMENT_STATUS_LEGEND;

  /**
   * Grid metrics as ready-made CSS strings.
   *
   * Angular's `.px` unit suffix is not applied to custom properties — the value
   * lands unitless and the declaration is dropped — so these are formatted here
   * rather than in the template.
   */
  protected readonly slotHeightCss = `${SLOT_HEIGHT_PX}px`;

  protected readonly loading = computed(
    () => this.loadingReference() || this.loadingAppointments()
  );

  /**
   * Whether the user may write to an appointment.
   *
   * Both halves are required. The permission is this app's own model, editable on
   * the Roles screen; the role is what the API enforces — `PUT` and `DELETE` on
   * `/Appointments` are `[Authorize(Roles = "Admin,Doctor")]`. Showing a
   * receptionist a Reschedule button they hold the permission for would only
   * hand them a 403.
   */
  private readonly hasWriteRole = computed(() =>
    this.permissions
      .roleNames()
      .some((role) => role.toLowerCase() === 'admin' || role.toLowerCase() === 'doctor')
  );

  protected readonly canEdit = computed(
    () => this.permissions.can('appointments.edit') && this.hasWriteRole()
  );

  protected readonly canCancel = computed(
    () => this.permissions.can('appointments.delete') && this.hasWriteRole()
  );

  // ---------------------------------------------------------------- range --

  /** Sunday, Monday or Saturday depending on the language — as the datepicker does. */
  private readonly weekStart = computed(() => {
    this.locale.current();
    const date = this.selectedDate();
    const firstDay = this.dateAdapter.getFirstDayOfWeek();
    const shift = (date.getDay() - firstDay + 7) % 7;
    return startOfDay(addDays(date, -shift));
  });

  protected readonly rangeStart = computed(() =>
    this.view() === 'day' ? startOfDay(this.selectedDate()) : this.weekStart()
  );

  protected readonly rangeEnd = computed(() =>
    addDays(this.rangeStart(), this.view() === 'day' ? 1 : 7)
  );

  /** The days the grid covers — one in day view, seven in week view. */
  private readonly rangeDays = computed(() => {
    const start = this.rangeStart();
    const count = this.view() === 'day' ? 1 : 7;
    return Array.from({ length: count }, (_, index) => addDays(start, index));
  });

  // -------------------------------------------------------------- filters --

  private readonly doctorsById = computed(
    () => new Map(this.doctors().map((doctor) => [doctor.id, doctor]))
  );

  protected readonly specialtyOptions = computed(() =>
    this.specialty.options(this.doctors().map((doctor) => doctor.specialization))
  );

  /** Doctors matching the speciality filter — the pool the doctor list offers. */
  protected readonly doctorOptions = computed(() => {
    const speciality = this.specialtyFilter();
    const doctors =
      speciality === 'all'
        ? this.doctors()
        : this.doctors().filter((doctor) => doctor.specialization === speciality);

    return [...doctors].sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly hasFilters = computed(
    () => this.doctorId() !== 'all' || this.specialtyFilter() !== 'all'
  );

  /**
   * The appointments the filters let through.
   *
   * Applied to the range already fetched rather than by refetching: the range is
   * one day or one week, the filters are a doctor and a speciality, and a round
   * trip to re-ask the server for a subset of rows already in memory would add
   * latency to every dropdown change for no new information.
   */
  private readonly visibleAppointments = computed(() => {
    const doctorId = this.doctorId();
    const speciality = this.specialtyFilter();
    const byId = this.doctorsById();

    return this.appointments().filter((appointment) => {
      if (doctorId !== 'all' && appointment.doctorId !== doctorId) {
        return false;
      }

      if (speciality !== 'all') {
        const doctor = byId.get(appointment.doctorId);
        // An appointment whose doctor is not in the loaded set cannot be shown
        // to match a speciality filter — better hidden than wrongly included.
        if (!doctor || doctor.specialization !== speciality) {
          return false;
        }
      }

      return true;
    });
  });

  // ---------------------------------------------------------------- lanes --

  private readonly resourceProvider = computed(
    () => new DoctorResourceProvider(this.laneDoctors(), this.specialty.label())
  );

  /**
   * The doctors that earn a column today.
   *
   * A named doctor always gets one, even on a day they do not work — that is
   * precisely the answer someone selecting them is looking for. Otherwise a
   * column appears for a doctor who either has a shift or has an appointment, so
   * a clinic with thirty doctors does not render thirty empty columns for the
   * four who are in on a Friday.
   */
  private readonly laneDoctors = computed(() => {
    const selected = this.doctorId();
    if (selected !== 'all') {
      const doctor = this.doctorsById().get(selected);
      return doctor ? [doctor] : [];
    }

    const date = this.selectedDate();
    const weekday = date.getDay() as WeekDay;
    const working = new Set(
      this.schedules()
        .filter((schedule) => schedule.weekDay === weekday)
        .map((schedule) => schedule.doctorId)
    );
    const booked = new Set(
      this.visibleAppointments()
        .filter((appointment) => {
          const start = appointmentStart(appointment);
          return start ? isSameDay(start, date) : false;
        })
        .map((appointment) => appointment.doctorId)
    );

    return this.doctorOptions().filter(
      (doctor) => working.has(doctor.id) || booked.has(doctor.id)
    );
  });

  /**
   * Today as `YYYY-MM-DD`.
   *
   * The clock ticks every 30 seconds to move the "now" line, and `lanes` only
   * cares which *day* is today. Depending on the date string rather than the
   * Date means the lane chain — and everything downstream of it: items, box
   * positions, shading — is invalidated once a day instead of twice a minute.
   */
  private readonly todayKey = computed(() => toDateOnly(this.now()));

  protected readonly lanes = computed<CalendarLane[]>(() => {
    if (this.view() === 'day') {
      const weekday = this.selectedDate().getDay() as WeekDay;

      return this.resourceProvider()
        .resources()
        .map((resource) => ({
          id: resource.id,
          label: resource.name,
          sublabel: resource.sublabel,
          date: null,
          resource,
          isToday: false,
          workingIntervals: this.intervalsFor(resource.doctorId, weekday),
        }));
    }

    const doctorIds = this.doctorOptions().map((doctor) => doctor.id);
    const todayKey = this.todayKey();

    return this.rangeDays().map((date) => ({
      id: `day-${toDateOnly(date)}`,
      label: this.formatWeekday(date),
      sublabel: this.formatDayNumber(date),
      date,
      resource: null,
      isToday: toDateOnly(date) === todayKey,
      // The union of every visible doctor's hours: the column is "the clinic on
      // Tuesday", so it is open whenever any of them is.
      workingIntervals: mergeIntervals(
        doctorIds.flatMap((id) => this.intervalsFor(id, date.getDay() as WeekDay))
      ),
    }));
  });

  // ---------------------------------------------------------------- items --

  private readonly items = computed<CalendarItem[]>(() => {
    const provider = this.resourceProvider();
    const isWeek = this.view() === 'week';
    const laneIds = new Set(this.lanes().map((lane) => lane.id));
    const fallback = this.settings.slotMinutes();

    const items: CalendarItem[] = [];

    for (const appointment of this.visibleAppointments()) {
      const start = appointmentStart(appointment);
      if (!start) {
        continue;
      }

      const laneId = isWeek ? `day-${toDateOnly(start)}` : provider.resourceIdOf(appointment);
      if (!laneId || !laneIds.has(laneId)) {
        continue;
      }

      const startMinutes = dateToMinutes(start);
      const durationMinutes = appointmentDuration(appointment, fallback);

      items.push({
        appointment,
        laneId,
        startMinutes,
        endMinutes: startMinutes + durationMinutes,
        durationMinutes,
        date: startOfDay(start),
      });
    }

    return items;
  });

  protected readonly isEmpty = computed(() => !this.loading() && this.items().length === 0);

  // ------------------------------------------------------------- geometry --

  protected readonly gridRange = computed<TimeInterval>(() => {
    const { openingMinutes, closingMinutes } = this.settings.settings();

    return visibleRange(
      this.lanes().flatMap((lane) => lane.workingIntervals),
      this.items(),
      { start: openingMinutes, end: closingMinutes }
    );
  });

  protected readonly slots = computed(() => {
    const { start, end } = this.gridRange();
    return buildSlots(start, end);
  });

  protected readonly gridHeightPx = computed(() => this.slots().length * SLOT_HEIGHT_PX);

  protected readonly gridHeightCss = computed(() => `${this.gridHeightPx()}px`);

  protected readonly laneCountCss = computed(() => String(this.lanes().length));

  /** Blocks resolved per lane, so the template never recomputes while rendering. */
  protected readonly positionedByLane = computed(() => {
    const rangeStart = this.gridRange().start;
    const byLane = new Map<string, CalendarItem[]>();

    for (const item of this.items()) {
      const bucket = byLane.get(item.laneId);
      if (bucket) {
        bucket.push(item);
      } else {
        byLane.set(item.laneId, [item]);
      }
    }

    const positioned = new Map<string, PositionedItem[]>();
    for (const [laneId, laneItems] of byLane) {
      positioned.set(laneId, positionLane(laneItems, rangeStart));
    }

    return positioned;
  });

  /** Working and break shading, in pixels, per lane. */
  protected readonly bandsByLane = computed(() => {
    const { start, end } = this.gridRange();
    const bands = new Map<string, LaneBands>();

    const toBox = (interval: TimeInterval): { topPx: number; heightPx: number } => {
      const from = Math.max(interval.start, start);
      const to = Math.min(interval.end, end);
      return { topPx: minutesToPx(from - start), heightPx: Math.max(minutesToPx(to - from), 0) };
    };

    for (const lane of this.lanes()) {
      const working = mergeIntervals(lane.workingIntervals);
      bands.set(lane.id, {
        working: working.filter((i) => i.end > start && i.start < end).map(toBox),
        breaks: breakIntervals(working)
          .filter((i) => i.end > start && i.start < end)
          .map(toBox),
      });
    }

    return bands;
  });

  protected readonly nowOffsetPx = computed(() => {
    if (this.view() !== 'day') {
      return null;
    }

    const now = this.now();
    if (!isSameDay(now, this.selectedDate())) {
      return null;
    }

    const minutes = dateToMinutes(now);
    const { start, end } = this.gridRange();
    if (minutes < start || minutes > end) {
      return null;
    }

    return minutesToPx(minutes - start);
  });

  protected readonly nowLabel = computed(() => this.formatTime(this.now()));

  // ---------------------------------------------------------------- chrome --

  protected readonly isRtl = computed(() => this.locale.isRtl());

  protected readonly headlineDate = computed(() => {
    const locale = this.locale.definition().locale;

    if (this.view() === 'day') {
      return this.selectedDate().toLocaleDateString(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }

    const start = this.rangeStart();
    const end = addDays(this.rangeEnd(), -1);
    const sameMonth = start.getMonth() === end.getMonth();

    const from = start.toLocaleDateString(locale, {
      day: 'numeric',
      ...(sameMonth ? {} : { month: 'long' }),
    });
    const to = end.toLocaleDateString(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    return `${from} – ${to}`;
  });

  protected readonly isToday = computed(
    () => toDateOnly(this.selectedDate()) === this.todayKey()
  );

  constructor() {
    this.loadReferenceData();

    // The range is the only thing a fetch depends on. `untracked` keeps the
    // filters, the clock and the loading flags out of it, so changing a
    // dropdown re-renders from memory instead of hitting the API.
    effect(() => {
      const from = this.rangeStart();
      const to = this.rangeEnd();
      untracked(() => this.loadAppointments(from, to));
    });

    const ticker = setInterval(() => this.now.set(new Date()), NOW_TICK_MS);
    this.destroyRef.onDestroy(() => clearInterval(ticker));

    // Open on the working day rather than at the top of the grid.
    effect(() => {
      const offset = this.nowOffsetPx();
      const ready = !this.loading();
      const element = this.scroller()?.nativeElement;

      if (!ready || !element || this.hasAutoScrolled || !this.slots().length) {
        return;
      }

      this.hasAutoScrolled = true;
      element.scrollTop = offset === null ? 0 : Math.max(0, offset - SLOT_HEIGHT_PX * 2);
    });
  }

  // --------------------------------------------------------------- actions --

  protected today(): void {
    this.selectedDate.set(startOfDay(new Date()));
  }

  protected step(direction: -1 | 1): void {
    const days = this.view() === 'day' ? 1 : 7;
    this.selectedDate.update((date) => startOfDay(addDays(date, direction * days)));
  }

  protected onDatePicked(date: Date | null): void {
    if (date) {
      this.selectedDate.set(startOfDay(date));
    }
  }

  protected setView(view: CalendarView): void {
    this.view.set(view);
    this.hasAutoScrolled = false;
  }

  protected onDoctor(value: number | 'all'): void {
    this.doctorId.set(value);
  }

  protected onSpecialty(value: string | 'all'): void {
    this.specialtyFilter.set(value);

    // A doctor outside the new speciality would leave the grid empty with both
    // filters looking valid — confusing enough that it is worth clearing.
    const doctorId = this.doctorId();
    if (doctorId !== 'all') {
      const doctor = this.doctorsById().get(doctorId);
      if (!doctor || (value !== 'all' && doctor.specialization !== value)) {
        this.doctorId.set('all');
      }
    }
  }

  protected clearFilters(): void {
    this.doctorId.set('all');
    this.specialtyFilter.set('all');
  }

  /** Prefills the existing booking form with the day (and doctor) on screen. */
  protected newAppointmentParams(): Record<string, string> {
    const params: Record<string, string> = { date: toDateOnly(this.selectedDate()) };
    const doctorId = this.doctorId();
    if (doctorId !== 'all') {
      params['doctorId'] = String(doctorId);
    }
    return params;
  }

  /**
   * Opens the waiting-room screen in a new tab.
   *
   * It used to open a dialog listing the day's Pending bookings. The patient-facing
   * queue screen replaces that: it is a separate full-screen page meant for a TV
   * or a second monitor, so it has to be its own tab rather than a popup over
   * this one. The route sits outside the shell layout, so the tab has no sidebar.
   *
   * The name `openWaitingList` is kept so the template binding is unchanged.
   */
  protected openWaitingList(): void {
    const url = this.router.serializeUrl(this.router.createUrlTree([QUEUE_DISPLAY_ROUTE]));
    window.open(url, '_blank');
  }

  protected openAppointment(appointment: Appointment): void {
    const doctor = this.doctorsById().get(appointment.doctorId);

    this.dialog
      .open<AppointmentQuickViewComponent, AppointmentQuickViewData, AppointmentQuickViewResult>(
        AppointmentQuickViewComponent,
        {
          data: {
            appointment,
            fallbackDurationMinutes: this.settings.slotMinutes(),
            specialization: doctor?.specialization ?? null,
            canEdit: this.canEdit(),
            canCancel: this.canCancel(),
          },
          width: '520px',
          maxWidth: '94vw',
        }
      )
      .afterClosed()
      .subscribe((changed) => {
        if (changed) {
          this.reloadAppointments();
        }
      });
  }

  protected reloadAppointments(): void {
    this.loadAppointments(this.rangeStart(), this.rangeEnd());
  }

  protected retry(): void {
    if (!this.doctors().length) {
      this.loadReferenceData();
    }
    this.reloadAppointments();
  }

  // ------------------------------------------------------------ drag & drop --

  protected canDrag(appointment: Appointment): boolean {
    // A finished or cancelled visit has no slot left to move.
    return (
      this.canEdit() && appointment.status !== 'Completed' && appointment.status !== 'Cancelled'
    );
  }

  /**
   * Rescheduling by drag.
   *
   * The block is snapped back first, unconditionally: the calendar renders from
   * the appointments signal, and nothing writes to that signal until the API has
   * confirmed the move. A rejected drag therefore leaves the screen exactly as it
   * was, rather than showing a move that did not happen.
   *
   * The working-hours check here is a courtesy — it avoids a round trip for a
   * drop that is obviously outside the rota. The API re-checks it, along with the
   * overlap rule this cannot see, and its answer is the one that counts.
   */
  protected onDragEnded(event: CdkDragEnd, item: PositionedItem): void {
    event.source.reset();

    const laneId = this.laneIdAt(event.event) ?? item.laneId;
    const lane = this.lanes().find((candidate) => candidate.id === laneId);
    if (!lane) {
      return;
    }

    const { start, end } = this.gridRange();
    const target = start + pxToSnappedMinutes(item.topPx + event.distance.y);
    const startMinutes = Math.min(Math.max(target, start), Math.max(end - item.durationMinutes, start));

    const date = lane.date ?? this.selectedDate();
    const doctorId = lane.resource?.doctorId ?? item.appointment.doctorId;

    const unmoved =
      startMinutes === item.startMinutes &&
      doctorId === item.appointment.doctorId &&
      isSameDay(date, item.date);

    if (unmoved) {
      return;
    }

    const intervals = this.intervalsFor(doctorId, date.getDay() as WeekDay);
    if (!withinIntervals(intervals, startMinutes, startMinutes + item.durationMinutes)) {
      this.notifications.error(this.translate.instant('validation.outsideWorkingHours'));
      return;
    }

    const startsAt = toLocalIso(minutesToDate(startMinutes, date));

    this.api
      .reschedule(item.appointment, startsAt, this.settings.slotMinutes(), doctorId)
      .subscribe({
        next: () => {
          this.notifications.success(this.translate.instant('appointments.updated'));
          this.reloadAppointments();
        },
        // The error interceptor surfaces the API's reason (outside working
        // hours / slot taken); the grid simply stays as it was.
        error: () => undefined,
      });
  }

  /** The lane under the pointer when a drag was released. */
  private laneIdAt(event: MouseEvent | TouchEvent): string | null {
    const point =
      'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent);
    if (!point) {
      return null;
    }

    // The dragged block sets `pointer-events: none` while dragging, so this hits
    // the lane underneath rather than the block itself.
    const element = this.document.elementFromPoint(point.clientX, point.clientY);
    return element?.closest<HTMLElement>('[data-lane-id]')?.dataset['laneId'] ?? null;
  }

  // ----------------------------------------------------------------- helpers --

  protected blocksFor(laneId: string): PositionedItem[] {
    return this.positionedByLane().get(laneId) ?? [];
  }

  protected bandsFor(laneId: string): LaneBands {
    return this.bandsByLane().get(laneId) ?? { working: [], breaks: [] };
  }

  protected slotLabel(minutes: number): string {
    return this.formatTime(minutesToDate(minutes));
  }

  /** Only labels on the hour, so the half-hour gridline stays uncluttered. */
  protected isHour(minutes: number): boolean {
    return minutes % 60 === 0;
  }

  protected trackSlot(_: number, minutes: number): number {
    return minutes;
  }

  /** The doctor's shifts on a weekday, as minute ranges. */
  private intervalsFor(doctorId: number | null, weekday: WeekDay): TimeInterval[] {
    if (doctorId === null) {
      return [];
    }

    return this.schedules()
      .filter((schedule) => schedule.doctorId === doctorId && schedule.weekDay === weekday)
      .map((schedule) => ({
        start: timeToMinutes(schedule.startTime),
        end: timeToMinutes(schedule.endTime),
      }))
      .filter((interval) => interval.end > interval.start);
  }

  private formatTime(date: Date): string {
    // 12-hour everywhere, as the rest of the app pins it; Arabic still gets its
    // own ص/م markers because only the hour cycle is forced.
    return date.toLocaleTimeString(this.locale.definition().locale, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  private formatWeekday(date: Date): string {
    return date.toLocaleDateString(this.locale.definition().locale, { weekday: 'short' });
  }

  private formatDayNumber(date: Date): string {
    return date.toLocaleDateString(this.locale.definition().locale, {
      day: 'numeric',
      month: 'short',
    });
  }

  // -------------------------------------------------------------- loading --

  /**
   * Doctors and schedules, once.
   *
   * These do not change when the user pages through the diary, and refetching
   * them on every date change was the single biggest source of wasted requests
   * in the screen this replaces.
   */
  private loadReferenceData(): void {
    this.loadingReference.set(true);

    forkJoin({
      doctors: this.doctorsApi
        .getDoctors({ pageIndex: 1, pageSize: 200 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      schedules: this.schedulesApi
        .getSchedules({ pageIndex: 1, pageSize: 500 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
    }).subscribe({
      next: ({ doctors, schedules }) => {
        this.doctors.set(doctors.data as Doctor[]);
        this.schedules.set(schedules.data as DoctorSchedule[]);
        this.loadingReference.set(false);
      },
      error: () => {
        this.loadingReference.set(false);
        this.failed.set(true);
      },
    });
  }

  private loadAppointments(from: Date, to: Date): void {
    this.loadingAppointments.set(true);
    this.failed.set(false);

    this.api
      .getAppointments({
        pageIndex: 1,
        pageSize: RANGE_PAGE_SIZE,
        from: toLocalIso(from),
        to: toLocalIso(to),
        sort: 'Ascending',
      })
      .subscribe({
        next: (page) => {
          this.appointments.set(page.data as Appointment[]);
          this.loadingAppointments.set(false);
        },
        error: (error: unknown) => {
          this.appointments.set([]);
          this.loadingAppointments.set(false);
          // A 404 means "nothing booked", not "the diary is broken" — several of
          // this API's list endpoints answer an empty collection that way. A day
          // with no appointments must read as an empty day, with the grid and
          // the working hours still drawn, not as a failure with a retry button.
          this.failed.set(!isNotFound(error));
        },
      });
  }

  /** Skeleton rows while the first fetch is in flight. */
  protected readonly skeletonRows = Array.from({ length: 8 }, (_, index) => index);
}

function isNotFound(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status === 404;
}
