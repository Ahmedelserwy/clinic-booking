import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  DEFAULT_SPECIALIZATIONS,
  Doctor,
  DoctorShiftRequest,
} from '../../../core/models/doctor.model';
 import { ReexaminationPolicy,DEFAULT_REEXAMINATION,DoctorServiceItem } from '../../../core/services/Doctor service.model';
import { WEEK_DAYS, WeekDay } from '../../../core/models/schedule.model';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import { dateToMinutes, minutesToDate, minutesToTimeSpan } from '../../../core/utils/date.util';
import { nameValidators, phoneValidator } from '../../../core/utils/validators';
import { SpecialtyPipe } from '../../../shared/pipes/specialty.pipe';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
 import { DoctorReexaminationDialogComponent,ReexaminationDialogData } from '../doctor-detail/Doctor reexamination dialog.component';
export interface DoctorDialogData {
  doctor?: Doctor;
  /** Specialities already in use, offered before the built-in list. */
  knownSpecializations: string[];
}

/** One row of the Working Schedule editor. */
type ShiftForm = FormGroup<{
  start: FormControl<Date | null>;
  end: FormControl<Date | null>;
}>;

/** One row of the Services editor. */
type ServiceForm = FormGroup<{
  id: FormControl<number | null>;
  name: FormControl<string>;
  price: FormControl<number | null>;
  durationMinutes: FormControl<number | null>;
}>;

/** A day and the shifts assigned to it. A day with no shifts is "Off". */
interface DayRow {
  day: WeekDay;
  shifts: ShiftForm[];
}

/** Problems that are properties of the rota as a whole, not of one control. */
export type ShiftProblem = 'order' | 'overlap' | 'duplicate';

const DEFAULT_SHIFT_START_MINUTES = 9 * 60;
const DEFAULT_SHIFT_END_MINUTES = 13 * 60;

