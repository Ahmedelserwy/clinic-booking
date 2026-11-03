import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { SpecialtyService } from '../../../core/i18n/specialty.service';
import {
  APPOINTMENT_STATUSES,
  Appointment,
  AppointmentStatus,
} from '../../../core/models/appointment.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { NotificationService } from '../../../core/services/notification.service';
import { statusConfig } from '../../../core/utils/appointment-status.util';
import { appointmentDuration, appointmentStart } from '../../../core/utils/appointment-time.util';
import { formatTime12 } from '../../../core/utils/date.util';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { DetailItem, DetailListComponent } from '../../../shared/ui/detail-list/detail-list.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';

export interface AppointmentQuickViewData {
  appointment: Appointment;
  /** Clinic slot length, used when the row predates stored end times. */
  fallbackDurationMinutes: number;
  /** The doctor's speciality, for the extra context line. */
  specialization: string | null;
  /**
   * Whether the signed-in user may change this appointment.
   *
   * Decided by the caller, which knows both the permission grant and the backend
   * role rule — `PUT`/`DELETE /Appointments` are `[Authorize(Roles =
   * "Admin,Doctor")]`, so offering the buttons to anyone else would produce a
   * 403 the user cannot act on.
   */
  canEdit: boolean;
  canCancel: boolean;
}

/** `true` when something changed and the calendar should reload. */
export type AppointmentQuickViewResult = boolean;

/**
 * The appointment behind a block, and what can be done to it.
 *
 * A dialog rather than a route: clicking a block should not lose the day the
 * user has navigated to, and the common actions (confirm, check the notes, move
 * on) all finish in the same place they started. The full record stays one click
 * further in, on the existing detail route.
 */
