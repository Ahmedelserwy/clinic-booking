import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';

 import { ReexaminationPolicy,DEFAULT_REEXAMINATION } from '../../../core/services/Doctor service.model';
import { FieldErrorComponent } from '../../../shared/ui/field-error/field-error.component';

export interface ReexaminationDialogData {
  policy: ReexaminationPolicy;
  /** The doctor's regular fee, shown for comparison. */
  consultationFee: number | null;
}

/**
 * Re-examination settings for one doctor.
 *
 * Returns the policy on save and nothing on cancel. It does not call the API:
 * it is opened from the doctor form, which sends the policy together with the
 * rest of the profile in one request.
 */
@Component({
  selector: 'app-doctor-reexamination-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    FieldErrorComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ 'doctors.reexamTitle' | translate }}</h2>

    <mat-dialog-content>
      <form class="reexam-form" [formGroup]="form" novalidate>
        <p class="intro">{{ 'doctors.reexamIntro' | translate }}</p>

        <mat-checkbox formControlName="enabled">
          {{ 'doctors.reexamEnable' | translate }}
        </mat-checkbox>

        @if (form.controls.enabled.value) {
          <div class="fields">
            <div class="field">
              <mat-form-field>
                <mat-label>{{ 'doctors.reexamFee' | translate }}</mat-label>
                <input matInput type="number" formControlName="fee" min="0" step="1" />
                <mat-hint>{{ 'doctors.reexamFeeHint' | translate }}</mat-hint>
              </mat-form-field>
              <ui-field-error [control]="form.controls.fee" [submitted]="submitted()" />
            </div>

            <div class="field">
              <mat-form-field>
                <mat-label>{{ 'doctors.reexamValidDays' | translate }}</mat-label>
                <input matInput type="number" formControlName="validDays" min="1" step="1" />
                <mat-hint>{{ 'doctors.reexamValidDaysHint' | translate }}</mat-hint>
              </mat-form-field>
              <ui-field-error [control]="form.controls.validDays" [submitted]="submitted()" />
            </div>
          </div>

          @if (data.consultationFee != null) {
            <p class="note">
              {{ 'doctors.reexamRegularFee' | translate: { fee: data.consultationFee } }}
            </p>
          }
        }
      </form>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="dialogRef.close()">
        {{ 'common.cancel' | translate }}
      </button>
      <button mat-flat-button type="button" (click)="save()">
        {{ 'common.save' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .reexam-form {
      display: flex;
      flex-direction: column;
      gap: var(--sp-3);
      width: min(460px, 86vw);
      padding-block-start: var(--sp-1);
    }

    .intro,
    .note {
      margin: 0;
      color: var(--c-text-subtle);
      font-size: var(--fs-xs);
    }

    .note {
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm);
      background: var(--c-surface-2);
    }

    .fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--sp-2) var(--sp-3);
    }

    .field {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    @media (max-width: 520px) {
      .fields {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class DoctorReexaminationDialogComponent {
  private readonly formBuilder = inject(FormBuilder);

  readonly dialogRef =
    inject<MatDialogRef<DoctorReexaminationDialogComponent, ReexaminationPolicy>>(MatDialogRef);
  readonly data = inject<ReexaminationDialogData>(MAT_DIALOG_DATA);

  protected readonly submitted = signal(false);

  protected readonly form = this.formBuilder.nonNullable.group({
    enabled: [this.data.policy.enabled],
    fee: this.formBuilder.control<number | null>(this.data.policy.fee ?? 0, [
      Validators.required,
      Validators.min(0),
      Validators.max(1_000_000),
    ]),
    validDays: this.formBuilder.control<number | null>(this.data.policy.validDays, [
      Validators.required,
      Validators.min(1),
      Validators.max(365),
    ]),
  });

  protected save(): void {
    const raw = this.form.getRawValue();

    // Switched off: nothing to validate, and a half-typed fee must not block it.
    if (!raw.enabled) {
      this.dialogRef.close({
        ...DEFAULT_REEXAMINATION,
        validDays: this.data.policy.validDays,
        enabled: false,
      });
      return;
    }

    this.submitted.set(true);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.dialogRef.close({
      enabled: true,
      fee: raw.fee ?? 0,
      validDays: raw.validDays ?? DEFAULT_REEXAMINATION.validDays,
    });
  }
}