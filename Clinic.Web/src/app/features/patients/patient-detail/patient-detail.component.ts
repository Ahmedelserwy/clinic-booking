import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { AccountsStore } from '../../../core/data/accounts.store';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import {
  MedicalRecord,
  MedicalRecordsStore,
  RECORD_TYPE_META,
} from '../../../core/data/medical-records.store';
import { Appointment } from '../../../core/models/appointment.model';
import { Doctor } from '../../../core/models/doctor.model';
import { NotificationService } from '../../../core/services/notification.service';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { DoctorsService } from '../../../core/services/doctors.service';
import { parseDate } from '../../../core/utils/date.util';
import { CardComponent } from '../../../shared/ui/card/card.component';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { CellTemplateDirective } from '../../../shared/ui/data-table/data-table.model';
import { DetailItem, DetailListComponent } from '../../../shared/ui/detail-list/detail-list.component';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import { TimelineComponent, TimelineEntry } from '../../../shared/ui/timeline/timeline.component';
import {
  RecordDialogData,
  RecordFormDialogComponent,
} from '../../records/record-form-dialog/record-form-dialog.component';
import {
  InvoiceDialogData,
  InvoiceFormDialogComponent,
} from '../../accounts/invoice-form-dialog/invoice-form-dialog.component';
import { FollowUpInfo, PatientView, PatientsFacade, followUpInfo } from '../patients.facade';

@Component({
  selector: 'app-patient-detail',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatMenuModule,
    MatTabsModule,
    MatTooltipModule,
    TranslatePipe,
    CardComponent,
    CellTemplateDirective,
    DetailListComponent,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
    TimelineComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './patient-detail.component.html',
  styleUrl: './patient-detail.component.scss',
})
export class PatientDetailComponent {
  private readonly appointmentsApi = inject(AppointmentsService);
  private readonly dialog = inject(MatDialog);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly facade = inject(PatientsFacade);
  private readonly notifications = inject(NotificationService);
  private readonly records = inject(MedicalRecordsStore);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly accounts = inject(AccountsStore);
  protected readonly permissions = inject(PermissionService);
  protected readonly settings = inject(ClinicSettingsStore);

  readonly id = input.required<string>();

  protected readonly patient = signal<PatientView | null>(null);
  protected readonly appointments = signal<Appointment[]>([]);
  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly loading = signal(true);

  protected readonly patientId = computed(() => Number(this.id()));

  constructor() {
    queueMicrotask(() => this.load());
  }

  // ------------------------------------------------------------- overview --

  protected readonly identityItems = computed<DetailItem[]>(() => {
    const patient = this.patient();
    if (!patient) {
      return [];
    }

    return [
      { label: 'patients.fileNumber', value: patient.profile.fileNumber, icon: 'note' },
      {
        label: 'patients.dateOfBirth',
        value: patient.dateOfBirth ? new Date(patient.dateOfBirth).toLocaleDateString() : null,
        icon: 'birthday',
      },
      {
        label: 'patients.age',
        value: patient.age === null ? null : this.translate.instant('patients.ageYears', { count: patient.age }),
      },
      {
        label: 'patients.gender',
        value: this.translate.instant(
          patient.gender === 'Male'
            ? 'patients.genderMale'
            : patient.gender === 'Female'
              ? 'patients.genderFemale'
              : 'patients.genderOther'
        ),
      },
    ];
  });

  protected readonly contactItems = computed<DetailItem[]>(() => {
    const patient = this.patient();
    if (!patient) {
      return [];
    }

    return [{ label: 'patients.phone', value: patient.phone, icon: 'phone', tone: 'strong' }];
  });

  // ------------------------------------------------------------- timeline --

  protected readonly patientRecords = computed(() => {
    // Touch the store signal so the timeline updates the moment a record is added.
    this.records.records();
    return this.records.forPatient(this.patientId());
  });

  protected readonly timeline = computed<TimelineEntry[]>(() =>
    this.patientRecords().map((record) => {
      const meta = RECORD_TYPE_META[record.type];
      return {
        id: record.id,
        date: record.occurredAt,
        typeLabel: meta.label,
        icon: meta.icon,
        tone: meta.tone,
        title: record.title,
        summary: record.diagnosis || record.complaint,
        author: record.doctorName ?? record.recordedBy,
        tags: record.tags,
        facts: this.factsFor(record),
      };
    })
  );

  // --------------------------------------------------------- appointments --

  protected readonly patientAppointments = computed(() =>
    [...this.appointments()].sort((a, b) => b.appointmentDate.localeCompare(a.appointmentDate))
  );

  protected readonly lastVisit = computed(() => {
    const now = Date.now();
    return this.patientAppointments().find((appointment) => {
      const date = parseDate(appointment.appointmentDate);
      return date ? date.getTime() <= now : false;
    });
  });

