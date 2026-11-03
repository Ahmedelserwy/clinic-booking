import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { PermissionService } from '../../../core/authz/permission.service';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { Appointment } from '../../../core/models/appointment.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { NotificationService } from '../../../core/services/notification.service';
import {
  appointmentStatusLabel,
  appointmentStatusTone,
  deriveAppointmentStatus,
  lifecycleStatusLabel,
  lifecycleStatusTone,
} from '../../../core/utils/appointment-status.util';
import { appointmentDuration } from '../../../core/utils/appointment-time.util';
import { formatTime12, parseDate } from '../../../core/utils/date.util';
import { CardComponent } from '../../../shared/ui/card/card.component';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { DetailItem, DetailListComponent } from '../../../shared/ui/detail-list/detail-list.component';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';

@Component({
  selector: 'app-appointment-detail',
  imports: [
    RouterLink,
    MatButtonModule,
    TranslatePipe,
    CardComponent,
    DetailListComponent,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appointment-detail.component.html',
  styleUrl: './appointment-detail.component.scss',
})
export class AppointmentDetailComponent {
  private readonly api = inject(AppointmentsService);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  readonly id = input.required<string>();

  protected readonly appointment = signal<Appointment | null>(null);
  protected readonly loading = signal(true);

  protected readonly status = computed(() => {
    const appointment = this.appointment();
    return appointment ? deriveAppointmentStatus(appointment.appointmentDate) : 'Upcoming';
  });

  protected readonly statusLabel = computed(() => appointmentStatusLabel(this.status()));
  protected readonly statusTone = computed(() => appointmentStatusTone(this.status()));
  protected readonly isPast = computed(() => this.status() === 'Past');

  /** A cancelled or completed visit has nothing left to move or cancel. */
  protected readonly isClosed = computed(() => {
    const stored = this.appointment()?.status;
    return stored === 'Cancelled' || stored === 'Completed';
  });

  // The stored lifecycle status, shown beside the time-derived one. Two badges
  // rather than one because they answer different questions and can legitimately
  // disagree — a cancelled appointment is still "Today".
  protected readonly lifecycle = computed(() => this.appointment()?.status ?? 'Pending');
  protected readonly lifecycleLabel = computed(() => lifecycleStatusLabel(this.lifecycle()));
  protected readonly lifecycleTone = computed(() => lifecycleStatusTone(this.lifecycle()));

  protected readonly details = computed<DetailItem[]>(() => {
    const appointment = this.appointment();
    if (!appointment) {
      return [];
    }

    const when = parseDate(appointment.appointmentDate);
    // The stored length, not the clinic's current slot size: an appointment
    // booked when slots were 30 minutes long still runs 30 minutes after someone
    // changes the setting to 45.
    const slotMinutes = appointmentDuration(appointment, this.settings.settings().slotMinutes);

    return [
      { label: 'appointments.patient', value: appointment.patientName, icon: 'user', tone: 'strong' },
      { label: 'appointments.doctor', value: appointment.doctorName, icon: 'doctors' },
      {
        label: 'appointments.date',
        value: when
          ? when.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : null,
        icon: 'appointments',
      },
      {
        label: 'appointments.time',
        value: when ? formatTime12(when) : null,
        icon: 'clock',
        tone: 'strong',
      },
      {
        label: 'appointments.duration',
        value: this.translate.instant('appointments.minutes', { count: slotMinutes }),
      },
      // Rendered only when there is something to say — an empty "Notes: —" row
      // is noise on every appointment that has none.
      ...(appointment.notes
        ? [{ label: 'common.notes', value: appointment.notes, icon: 'note' as const }]
        : []),
    ];
  });

  constructor() {
    queueMicrotask(() => this.load());
  }

  protected reschedule(): void {
    void this.router.navigate(['/appointments', this.id(), 'edit']);
  }

  protected cancel(): void {
    const appointment = this.appointment();
    if (!appointment) {
      return;
    }

    confirmDialog(this.dialog, {
      title: 'appointments.delete',
      message: 'appointments.deleteConfirm',
      messageParams: {
        patient: appointment.patientName,
        date: new Date(appointment.appointmentDate).toLocaleDateString(),
      },
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      // Cancelling marks the booking Cancelled rather than deleting it, so the
      // calendar keeps the record and its "Cancelled" count.
      this.api
        .cancelAppointment(appointment, this.settings.settings().slotMinutes)
        .subscribe(() => {
          this.notifications.success(this.translate.instant('appointments.statusChanged'), {
            detail: `${appointment.patientName} · ${appointment.doctorName}`,
          });
          void this.router.navigate(['/appointments']);
        });
    });
  }

  private load(): void {
    this.loading.set(true);
    this.api.getAppointment(Number(this.id())).subscribe({
      next: (appointment) => {
        this.appointment.set(appointment);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}