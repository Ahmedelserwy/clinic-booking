import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Observable, map } from 'rxjs';

import { Doctor } from '../../../core/models/doctor.model';
import { DoctorSchedule, WEEK_DAYS, WeekDay } from '../../../core/models/schedule.model';
import { NotificationService } from '../../../core/services/notification.service';
import { SchedulesService } from '../../../core/services/schedules.service';
import {
  dateToMinutes,
  formatTime12,
  minutesToDate,
  minutesToTimeSpan,
  timeToMinutes,
} from '../../../core/utils/date.util';
import { timeRangeValidator } from '../../../core/utils/validators';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';

export interface ScheduleDialogData {
  doctors: Doctor[];
  /** Existing shifts, used to reject an overlap before it reaches the API. */
  schedules: DoctorSchedule[];
  schedule?: DoctorSchedule;
  presetDoctorId?: number;
  presetWeekDay?: WeekDay;
  /** Pre-filled start/end for a new shift, in minutes from midnight (e.g. 540 = 9:00 AM). */
  presetStartMinutes?: number;
  presetEndMinutes?: number;
}

@Component({
  selector: 'app-schedule-form-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTimepickerModule,
    TranslatePipe,
    FieldErrorComponent,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schedule-form-dialog.component.html',
  styleUrl: './schedule-form-dialog.component.scss',
})
export class ScheduleFormDialogComponent {
  private readonly api = inject(SchedulesService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  readonly dialogRef = inject<MatDialogRef<ScheduleFormDialogComponent, boolean>>(MatDialogRef);
  readonly data = inject<ScheduleDialogData>(MAT_DIALOG_DATA);

  protected readonly weekDays = WEEK_DAYS;
  protected readonly isEdit = Boolean(this.data.schedule);
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);

  protected readonly form = this.formBuilder.nonNullable.group(
    {
      doctorId: this.formBuilder.control<number | null>(
        this.data.schedule?.doctorId ?? this.data.presetDoctorId ?? null,
        [Validators.required]
      ),
      weekDay: this.formBuilder.control<WeekDay | null>(
        this.data.schedule?.weekDay ?? this.data.presetWeekDay ?? null,
        [Validators.required]
      ),
      startTime: this.formBuilder.control<Date | null>(
        minutesToDate(
          this.data.schedule
            ? timeToMinutes(this.data.schedule.startTime)
            : (this.data.presetStartMinutes ?? 9 * 60)
        ),
        [Validators.required]
      ),
      endTime: this.formBuilder.control<Date | null>(
        minutesToDate(
          this.data.schedule
            ? timeToMinutes(this.data.schedule.endTime)
            : (this.data.presetEndMinutes ?? 17 * 60)
        ),
        [Validators.required]
      ),
    },
    { validators: timeRangeValidator() }
  );

  protected submit(): void {
    this.submitted.set(true);

    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const startMinutes = dateToMinutes(raw.startTime!);
    const endMinutes = dateToMinutes(raw.endTime!);

    // Two overlapping shifts on the same day would generate duplicate slots and
    // make the doctor look doubly available, so it is rejected here.
    const clash = this.data.schedules.find(
      (schedule) =>
        schedule.id !== this.data.schedule?.id &&
        schedule.doctorId === raw.doctorId &&
        schedule.weekDay === raw.weekDay &&
        startMinutes < timeToMinutes(schedule.endTime) &&
        timeToMinutes(schedule.startTime) < endMinutes
    );

    if (clash) {
      this.form.setErrors({ overlap: true });
      this.notifications.error(this.translate.instant('validation.overlap'));
      return;
    }

    this.saving.set(true);

    const payload = {
      doctorId: raw.doctorId!,
      weekDay: raw.weekDay!,
      startTime: minutesToTimeSpan(startMinutes),
      endTime: minutesToTimeSpan(endMinutes),
    };

    const doctorName = this.data.doctors.find((doctor) => doctor.id === payload.doctorId)?.name;
    const detail = [
      doctorName,
      this.translate.instant(`weekday.${payload.weekDay}`),
      `${formatTime12(payload.startTime)} – ${formatTime12(payload.endTime)}`,
    ]
      .filter(Boolean)
      .join(' · ');

    // Both branches are normalised to `Observable<void>`: update returns no
    // body while create echoes the row, and the caller cares about neither.
    const request: Observable<void> = this.data.schedule
      ? this.api.updateSchedule(this.data.schedule.id, {
          weekDay: payload.weekDay,
          startTime: payload.startTime,
          endTime: payload.endTime,
        })
      : this.api.createSchedule(payload).pipe(map(() => undefined));

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.notifications.success(
          this.translate.instant(this.isEdit ? 'schedules.updated' : 'schedules.created'),
          { kind: 'calendar', detail }
        );
        this.dialogRef.close(true);
      },
      error: () => this.saving.set(false),
    });
  }
}