  protected readonly nextVisit = computed(() => {
    const now = Date.now();
    return [...this.patientAppointments()]
      .reverse()
      .find((appointment) => {
        const date = parseDate(appointment.appointmentDate);
        return date ? date.getTime() > now : false;
      });
  });

  /** The doctor's follow-up, when it is due today or missed and the patient has not come back since. */
  protected readonly followUp = computed<FollowUpInfo | null>(() => {
    const due = this.facade.followUpDateFor(this.patientId());
    const last = this.lastVisit();
    return followUpInfo(due, last ? parseDate(last.appointmentDate) : null);
  });

  // ------------------------------------------------------------- billing --

  protected readonly invoices = computed(() =>
    this.accounts.invoices().filter((invoice) => invoice.patientId === this.patientId())
  );

  protected readonly balance = computed(() =>
    this.invoices().reduce((sum, invoice) => sum + invoice.remaining, 0)
  );

  protected readonly currency = computed(() => this.settings.settings().currency);

  // ------------------------------------------------------------- actions --

  protected addRecord(record?: MedicalRecord): void {
    const patient = this.patient();
    if (!patient) {
      return;
    }

    this.dialog.open<RecordFormDialogComponent, RecordDialogData, boolean>(
      RecordFormDialogComponent,
      {
        data: {
          patientId: patient.id,
          patientName: patient.name,
          doctors: this.doctors(),
          record,
        },
      }
    );
  }

  /** Opens the invoice form with this patient already chosen and locked. */
  protected addInvoice(): void {
    const patient = this.patient();
    if (!patient) {
      return;
    }

    this.dialog.open<InvoiceFormDialogComponent, InvoiceDialogData, boolean>(
      InvoiceFormDialogComponent,
      {
        width: '720px',
        maxWidth: '95vw',
        data: { patients: [patient], doctors: this.doctors(), patientId: patient.id },
      }
    );
  }

  // ------------------------------------------------------- prescription print --

  protected hasPrescription(entry: TimelineEntry): boolean {
    return Boolean(this.records.getById(entry.id)?.prescription?.trim());
  }

  protected printLabel(): string {
    return this.label('common.print', 'طباعة الوصفة', 'Print prescription');
  }

