import { TextFieldModule } from '@angular/cdk/text-field';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  Medication,
  MedicalRecord,
  MedicalRecordsStore,
  RECORD_TYPES,
  RECORD_TYPE_META,
  RecordType,
} from '../../../core/data/medical-records.store';
import { Doctor } from '../../../core/models/doctor.model';
import { AuthService } from '../../../core/services/auth.service';
import { NotificationService } from '../../../core/services/notification.service';
import { toDateOnly } from '../../../core/utils/date.util';
import { notFutureValidator } from '../../../core/utils/validators';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';

/** The minimum a patient must expose for the picker; avoids importing the full view model. */
export interface RecordDialogPatient {
  id: number;
  name: string;
}

export interface RecordDialogData {
  /**
   * The patient this record belongs to, when the caller already knows - the
   * patient page does. Absent from the records list, where `patients` is
   * supplied instead and the dialog asks.
   */
  patientId?: number;
  patientName?: string;
  patients?: RecordDialogPatient[];
  doctors: Doctor[];
  /** Present when editing. */
  record?: MedicalRecord;
  /** Shown in a warning bar while writing, so they are never out of sight. */
  allergies?: string[];
  chronicDiseases?: string[];
  /** Offers "Save & create invoice"; the caller decides, since it owns the permission. */
  canInvoice?: boolean;
}

/** `true` = saved, `'invoice'` = saved and the caller should open a new invoice. */
export type RecordDialogResult = boolean | 'invoice';

/** Quick follow-up intervals, the way doctors say them: "come back in a week". */
const FOLLOW_UP_PRESETS = [
  { label: 'records.followUp3d', days: 3 },
  { label: 'records.followUp1w', days: 7 },
  { label: 'records.followUp2w', days: 14 },
  { label: 'records.followUp1m', days: 30 },
] as const;

/**
 * A consultation note, built for speed: type, date and time default to
 * "visit, now" and fold away; the doctor is pre-selected (and hidden) when the
 * clinic has only one; the title is generated from the diagnosis, never typed;
 * the prescription is written as drug / dose / duration lines; the follow-up is
 * one tap ("in a week").
 */
