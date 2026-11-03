import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { Doctor } from '../../../core/models/doctor.model';
import { DoctorSchedule, WEEK_DAYS, WeekDay } from '../../../core/models/schedule.model';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import { SchedulesService } from '../../../core/services/schedules.service';
import { formatTime12, minutesToTimeSpan, timeToMinutes } from '../../../core/utils/date.util';
import { CardComponent } from '../../../shared/ui/card/card.component';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import {
  ScheduleDialogData,
  ScheduleFormDialogComponent,
} from '../schedule-form-dialog/schedule-form-dialog.component';

type DayPartKey = 'morning' | 'noon' | 'evening' | 'night';

/** A slice of the day. Times are minutes from midnight. */
interface DayPart {
  key: DayPartKey;
  start: number;
  end: number;
  /** What the form is pre-filled with when the user clicks an empty cell of this part. */
  presetStart: number;
  presetEnd: number;
}

/**
 * The four slices together cover the whole 24 hours, so a shift is never
 * dropped from the matrix whatever time it starts or ends.
 */
const DAY_PARTS: readonly DayPart[] = [
  { key: 'morning', start: 0, end: 12 * 60, presetStart: 9 * 60, presetEnd: 12 * 60 },
  { key: 'noon', start: 12 * 60, end: 17 * 60, presetStart: 12 * 60, presetEnd: 17 * 60 },
  { key: 'evening', start: 17 * 60, end: 21 * 60, presetStart: 17 * 60, presetEnd: 21 * 60 },
  { key: 'night', start: 21 * 60, end: 24 * 60, presetStart: 21 * 60, presetEnd: 23 * 60 + 30 },
];

/** Number of doctor colours defined in the stylesheet (`--doc-0` … `--doc-5`). */
const PALETTE_SIZE = 6;

interface ShiftChip {
  schedule: DoctorSchedule;
  doctorName: string;
  initial: string;
  color: number;
  /** The part of the shift that falls inside this cell, e.g. "12:30–5 PM". */
  label: string;
  /** Doctor and the full, unclipped shift. */
  tooltip: string;
}

/**
 * covered – at least one doctor works in this part of the day
 * gap     – nobody does, although the clinic is open before and/or after it
 * off     – nobody works on this day at all
 * closed  – nobody works, and the clinic is not open around this part either
 */
type CellState = 'covered' | 'gap' | 'off' | 'closed';

interface PartCell {
  weekDay: WeekDay;
  state: CellState;
  chips: ShiftChip[];
}

interface PartRow {
  part: DayPart;
  range: string;
  cells: PartCell[];
}

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

/**
 * The weekly coverage matrix.
 *
 * Rows are the parts of the day, columns are the weekdays, and every cell lists
 * each doctor working then together with their own time. It answers "who is in,
 * and when?" in one look, and "is anyone covering Thursday evening?" without
 * counting. An empty cell is also the button that fills it.
 */
@Component({
  selector: 'app-schedule-list',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    TranslatePipe,
    CardComponent,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schedule-list.component.html',
  styleUrl: './schedule-list.component.scss',
})
export class ScheduleListComponent {
  private readonly api = inject(SchedulesService);
  private readonly dialog = inject(MatDialog);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly schedules = signal<DoctorSchedule[]>([]);
  protected readonly loading = signal(true);
  protected readonly doctorFilter = signal<number | 'all'>('all');

  /** A doctor keeps the same colour whatever the filter, so it never "changes" on screen. */
  private readonly colorByDoctor = computed(
    () =>
      new Map<number, number>(
        this.doctors().map((doctor, index): [number, number] => [doctor.id, index % PALETTE_SIZE])
      )
  );

  private readonly visibleDoctors = computed(() => {
    const filter = this.doctorFilter();
    return filter === 'all'
      ? this.doctors()
      : this.doctors().filter((doctor) => doctor.id === filter);
  });

  protected readonly rows = computed<PartRow[]>(() => {
    const doctorsById = new Map(this.visibleDoctors().map((doctor) => [doctor.id, doctor]));
    const colors = this.colorByDoctor();

    const shifts = this.schedules()
      .filter((schedule) => doctorsById.has(schedule.doctorId))
      .map((schedule) => ({
        schedule,
        doctor: doctorsById.get(schedule.doctorId)!,
        start: timeToMinutes(schedule.startTime),
        end: timeToMinutes(schedule.endTime),
      }))
      .filter((shift) => shift.end > shift.start);

    // Per weekday: the shifts, and the window in which the clinic is open at all.
    const days = WEEK_DAYS.map(({ value }) => {
      const own = shifts.filter((shift) => shift.schedule.weekDay === value);
      return {
        weekDay: value,
        own,
        opens: own.length ? Math.min(...own.map((shift) => shift.start)) : 0,
        closes: own.length ? Math.max(...own.map((shift) => shift.end)) : 0,
      };
    });

    return DAY_PARTS.map((part) => ({
      part,
      range: `${formatTime12(minutesToTimeSpan(part.start))} – ${formatTime12(
        minutesToTimeSpan(part.end % (24 * 60))
      )}`,
      cells: days.map((day): PartCell => {
        const chips = day.own
          .map((shift) => ({
            shift,
            from: Math.max(shift.start, part.start),
            to: Math.min(shift.end, part.end),
          }))
          .filter((slice) => slice.to > slice.from)
          .sort(
            (a, b) => a.from - b.from || a.shift.doctor.name.localeCompare(b.shift.doctor.name)
          )
          .map(
            ({ shift, from, to }): ShiftChip => ({
              schedule: shift.schedule,
              doctorName: shift.doctor.name,
              initial: shift.doctor.name.charAt(0),
              color: colors.get(shift.doctor.id) ?? 0,
              label: this.compactRange(from, to),
              tooltip: `${shift.doctor.name} · ${formatTime12(shift.schedule.startTime)} – ${formatTime12(
                shift.schedule.endTime
              )}`,
            })
          );

        let state: CellState;
        if (!day.own.length) {
          state = 'off';
        } else if (chips.length) {
          state = 'covered';
        } else if (day.opens < part.end && day.closes > part.start) {
          state = 'gap';
        } else {
          state = 'closed';
        }

        return { weekDay: day.weekDay, state, chips };
      }),
    }));
  });

