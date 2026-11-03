import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { SpecialtyService } from '../../../core/i18n/specialty.service';
import { Doctor } from '../../../core/models/doctor.model';
import { DoctorSchedule } from '../../../core/models/schedule.model';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import { SchedulesService } from '../../../core/services/schedules.service';
import { timeToMinutes } from '../../../core/utils/date.util';
import { SpecialtyPipe } from '../../../shared/pipes/specialty.pipe';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import {
  SearchEvent,
  SearchFieldComponent,
} from '../../../shared/ui/search-field/search-field.component';
import {
  DoctorDialogData,
  DoctorFormDialogComponent,
} from '../dialogs/doctor-form-dialog.component';

interface DoctorCard {
  doctor: Doctor;
  workingDays: string;
  weeklyHours: number;
  hasSchedule: boolean;
  serviceCount: number;
}

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

/**
 * Doctors are shown as cards rather than table rows.
 *
 * There are rarely more than a couple of dozen, and the thing staff need from
 * this screen — "who is this, what do they do, when are they in, can I book
 * them" — is a profile, not a row of columns.
 */
@Component({
  selector: 'app-doctor-list',
  imports: [
    RouterLink,
    MatButtonModule,
    MatTooltipModule,
    TranslatePipe,
    SpecialtyPipe,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
    SearchFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './doctor-list.component.html',
  styleUrl: './doctor-list.component.scss',
})
export class DoctorListComponent {
  private readonly api = inject(DoctorsService);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly schedulesApi = inject(SchedulesService);
  private readonly specialty = inject(SpecialtyService);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly schedules = signal<DoctorSchedule[]>([]);
  protected readonly loading = signal(true);
  protected readonly search = signal('');

  protected readonly cards = computed<DoctorCard[]>(() => {
    const term = this.search().trim().toLowerCase();
    const specialtyLabel = this.specialty.label();

    return this.doctors()
      .filter(
        (doctor) =>
          !term ||
          doctor.name.toLowerCase().includes(term) ||
          doctor.specialization.toLowerCase().includes(term) ||
          // Also matched on the label the user can actually see: searching
          // "أطفال" has to find the doctor whose column reads "طب الأطفال",
          // even though the database says "Pediatrics".
          specialtyLabel(doctor.specialization).toLowerCase().includes(term) ||
          // A service name finds the doctors who provide it.
          (doctor.services ?? []).some((service) => service.name.toLowerCase().includes(term))
      )
      .map((doctor) => {
        const own = this.schedules().filter((schedule) => schedule.doctorId === doctor.id);
        const days = [...new Set(own.map((schedule) => schedule.weekDay))].sort((a, b) => a - b);
        const minutes = own.reduce(
          (sum, schedule) =>
            sum + Math.max(0, timeToMinutes(schedule.endTime) - timeToMinutes(schedule.startTime)),
          0
        );

        return {
          doctor,
          workingDays: days
            .map((day) => this.translate.instant(`weekday.short.${day}`))
            .join(' · '),
          weeklyHours: Math.round((minutes / 60) * 10) / 10,
          hasSchedule: own.length > 0,
          serviceCount: doctor.services?.length ?? 0,
        };
      });
  });

  protected readonly knownSpecializations = computed(() => [
    ...new Set(this.doctors().map((doctor) => doctor.specialization).filter(Boolean)),
  ]);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);

    forkJoin({
      doctors: this.api
        .getDoctors({ pageIndex: 1, pageSize: 200 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      schedules: this.schedulesApi
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

  protected onSearch(event: SearchEvent): void {
    this.search.set(event.term);
  }

  protected openForm(doctor?: Doctor): void {
    this.dialog
      .open<DoctorFormDialogComponent, DoctorDialogData, boolean>(DoctorFormDialogComponent, {
        data: { doctor, knownSpecializations: this.knownSpecializations() },
      })
      .afterClosed()
      .subscribe((saved) => {
        if (saved) {
          this.load();
        }
      });
  }

  protected confirmDelete(doctor: Doctor): void {
    confirmDialog(this.dialog, {
      title: 'doctors.delete',
      message: 'doctors.deleteConfirm',
      messageParams: { name: doctor.name },
      confirmLabel: 'common.delete',
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      this.api.deleteDoctor(doctor.id).subscribe(() => {
        this.notifications.success(this.translate.instant('doctors.deleted'), {
          detail: doctor.name,
        });
        this.load();
      });
    });
  }

  protected book(doctor: Doctor): void {
    void this.router.navigate(['/appointments/new'], { queryParams: { doctorId: doctor.id } });
  }
}