@Component({
  selector: 'app-appointment-quick-view',
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    TranslatePipe,
    DetailListComponent,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="quick-head">
      <span class="icon-tile icon-tile-lg" [style.background]="config().surface">
        <ui-icon [name]="config().icon" size="lg" [style.color]="config().accent" />
      </span>

      <div class="quick-titles">
        <h2 mat-dialog-title class="quick-title">{{ appointment.patientName }}</h2>
        <p class="quick-sub">{{ whenLabel() }}</p>
      </div>

      <span class="badge" [class]="'badge-' + config().tone">
        {{ config().label | translate }}
      </span>
    </div>

    <mat-dialog-content class="quick-body">
      <ui-detail-list [items]="details()" />

      @if (data.canEdit) {
        <div class="status-row">
          <mat-form-field class="status-field">
            <mat-label>{{ 'appointments.changeStatus' | translate }}</mat-label>
            <mat-select [value]="appointment.status" (valueChange)="onStatus($event)">
              @for (status of statuses; track status) {
                <mat-option [value]="status">
                  {{ 'appointments.status' + status | translate }}
                </mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>
      }
    </mat-dialog-content>

    <mat-dialog-actions class="quick-actions">
      @if (data.canCancel && appointment.status !== 'Cancelled') {
        <button mat-button type="button" class="btn-danger-text" (click)="cancel()">
          <ui-icon name="calendarX" size="sm" />
          {{ 'appointments.delete' | translate }}
        </button>
      }

      <span class="spacer"></span>

      <button mat-button type="button" (click)="close()">{{ 'common.close' | translate }}</button>

      <button mat-stroked-button type="button" (click)="viewFull()">
        <ui-icon name="show" size="sm" />
        {{ 'common.details' | translate }}
      </button>

      @if (data.canEdit) {
        <button mat-flat-button type="button" (click)="reschedule()">
          <ui-icon name="edit" size="sm" />
          {{ 'appointments.edit' | translate }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .quick-head {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
      padding: var(--sp-5) var(--sp-5) var(--sp-3);
    }

    .quick-titles {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }

    .quick-title {
      padding: 0 !important;
      margin: 0 !important;
      font-size: var(--fs-lg) !important;
      font-weight: var(--fw-semibold) !important;
    }

    .quick-sub {
      font-size: var(--fs-sm);
      color: var(--c-text-muted);
    }

    .quick-body {
      padding-inline: var(--sp-5) !important;
    }

    .status-row {
      margin-block-start: var(--sp-4);
    }

    .status-field {
      width: 100%;
    }

    .quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2);
      padding: var(--sp-3) var(--sp-5) var(--sp-5) !important;
    }

    .spacer {
      flex: 1 1 auto;
    }

    .btn-danger-text {
      color: var(--c-danger);
    }
  `,
})
export class AppointmentQuickViewComponent {
  private readonly api = inject(AppointmentsService);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly specialty = inject(SpecialtyService);
  private readonly translate = inject(TranslateService);

  readonly dialogRef =
    inject<MatDialogRef<AppointmentQuickViewComponent, AppointmentQuickViewResult>>(MatDialogRef);
  readonly data = inject<AppointmentQuickViewData>(MAT_DIALOG_DATA);

  protected readonly statuses = APPOINTMENT_STATUSES;
  protected readonly appointment = this.data.appointment;

  /** Set once anything is written, so closing tells the calendar to reload. */
  private readonly changed = signal(false);

  protected readonly config = computed(() => statusConfig(this.appointment.status));

  protected readonly whenLabel = computed(() => {
    const start = appointmentStart(this.appointment);
    if (!start) {
      return '';
    }

    const duration = appointmentDuration(this.appointment, this.data.fallbackDurationMinutes);
    const startMinutes = start.getHours() * 60 + start.getMinutes();

    // Intl formats the date in the active language; the times are the app's
    // pinned 12-hour form, which is the one thing that must not follow locale.
    const date = start.toLocaleDateString(this.translate.getCurrentLang() ?? undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    return `${date} · ${formatTime12(startMinutes)} – ${formatTime12(startMinutes + duration)}`;
  });

  protected readonly details = computed<DetailItem[]>(() => {
    const appointment = this.appointment;
    const start = appointmentStart(this.appointment);
    const duration = appointmentDuration(appointment, this.data.fallbackDurationMinutes);
    const startMinutes = start ? start.getHours() * 60 + start.getMinutes() : null;

    return [
      {
        label: 'appointments.patient',
        value: appointment.patientName,
        icon: 'user',
        tone: 'strong',
      },
      { label: 'appointments.doctor', value: appointment.doctorName, icon: 'doctors' },
      ...(this.data.specialization
        ? [
            {
              label: 'doctors.specialization',
              value: this.specialty.label()(this.data.specialization),
              icon: 'vitals' as const,
            },
          ]
        : []),
      {
        label: 'common.startTime',
        value: startMinutes === null ? null : formatTime12(startMinutes),
        icon: 'clock',
        tone: 'strong',
      },
      {
        label: 'common.endTime',
        value: startMinutes === null ? null : formatTime12(startMinutes + duration),
        icon: 'clock',
      },
      {
        label: 'appointments.duration',
        value: this.translate.instant('appointments.minutes', { count: duration }),
      },
      ...(appointment.notes
        ? [{ label: 'common.notes', value: appointment.notes, icon: 'note' as const }]
        : []),
    ];
  });

  protected onStatus(status: AppointmentStatus): void {
    if (status === this.appointment.status) {
      return;
    }

    this.api
      .changeStatus(this.appointment, status, this.data.fallbackDurationMinutes)
      .subscribe(() => {
        this.notifications.success(this.translate.instant('appointments.statusChanged'));
        this.changed.set(true);
        this.dialogRef.close(true);
      });
  }

  protected cancel(): void {
    confirmDialog(this.dialog, {
      title: 'appointments.delete',
      message: 'appointments.deleteConfirm',
      messageParams: {
        patient: this.appointment.patientName,
        date: new Date(this.appointment.appointmentDate).toLocaleDateString(),
      },
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      // Cancelling sets the status instead of deleting the row, so the booking
      // stays on the calendar as Cancelled and in its legend count.
      this.api
        .cancelAppointment(this.appointment, this.data.fallbackDurationMinutes)
        .subscribe(() => {
          this.notifications.success(this.translate.instant('appointments.statusChanged'));
          this.dialogRef.close(true);
        });
    });
  }

  protected reschedule(): void {
    this.dialogRef.close(this.changed());
    void this.router.navigate(['/appointments', this.appointment.id, 'edit']);
  }

  protected viewFull(): void {
    this.dialogRef.close(this.changed());
    void this.router.navigate(['/appointments', this.appointment.id]);
  }

  protected close(): void {
    this.dialogRef.close(this.changed());
  }
}