  protected readonly hasAnySchedule = computed(() => this.schedules().length > 0);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);

    forkJoin({
      doctors: this.doctorsApi
        .getDoctors({ pageIndex: 1, pageSize: 200 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      schedules: this.api
        .getSchedules({ pageIndex: 1, pageSize: 500 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
    }).subscribe({
      next: ({ doctors, schedules }) => {
        this.doctors.set(doctors.data as Doctor[]);
        this.schedules.set(schedules.data as DoctorSchedule[]);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /**
   * Opens the form. Clicking a cell pre-fills the day and the part of the day;
   * when the list is filtered to one doctor, that doctor is pre-filled too.
   */
  protected addShift(weekDay?: WeekDay, part?: DayPart): void {
    if (!this.permissions.can('schedules.create')) {
      return;
    }

    const filter = this.doctorFilter();
    this.openDialog({
      presetDoctorId: filter === 'all' ? undefined : filter,
      presetWeekDay: weekDay,
      presetStartMinutes: part?.presetStart,
      presetEndMinutes: part?.presetEnd,
    });
  }

  protected editShift(schedule: DoctorSchedule): void {
    if (!this.permissions.can('schedules.edit')) {
      return;
    }
    this.openDialog({ schedule });
  }

  protected removeShift(schedule: DoctorSchedule, doctorName: string): void {
    confirmDialog(this.dialog, {
      title: 'schedules.delete',
      message: 'schedules.deleteConfirm',
      messageParams: {
        day: this.translate.instant(`weekday.${schedule.weekDay}`),
        from: formatTime12(schedule.startTime),
        to: formatTime12(schedule.endTime),
        doctor: doctorName,
      },
      confirmLabel: 'common.delete',
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      this.api.deleteSchedule(schedule.id).subscribe(() => {
        this.notifications.success(this.translate.instant('schedules.deleted'), {
          detail: this.describe(schedule, doctorName),
          duration: 7000,
          action: {
            label: this.notifications.undoLabel(),
            run: () => this.restoreShift(schedule, doctorName),
          },
        });
        this.load();
      });
    });
  }

  /** "9–12 PM" / "9 AM–12:30 PM": no ":00", and the period shown once when it is shared. */
  private compactRange(startMinutes: number, endMinutes: number): string {
    const from = this.clock(startMinutes);
    const to = this.clock(endMinutes);

    return from.period === to.period
      ? `${from.text}–${to.text} ${to.period}`
      : `${from.text} ${from.period}–${to.text} ${to.period}`;
  }

  private clock(totalMinutes: number): { text: string; period: 'AM' | 'PM' } {
    const minutes = totalMinutes % (24 * 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    return {
      text: `${hours % 12 || 12}${rest ? ':' + String(rest).padStart(2, '0') : ''}`,
      period: hours < 12 ? 'AM' : 'PM',
    };
  }

  /** "Dr. Kamal · Sunday · 9:00 AM – 5:00 PM", for the toast. */
  private describe(schedule: DoctorSchedule, doctorName: string): string {
    return [
      doctorName,
      this.translate.instant(`weekday.${schedule.weekDay}`),
      `${formatTime12(schedule.startTime)} – ${formatTime12(schedule.endTime)}`,
    ].join(' · ');
  }

  /** Undo for a delete: the same shift is created again. */
  private restoreShift(schedule: DoctorSchedule, doctorName: string): void {
    this.api
      .createSchedule({
        doctorId: schedule.doctorId,
        weekDay: schedule.weekDay,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
      })
      .subscribe(() => {
        this.notifications.success(this.translate.instant('schedules.created'), {
          kind: 'calendar',
          detail: this.describe(schedule, doctorName),
        });
        this.load();
      });
  }

  private openDialog(partial: Partial<ScheduleDialogData>): void {
    this.dialog
      .open<ScheduleFormDialogComponent, ScheduleDialogData, boolean>(
        ScheduleFormDialogComponent,
        {
          data: {
            doctors: this.doctors(),
            schedules: this.schedules(),
            ...partial,
          },
        }
      )
      .afterClosed()
      .subscribe((saved) => {
        if (saved) {
          this.load();
        }
      });
  }
}