@Component({
  selector: 'app-doctor-form-dialog',
  imports: [
    ReactiveFormsModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatTimepickerModule,
    MatTooltipModule,
    TranslatePipe,
    SpecialtyPipe,
    FieldErrorComponent,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './doctor-form-dialog.component.html',
  styleUrl: './doctor-form-dialog.component.scss',
})
export class DoctorFormDialogComponent {
  private readonly api = inject(DoctorsService);
  private readonly dialog = inject(MatDialog);
  private readonly formBuilder = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);

  readonly dialogRef = inject<MatDialogRef<DoctorFormDialogComponent, boolean>>(MatDialogRef);
  readonly data = inject<DoctorDialogData>(MAT_DIALOG_DATA);

  protected readonly isEdit = Boolean(this.data.doctor);
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);

  protected readonly weekDays = WEEK_DAYS;

  /** In-use specialities first, then the defaults, de-duplicated. */
  protected readonly specializations = [
    ...new Set([...this.data.knownSpecializations, ...DEFAULT_SPECIALIZATIONS]),
  ].sort((a, b) => a.localeCompare(b));

  protected readonly form = this.formBuilder.nonNullable.group({
    name: [this.data.doctor?.name ?? '', nameValidators],
    specialization: [
      this.data.doctor?.specialization ?? '',
      [Validators.required, Validators.maxLength(60)],
    ],
    phone: [this.data.doctor?.phone ?? '', [phoneValidator]],
    email: [this.data.doctor?.email ?? '', [Validators.email, Validators.maxLength(256)]],
    consultationFee: this.formBuilder.control<number | null>(
      this.data.doctor?.consultationFee ?? null,
      [Validators.min(0), Validators.max(1_000_000)]
    ),
    bio: [this.data.doctor?.bio ?? '', [Validators.maxLength(2000)]],
    // `isActive` is undefined on a doctor loaded before this field existed; a
    // practitioner already on the list is practising until told otherwise.
    isActive: [this.data.doctor?.isActive ?? true],
    // The regular services this doctor provides, each with its own price.
    services: this.formBuilder.array<ServiceForm>(
      (this.data.doctor?.services ?? []).map((service) => this.createService(service))
    ),
  });

  /** Re-examination policy; edited in its own dialog and sent with the profile. */
  protected readonly reexamination = signal<ReexaminationPolicy>(
    this.data.doctor?.reexamination ?? DEFAULT_REEXAMINATION
  );

  protected readonly reexamSummary = computed(() => {
    const policy = this.reexamination();

    if (!policy.enabled) {
      return { key: 'doctors.reexamOff', params: {} };
    }

    return policy.fee
      ? { key: 'doctors.reexamSummary', params: { days: policy.validDays, fee: policy.fee } }
      : { key: 'doctors.reexamSummaryFree', params: { days: policy.validDays } };
  });

  /**
   * The whole rota, keyed by day.
   *
   * A `FormArray` per day rather than one flat array: "add a shift to Saturday"
   * and "remove Sunday's second shift" are the two operations the UI actually
   * performs, and both are index arithmetic on a flat list but a single call
   * here.
   */
  protected readonly schedule = new Map<WeekDay, FormArray<ShiftForm>>(
    WEEK_DAYS.map((day) => [day.value, this.formBuilder.array<ShiftForm>([])])
  );

  /**
   * Bumped on every structural change so the computed views below recompute.
   *
   * `FormArray` is not a signal, so adding or removing a row is invisible to
   * Angular's reactive graph. One explicit version counter is cheaper and far
   * easier to follow than mirroring the whole rota into signal state.
   */
  private readonly revision = signal(0);

  protected readonly days = computed<DayRow[]>(() => {
    this.revision();
    return WEEK_DAYS.map((day) => ({
      day: day.value,
      shifts: this.schedule.get(day.value)!.controls,
    }));
  });

  protected readonly shiftCount = computed(() => {
    this.revision();
    return [...this.schedule.values()].reduce((total, day) => total + day.length, 0);
  });

  /**
   * Set-level problems, recomputed as the user types.
   *
   * Shown live rather than only on submit: the whole point of an overlap
   * warning is to stop someone building a rota they cannot save.
   */
  protected readonly problems = computed<Map<WeekDay, ShiftProblem>>(() => {
    this.revision();
    const found = new Map<WeekDay, ShiftProblem>();

    for (const [day, shifts] of this.schedule) {
      const problem = this.inspect(shifts);
      if (problem) {
        found.set(day, problem);
      }
    }

    return found;
  });

  protected readonly hasProblems = computed(() => this.problems().size > 0);

  constructor() {
    // Editing changes the profile only. The rota belongs to the Schedules
    // screen, where deleting a shift an appointment is booked against is a
    // visible act rather than a side effect of renaming someone.
    if (!this.isEdit) {
      this.addShift(WeekDay.Saturday);
    }
  }

  // ---------------------------------------------------------------- services --

  private createService(item?: Partial<DoctorServiceItem>): ServiceForm {
    return this.formBuilder.nonNullable.group({
      id: this.formBuilder.control<number | null>(item?.id ?? null),
      name: [item?.name ?? '', [Validators.required, Validators.maxLength(100)]],
      price: this.formBuilder.control<number | null>(item?.price ?? null, [
        Validators.required,
        Validators.min(0),
        Validators.max(1_000_000),
      ]),
      durationMinutes: this.formBuilder.control<number | null>(item?.durationMinutes ?? null, [
        Validators.min(5),
        Validators.max(480),
      ]),
    });
  }

  /** The "+" button: appends an empty service row. */
  protected addService(): void {
    this.form.controls.services.push(this.createService());
    this.form.markAsDirty();
  }

  protected removeService(index: number): void {
    this.form.controls.services.removeAt(index);
    this.form.markAsDirty();
  }

  protected openReexamination(): void {
    this.dialog
      .open<DoctorReexaminationDialogComponent, ReexaminationDialogData, ReexaminationPolicy>(
        DoctorReexaminationDialogComponent,
        {
          data: {
            policy: this.reexamination(),
            consultationFee: this.form.controls.consultationFee.value,
          },
        }
      )
      .afterClosed()
      .subscribe((policy) => {
        if (policy) {
          this.reexamination.set(policy);
          this.form.markAsDirty();
        }
      });
  }

  // ---------------------------------------------------------------- schedule --

  protected shiftsFor(day: WeekDay): FormArray<ShiftForm> {
    return this.schedule.get(day)!;
  }

  protected addShift(day: WeekDay): void {
    const shifts = this.shiftsFor(day);

    // A second shift starts where the previous one ended rather than at the
    // default 09:00, so the common "morning, then afternoon" rota is one click
    // and never opens already overlapping.
    const previous = shifts.at(shifts.length - 1);
    const previousEnd = previous?.controls.end.value;

    const startMinutes = previousEnd
      ? Math.min(dateToMinutes(previousEnd) + 60, 23 * 60)
      : DEFAULT_SHIFT_START_MINUTES;
    const endMinutes = Math.min(
      startMinutes + (DEFAULT_SHIFT_END_MINUTES - DEFAULT_SHIFT_START_MINUTES),
      24 * 60 - 1
    );

    shifts.push(
      this.formBuilder.group({
        start: this.formBuilder.control<Date | null>(minutesToDate(startMinutes), [
          Validators.required,
        ]),
        end: this.formBuilder.control<Date | null>(minutesToDate(endMinutes), [
          Validators.required,
        ]),
      })
    );

    this.revision.update((value) => value + 1);
  }

  protected removeShift(day: WeekDay, index: number): void {
    this.shiftsFor(day).removeAt(index);
    this.revision.update((value) => value + 1);
  }

  /** Removes every shift on a day — the "Off" action. */
  protected clearDay(day: WeekDay): void {
    this.shiftsFor(day).clear();
    this.revision.update((value) => value + 1);
  }

  protected problemFor(day: WeekDay): ShiftProblem | null {
    return this.problems().get(day) ?? null;
  }

  /** Re-runs the set-level checks after a time picker commits a value. */
  protected onTimeChanged(): void {
    this.revision.update((value) => value + 1);
  }

  /**
   * The first problem with one day's shifts, or null.
   *
   * Order is checked before overlap because an inverted shift (17:00 → 09:00)
   * makes the overlap comparison meaningless — reporting "overlap" there would
   * point the user at the wrong field.
   */
  private inspect(shifts: FormArray<ShiftForm>): ShiftProblem | null {
    const ranges: { start: number; end: number }[] = [];

    for (const shift of shifts.controls) {
      const start = shift.controls.start.value;
      const end = shift.controls.end.value;

      if (!start || !end) {
        continue;
      }

      const range = { start: dateToMinutes(start), end: dateToMinutes(end) };
      if (range.end <= range.start) {
        return 'order';
      }

      ranges.push(range);
    }

    const unique = new Set(ranges.map((range) => `${range.start}-${range.end}`));
    if (unique.size !== ranges.length) {
      return 'duplicate';
    }

    // Half-open intervals: 09:00–13:00 followed by 13:00–17:00 is adjacent, not
    // overlapping, and rejecting it would rule out the ordinary split day.
    const ordered = [...ranges].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].start < ordered[i - 1].end) {
        return 'overlap';
      }
    }

    return null;
  }

  private collectShifts(): DoctorShiftRequest[] {
    const shifts: DoctorShiftRequest[] = [];

    for (const [day, controls] of this.schedule) {
      for (const shift of controls.controls) {
        const start = shift.controls.start.value;
        const end = shift.controls.end.value;

        if (start && end) {
          shifts.push({
            weekDay: day,
            startTime: minutesToTimeSpan(dateToMinutes(start)),
            endTime: minutesToTimeSpan(dateToMinutes(end)),
          });
        }
      }
    }

    return shifts;
  }

  // ------------------------------------------------------------------ submit --

  protected submit(): void {
    this.submitted.set(true);

    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    if (!this.isEdit && this.hasProblems()) {
      this.notifications.error(this.translate.instant('doctors.scheduleInvalid'));
      return;
    }

    this.saving.set(true);
    const raw = this.form.getRawValue();

    const profile = {
      name: raw.name.trim(),
      specialization: raw.specialization.trim(),
      phone: raw.phone.trim() || null,
      email: raw.email.trim() || null,
      consultationFee: raw.consultationFee,
      bio: raw.bio.trim() || null,
      isActive: raw.isActive,
      services: raw.services
        .map((service) => ({
          id: service.id ?? undefined,
          name: service.name.trim(),
          price: service.price ?? 0,
          durationMinutes: service.durationMinutes,
        }))
        .filter((service) => service.name),
      reexamination: this.reexamination(),
    };

    // One request either way. The create carries the rota with it so the API can
    // write the doctor and every shift in a single transaction.
    const request = this.data.doctor
      ? this.api.updateDoctor(this.data.doctor.id, { ...profile, id: this.data.doctor.id })
      : this.api.createDoctor({ ...profile, schedules: this.collectShifts() });

    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.notifications.success(
          this.translate.instant(this.isEdit ? 'doctors.updated' : 'doctors.created'),
          { kind: 'cross', detail: profile.name }
        );
        this.dialogRef.close(true);
      },
      error: () => this.saving.set(false),
    });
  }
}