  /**
   * Prints one prescription as a clean A4 page: clinic header, patient and doctor,
   * the prescription text and a signature line. It is built as its own document in
   * a hidden frame, so the sidebar, tabs and buttons never end up on the paper.
   */
  protected printPrescription(entry: TimelineEntry): void {
    const record = this.records.getById(entry.id);
    const patient = this.patient();
    const prescription = record?.prescription?.trim();
    if (!record || !patient || !prescription) {
      return;
    }

    const arabic = this.isArabic();
    const t = (ar: string, en: string): string => (arabic ? ar : en);
    const esc = (value: unknown): string =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const pad = (n: number): string => `${n}`.padStart(2, '0');
    const formatDate = (value: string): string => {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? ''
        : `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    };

    const doctor = record.doctorName ?? record.recordedBy ?? '';

    // Only what a pharmacy needs next to the medicines: who it is for, when, and from whom.
    const info: [string, string][] = [
      [t('المريض', 'Patient'), patient.name],
      [t('العمر', 'Age'), patient.age === null ? '' : `${patient.age}`],
      [t('التاريخ', 'Date'), formatDate(record.occurredAt)],
      [t('الطبيب', 'Doctor'), doctor],
    ];

    const html = `<!doctype html>
<html lang="${arabic ? 'ar' : 'en'}" dir="${arabic ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${esc(t('وصفة طبية', 'Prescription'))} - ${esc(patient.name)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #0f2540; font-size: 14px; }
  header { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 12px; border-bottom: 3px solid #0f2540; }
  .clinic { font-size: 24px; font-weight: 700; }
  .doc-title { font-size: 16px; font-weight: 600; color: #475569; }
  .info { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 24px; margin: 18px 0; }
  .info div { display: flex; gap: 8px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  .info span { color: #64748b; min-width: 76px; }
  .info b { font-weight: 600; }
  .rx { display: flex; gap: 14px; margin-top: 12px; min-height: 300px; }
  .rx-mark { font-size: 44px; line-height: 1; font-weight: 700; color: #0f2540; }
  .rx-body { flex: 1; font-size: 17px; line-height: 2; white-space: pre-wrap; }
  footer { margin-top: 36px; display: flex; justify-content: space-between; align-items: flex-end; }
  .sign { width: 220px; text-align: center; border-top: 1px solid #0f2540; padding-top: 6px; font-size: 13px; }
  .note { color: #94a3b8; font-size: 11px; }
</style>
</head>
<body>
  <header>
    <div class="clinic">${esc(this.clinicName())}</div>
    <div class="doc-title">${esc(t('وصفة طبية', 'Prescription'))}</div>
  </header>
  <section class="info">
    ${info
      .filter(([, value]) => value)
      .map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
      .join('')}
  </section>
  <div class="rx">
    <div class="rx-mark">&#8478;</div>
    <div class="rx-body">${esc(prescription)}</div>
  </div>
  <footer>
    <div class="note">${esc(t('طُبعت بتاريخ', 'Printed on'))} ${esc(formatDate(new Date().toISOString()))}</div>
    <div class="sign">${esc(doctor || t('توقيع الطبيب', 'Doctor signature'))}</div>
  </footer>
</body>
</html>`;

    this.printHtml(html);
  }

  protected deleteRecord(entry: TimelineEntry): void {
    const record = this.records.getById(entry.id);
    if (!record) {
      return;
    }

    confirmDialog(this.dialog, {
      title: 'records.delete',
      message: 'records.deleteConfirm',
      messageParams: { date: new Date(record.occurredAt).toLocaleDateString() },
      confirmLabel: 'common.delete',
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (confirmed) {
        this.records.remove(record.id);
        this.notifications.success(this.translate.instant('records.deleted'), {
          detail: this.patient()?.name,
        });
      }
    });
  }

  protected editRecord(entry: TimelineEntry): void {
    const record = this.records.getById(entry.id);
    if (record) {
      this.addRecord(record);
    }
  }

  protected confirmDelete(): void {
    const patient = this.patient();
    if (!patient) {
      return;
    }

    confirmDialog(this.dialog, {
      title: 'patients.delete',
      message: 'patients.deleteConfirm',
      messageParams: { name: patient.name },
      confirmLabel: 'common.delete',
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      this.facade.remove(patient.id).subscribe(() => {
        this.notifications.success(this.translate.instant('patients.deleted'), {
          detail: patient.name,
        });
        void this.router.navigate(['/patients']);
      });
    });
  }

  private isArabic(): boolean {
    return (document.documentElement.lang || 'ar').toLowerCase().startsWith('ar');
  }

  /** A translation if the key exists, otherwise a built-in fallback - never a raw key on screen. */
  private label(key: string, arabic: string, english: string): string {
    const text = this.translate.instant(key);
    return text && text !== key ? text : this.isArabic() ? arabic : english;
  }

  private clinicName(): string {
    // The settings shape may name this field differently; read it defensively.
    const values = this.settings.settings() as unknown as Record<string, unknown>;
    const name = values['clinicName'] ?? values['name'];
    return typeof name === 'string' && name.trim()
      ? name
      : this.isArabic()
        ? 'العيادة'
        : 'Clinic';
  }

  /** Prints a standalone HTML document through a hidden frame and cleans up afterwards. */
  private printHtml(html: string): void {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);

    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument;
    if (!frameWindow || !frameDocument) {
      frame.remove();
      return;
    }

    frameDocument.open();
    frameDocument.write(html);
    frameDocument.close();

    const cleanup = (): void => frame.remove();
    frameWindow.onafterprint = cleanup;
    // Some browsers never fire afterprint; don't leave the frame behind forever.
    setTimeout(cleanup, 60_000);

    // Give the new document a moment to lay out before the print dialog opens.
    setTimeout(() => {
      frameWindow.focus();
      frameWindow.print();
    }, 150);
  }

  private load(): void {
    this.loading.set(true);
    const id = this.patientId();

    forkJoin({
      patient: this.facade.get(id),
      // Filtered client-side: the endpoint takes a patient *name*, which is not
      // unique enough to trust for a clinical record.
      appointments: this.appointmentsApi
        .getAppointments({ patientId: id, pageIndex: 1, pageSize: 100 })
        .pipe(catchError(() => of({ pageIndex: 1, pageSize: 0, count: 0, data: [] }))),
      doctors: this.doctorsApi
        .getDoctors({ pageIndex: 1, pageSize: 100 })
        .pipe(catchError(() => of({ pageIndex: 1, pageSize: 0, count: 0, data: [] }))),
    }).subscribe({
      next: ({ patient, appointments, doctors }) => {
        this.patient.set(patient);
        this.appointments.set(appointments.data.filter((entry) => entry.patientId === id || !entry.patientId));
        this.doctors.set(doctors.data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  private factsFor(record: MedicalRecord): { label: string; value: string }[] {
    const facts: { label: string; value: string }[] = [];
    const vitals = record.vitals;

    if (vitals?.bloodPressure) {
      facts.push({ label: 'records.bloodPressure', value: vitals.bloodPressure });
    }
    if (vitals?.temperature !== undefined) {
      facts.push({ label: 'records.temperature', value: `${vitals.temperature} °C` });
    }
    if (vitals?.pulse !== undefined) {
      facts.push({ label: 'records.pulse', value: `${vitals.pulse} bpm` });
    }
    if (vitals?.weight !== undefined) {
      facts.push({ label: 'records.weight', value: `${vitals.weight} kg` });
    }
    if (record.prescription) {
      facts.push({ label: 'records.prescription', value: record.prescription });
    }

    return facts;
  }
}