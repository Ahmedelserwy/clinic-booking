import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { AccountsStore } from '../../../core/data/accounts.store';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { Invoice, PaymentMethod, round2 } from '../../../core/data/finance.model';
import { Doctor } from '../../../core/models/doctor.model';
import { Patient } from '../../../core/models/patient.model';
import { AuthService } from '../../../core/services/auth.service';
import { NotificationService } from '../../../core/services/notification.service';
import { toDateOnly } from '../../../core/utils/date.util';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';

export interface InvoiceDialogData {
  patients: Patient[];
  doctors: Doctor[];
  invoice?: Invoice;
  patientId?: number;
}

type VisitType = 'examination' | 'followUp';

/**
 * Clinic invoice = one doctor + one visit type + one fee.
 * The fee comes from the doctor's consultation fee (set when the doctor is
 * added) and can be overridden for this invoice. Follow-up visits default to 0.
 *
 * Stored shape is unchanged: one line (qty 1, unitPrice = fee), no tax, no
 * discount, dueAt = issuedAt.
 */
@Component({
  selector: 'app-invoice-form-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
    FieldErrorComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invoice-form-dialog.component.html',
  styleUrl: './invoice-form-dialog.component.scss',
})
export class InvoiceFormDialogComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly auth = inject(AuthService);
  private readonly store = inject(AccountsStore);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly dialogRef = inject<MatDialogRef<InvoiceFormDialogComponent, boolean>>(MatDialogRef);
  readonly data = inject<InvoiceDialogData>(MAT_DIALOG_DATA);

  protected readonly isEdit = Boolean(this.data.invoice);
  protected readonly submitted = signal(false);
  protected readonly currency = this.settings.settings().currency;

  protected readonly form = this.formBuilder.nonNullable.group({
    patientId: this.formBuilder.control<number | null>(
      this.data.invoice?.patientId ?? this.data.patientId ?? null,
      [Validators.required]
    ),
    doctorId: this.formBuilder.control<number | null>(this.data.invoice?.doctorId ?? null, [
      Validators.required,
    ]),
    visitType: this.formBuilder.nonNullable.control<VisitType>(this.initialVisitType()),
    issuedAt: this.formBuilder.control<Date | null>(
      this.data.invoice ? new Date(this.data.invoice.issuedAt) : new Date(),
      [Validators.required]
    ),
    amount: [this.initialAmount(), [Validators.required, Validators.min(0)]],
    paymentMethod: this.formBuilder.nonNullable.control<PaymentMethod>('cash'),
    notes: [this.data.invoice?.notes ?? '', [Validators.maxLength(300)]],
  });

  constructor() {
    // Re-price whenever the doctor or visit type changes. Editing the amount by
    // hand afterwards is allowed; it stays until the next doctor/type change.
    const reprice = () => {
      const { doctorId, visitType } = this.form.getRawValue();
      this.form.controls.amount.setValue(this.feeFor(doctorId, visitType));
    };
    this.form.controls.doctorId.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(reprice);
    this.form.controls.visitType.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(reprice);
  }

  protected submit(): void {
    this.submitted.set(true);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const patient = this.data.patients.find((entry) => entry.id === raw.patientId);
    const doctor = this.data.doctors.find((entry) => entry.id === raw.doctorId);
    const issuedAt = toDateOnly(raw.issuedAt!);

    const payload = {
      patientId: raw.patientId!,
      patientName: patient?.name ?? '',
      doctorId: doctor?.id,
      doctorName: doctor?.name,
      issuedAt,
      dueAt: issuedAt,
      items: [
        {
          description: this.translate.instant(`accounts.${raw.visitType}`),
          quantity: 1,
          unitPrice: round2(Number(raw.amount) || 0),
        },
      ],
      discount: 0,
      taxRate: 0,
      notes: raw.notes.trim() || undefined,
      // The store derives paid/partial/unpaid from recorded payments; only
      // draft/void are ever authored. New invoices are paid via recordPayment below.
      status: this.data.invoice?.status ?? ('unpaid' as const),
    };

    if (this.data.invoice) {
      const invoice = this.data.invoice;
      this.store.updateInvoice(invoice.id, payload);

      // The payment follows the invoice: a changed fee, doctor or visit type changes what was
      // collected, and so what the reports show. With several payments on file the history is
      // left alone, because there is no single amount to change.
      const payments = this.store.payments().filter((payment) => payment.invoiceId === invoice.id);
      if (payments.length <= 1) {
        const previous = payments[0];
        if (previous) {
          this.store.removePayment(previous.id);
        }
        const fee = payload.items[0].unitPrice;
        if (fee > 0) {
          this.store.recordPayment({
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            patientName: payload.patientName,
            amount: fee,
            // An invoice edited from the list keeps the method it was paid with.
            method: previous?.method ?? raw.paymentMethod,
            reference: raw.visitType,
            paidAt: previous?.paidAt ?? `${issuedAt}T${new Date().toTimeString().slice(0, 8)}`,
            recordedBy: previous?.recordedBy || this.currentUserName(),
          });
        }
      }
    } else {
      const created = this.store.createInvoice(payload);
      const fee = payload.items[0].unitPrice;

      // No credit in a clinic: the patient pays at the counter, so the full
      // amount is recorded as received. A free visit (0) has nothing to collect.
      if (fee > 0) {
        this.store.recordPayment({
          invoiceId: created.id,
          invoiceNumber: created.number,
          patientName: payload.patientName,
          amount: fee,
          method: raw.paymentMethod,
          // The visit type travels with the payment so the reports can split by it.
          reference: raw.visitType,
          // Same local day as the invoice, so daily income and closing line up.
          paidAt: `${issuedAt}T${new Date().toTimeString().slice(0, 8)}`,
          recordedBy: this.currentUserName(),
        });
      }
    }

    this.notifications.success(this.translate.instant('settings.saved'));
    this.dialogRef.close(true);
  }

  /** Who is at the desk: shown as "received by" in the reports. */
  private currentUserName(): string {
    return this.auth.currentUser?.displayName ?? '';
  }

  private feeFor(doctorId: number | null, visitType: VisitType): number {
    if (visitType === 'followUp') {
      return 0;
    }
    const doctor = this.data.doctors.find((entry) => entry.id === doctorId);
    return doctor?.consultationFee ?? 0;
  }

  private initialVisitType(): VisitType {
    const description = this.data.invoice?.items[0]?.description;
    return description && description === this.translate.instant('accounts.followUp')
      ? 'followUp'
      : 'examination';
  }

  private initialAmount(): number {
    const invoice = this.data.invoice;
    if (!invoice) {
      return 0;
    }
    return round2(invoice.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
  }
}