@Component({
  selector: 'app-record-form-dialog',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    TextFieldModule,
    MatButtonModule,
    MatDatepickerModule,
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
  templateUrl: './record-form-dialog.component.html',
  styleUrl: './record-form-dialog.component.scss',
})
export class RecordFormDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);
  private readonly store = inject(MedicalRecordsStore);
  private readonly translate = inject(TranslateService);

  readonly dialogRef = inject<MatDialogRef<RecordFormDialogComponent, RecordDialogResult>>(MatDialogRef);
  readonly data = inject<RecordDialogData>(MAT_DIALOG_DATA);

  protected readonly recordTypes = RECORD_TYPES;
  protected readonly typeMeta = RECORD_TYPE_META;
  protected readonly followUpPresets = FOLLOW_UP_PRESETS;
  protected readonly maxDate = new Date();
  protected readonly minFollowUp = new Date();
  protected readonly isEdit = Boolean(this.data.record);

  /** Editing always keeps the record's own patient; only a fresh entry may choose. */
  protected readonly fixedPatientId = this.data.record?.patientId ?? this.data.patientId ?? null;
  protected readonly fixedPatientName = this.data.record?.patientName ?? this.data.patientName ?? '';
  protected readonly patients = this.data.patients ?? [];
  protected readonly picksPatient = this.fixedPatientId === null;

  /** A clinic with a single doctor never needs to see the field. */
  protected readonly showDoctor = this.data.doctors.length > 1;

  protected readonly hasAlerts = Boolean(
    this.data.allergies?.length || this.data.chronicDiseases?.length
  );

  protected readonly submitted = signal(false);
  protected readonly editingWhen = signal(false);
  protected readonly showVitals = signal(Boolean(this.data.record?.vitals));

  /**
   * Old records kept the whole prescription as one text; it lands in the note
   * so nothing is lost. Records with structured lines keep their note as is.
   */
  private readonly initialNote =
    this.data.record?.prescriptionNote ??
    (this.data.record?.medications?.length ? '' : (this.data.record?.prescription ?? ''));

  protected readonly showRxNote = signal(Boolean(this.initialNote));

  protected readonly form = this.formBuilder.nonNullable.group({
    patientId: this.formBuilder.control<number | null>(
      this.fixedPatientId,
      this.fixedPatientId === null ? [Validators.required] : []
    ),
    type: [this.data.record?.type ?? ('visit' as RecordType), [Validators.required]],
    // Split into date and time so both use a picker; neither is ever typed.
    occurredDate: this.formBuilder.control<Date | null>(
      this.data.record ? new Date(this.data.record.occurredAt) : new Date(),
      [Validators.required, notFutureValidator]
    ),
    occurredTime: this.formBuilder.control<Date | null>(
      this.data.record ? new Date(this.data.record.occurredAt) : new Date(),
      [Validators.required]
    ),
    // A clinic with a single doctor never needs to choose.
    doctorId: this.formBuilder.control<number | null>(
      this.data.record?.doctorId ??
        (this.data.doctors.length === 1 ? this.data.doctors[0].id : null)
    ),
    complaint: [this.data.record?.complaint ?? '', [Validators.maxLength(500)]],
    examination: [this.data.record?.examination ?? '', [Validators.maxLength(500)]],
    diagnosis: [this.data.record?.diagnosis ?? '', [Validators.maxLength(500)]],
    requestedTests: [this.data.record?.requestedTests ?? '', [Validators.maxLength(300)]],
    // Always at least one empty line, so a new prescription starts ready to type.
    medications: this.formBuilder.array(
      (this.data.record?.medications?.length ? this.data.record.medications : [undefined]).map(
        (item) => this.medicationGroup(item)
      )
    ),
    prescriptionNote: [this.initialNote, [Validators.maxLength(500)]],
    treatment: [this.data.record?.treatment ?? '', [Validators.maxLength(500)]],
    followUpDate: this.formBuilder.control<Date | null>(
      this.data.record?.followUpDate ? new Date(this.data.record.followUpDate) : null
    ),
    bloodPressure: [this.data.record?.vitals?.bloodPressure ?? '', [Validators.maxLength(12)]],
    temperature: this.formBuilder.control<number | null>(
      this.data.record?.vitals?.temperature ?? null,
      [Validators.min(30), Validators.max(45)]
    ),
    pulse: this.formBuilder.control<number | null>(this.data.record?.vitals?.pulse ?? null, [
      Validators.min(20),
      Validators.max(250),
    ]),
    weight: this.formBuilder.control<number | null>(this.data.record?.vitals?.weight ?? null, [
      Validators.min(1),
      Validators.max(400),
    ]),
    bloodSugar: this.formBuilder.control<number | null>(
      this.data.record?.vitals?.bloodSugar ?? null,
      [Validators.min(10), Validators.max(1000)]
    ),
    oxygenSaturation: this.formBuilder.control<number | null>(
      this.data.record?.vitals?.oxygenSaturation ?? null,
      [Validators.min(50), Validators.max(100)]
    ),
  });

  protected get medications() {
    return this.form.controls.medications;
  }

  protected addMedication(): void {
    this.medications.push(this.medicationGroup());
  }

  protected removeMedication(index: number): void {
    this.medications.removeAt(index);
  }

  /** `null` clears the follow-up. Counted from today, so it can never land in the past. */
  protected setFollowUp(days: number | null): void {
    const control = this.form.controls.followUpDate;
    if (days === null) {
      control.setValue(null);
    } else {
      const date = new Date();
      date.setDate(date.getDate() + days);
      control.setValue(date);
    }
    control.markAsDirty();
  }

  protected submit(andInvoice = false): void {
    this.submitted.set(true);

    // A dose with no drug name is a mistake, not an empty line.
    for (const row of this.medications.controls) {
      const { name, dosage, duration } = row.getRawValue();
      if (!name.trim() && (dosage.trim() || duration.trim())) {
        row.controls.name.setErrors({ required: true });
      }
    }

    if (this.form.invalid) {
      // Invalid fields live in the folded sections; open them so the error is visible.
      if (
        this.form.controls.occurredDate.invalid ||
        this.form.controls.occurredTime.invalid ||
        this.form.controls.type.invalid
      ) {
        this.editingWhen.set(true);
      }
      if (
        this.form.controls.temperature.invalid ||
        this.form.controls.pulse.invalid ||
        this.form.controls.weight.invalid ||
        this.form.controls.bloodPressure.invalid ||
        this.form.controls.bloodSugar.invalid ||
        this.form.controls.oxygenSaturation.invalid
      ) {
        this.showVitals.set(true);
      }
      if (this.form.controls.prescriptionNote.invalid) {
        this.showRxNote.set(true);
      }
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const doctor = this.data.doctors.find((entry) => entry.id === raw.doctorId);
    const patient = this.patients.find((entry) => entry.id === raw.patientId);

    // The name is denormalised onto the record so the table and timeline read
    // without a second lookup; fall back to whatever the caller already knew.
    const patientId = raw.patientId ?? this.fixedPatientId!;
    const patientName = patient?.name || this.fixedPatientName;

    const vitals = {
      bloodPressure: raw.bloodPressure.trim() || undefined,
      temperature: raw.temperature ?? undefined,
      pulse: raw.pulse ?? undefined,
      weight: raw.weight ?? undefined,
      bloodSugar: raw.bloodSugar ?? undefined,
      oxygenSaturation: raw.oxygenSaturation ?? undefined,
    };
    const hasVitals = Object.values(vitals).some((value) => value !== undefined);

    const medications: Medication[] = raw.medications
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        dosage: row.dosage.trim() || undefined,
        duration: row.duration.trim() || undefined,
      }));
    const prescriptionNote = raw.prescriptionNote.trim();

    const payload = {
      patientId,
      patientName,
      doctorId: doctor?.id,
      doctorName: doctor?.name,
      type: raw.type,
      occurredAt: this.combine(raw.occurredDate!, raw.occurredTime!),
      title: this.buildTitle(raw.type, raw.diagnosis, raw.complaint),
      complaint: raw.complaint.trim() || undefined,
      examination: raw.examination.trim() || undefined,
      diagnosis: raw.diagnosis.trim() || undefined,
      requestedTests: raw.requestedTests.trim() || undefined,
      medications: medications.length ? medications : undefined,
      prescriptionNote: prescriptionNote || undefined,
      prescription: this.buildPrescriptionText(medications, prescriptionNote) || undefined,
      treatment: raw.treatment.trim() || undefined,
      followUpDate: raw.followUpDate ? toDateOnly(raw.followUpDate) : undefined,
      vitals: hasVitals ? vitals : undefined,
      tags: this.data.record?.tags ?? [],
      recordedBy: this.auth.currentUser?.displayName ?? '',
    };

    if (this.data.record) {
      this.store.update(this.data.record.id, payload);
      this.notifications.success(this.translate.instant('records.updated'));
    } else {
      this.store.create(payload);
      this.notifications.success(this.translate.instant('records.created'));
    }

    this.dialogRef.close(andInvoice ? 'invoice' : true);
  }

  private medicationGroup(item?: Medication) {
    return this.formBuilder.nonNullable.group({
      name: [item?.name ?? '', [Validators.maxLength(120)]],
      dosage: [item?.dosage ?? '', [Validators.maxLength(120)]],
      duration: [item?.duration ?? '', [Validators.maxLength(60)]],
    });
  }

  /** The plain-text prescription every text-only screen and print layout reads. */
  private buildPrescriptionText(medications: Medication[], note: string): string {
    const lines = medications.map((item, index) =>
      [`${index + 1}. ${item.name}`, item.dosage, item.duration].filter(Boolean).join(' - ')
    );
    if (note) {
      lines.push(note);
    }
    return lines.join('\n');
  }

  /**
   * Doctors don't name their visits. The headline is the diagnosis, else the
   * complaint, else the entry type, so the timeline always reads sensibly.
   */
  private buildTitle(type: RecordType, diagnosis: string, complaint: string): string {
    const source =
      diagnosis.trim() ||
      complaint.trim() ||
      this.translate.instant(this.typeMeta[type].label);
    return source.split('\n')[0].trim().slice(0, 120);
  }

  /** Merges the two pickers into the single instant the record is filed under. */
  private combine(date: Date, time: Date): string {
    const merged = new Date(date);
    merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
    return merged.toISOString();
  }
}