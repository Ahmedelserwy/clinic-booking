import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, forkJoin, of } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { Appointment, AppointmentTimeStatus } from '../../../core/models/appointment.model';
import { Doctor } from '../../../core/models/doctor.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { DoctorsService } from '../../../core/services/doctors.service';
import { NotificationService } from '../../../core/services/notification.service';
import {
  appointmentStatusLabel,
  appointmentStatusTone,
  deriveAppointmentStatus,
  lifecycleStatusLabel,
  lifecycleStatusTone,
} from '../../../core/utils/appointment-status.util';
import { isSameDay, parseDate } from '../../../core/utils/date.util';
import { confirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog.component';
import { DataTableComponent } from '../../../shared/ui/data-table/data-table.component';
import {
  CellTemplateDirective,
  PageState,
  RowActionEvent,
  SortState,
  TableColumn,
  TableRowAction,
} from '../../../shared/ui/data-table/data-table.model';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import {
  SearchEvent,
  SearchFieldComponent,
} from '../../../shared/ui/search-field/search-field.component';

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

@Component({
  selector: 'app-appointment-list',
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
    CellTemplateDirective,
    DataTableComponent,
    IconComponent,
    PageHeaderComponent,
    SearchFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appointment-list.component.html',
  styleUrl: './appointment-list.component.scss',
})
export class AppointmentListComponent {
  private readonly api = inject(AppointmentsService);
  private readonly dialog = inject(MatDialog);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  protected readonly all = signal<Appointment[]>([]);
  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly loading = signal(true);

  protected readonly search = signal<SearchEvent | null>(null);
  protected readonly doctorId = signal<number | 'all'>('all');
  protected readonly status = signal<AppointmentTimeStatus | 'all'>('all');
  protected readonly day = signal<Date | null>(null);
  protected readonly page = signal<PageState>({ pageIndex: 1, pageSize: 25 });
  protected readonly sort = signal<SortState>({ key: 'appointmentDate', direction: 'desc' });

  protected readonly hasFilters = computed(
    () =>
      Boolean(this.search()?.term) ||
      this.doctorId() !== 'all' ||
      this.status() !== 'all' ||
      this.day() !== null
  );

  /**
   * Filtering runs client-side against one wide fetch.
   *
   * The endpoint can filter by doctor or patient id but not by date range or
   * derived status, and mixing server and client filters would make the pager
   * lie about the total. One source of truth is simpler and correct.
   */
  private readonly filtered = computed(() => {
    const term = this.search()?.term.toLowerCase() ?? '';
    const doctorId = this.doctorId();
    const status = this.status();
    const day = this.day();

    return this.all().filter((appointment) => {
      // Compared by id alone. The old code also matched on doctor name, because
      // the list endpoint returned a null doctorId for every row; now that the
      // specification eager-loads the navigation the id is always present, and
      // matching by name would have quietly conflated two doctors sharing one.
      if (doctorId !== 'all' && appointment.doctorId !== doctorId) {
        return false;
      }

      if (status !== 'all' && deriveAppointmentStatus(appointment.appointmentDate) !== status) {
        return false;
      }

      if (day) {
        const when = parseDate(appointment.appointmentDate);
        if (!when || !isSameDay(when, day)) {
          return false;
        }
      }

      if (term) {
        const haystack = `${appointment.patientName} ${appointment.doctorName}`.toLowerCase();
        if (!haystack.includes(term)) {
          return false;
        }
      }

      return true;
    });
  });

  protected readonly sorted = computed(() => {
    const { key, direction } = this.sort();
    const factor = direction === 'desc' ? -1 : 1;

    return [...this.filtered()].sort((a, b) => {
      const left = String(a[key as keyof Appointment] ?? '');
      const right = String(b[key as keyof Appointment] ?? '');
      return left.localeCompare(right, undefined, { numeric: true }) * factor;
    });
  });

  protected readonly total = computed(() => this.sorted().length);

  protected readonly rows = computed(() => {
    const { pageIndex, pageSize } = this.page();
    const start = (pageIndex - 1) * pageSize;
    return this.sorted().slice(start, start + pageSize);
  });

  protected readonly todayCount = computed(
    () =>
      this.all().filter(
        (appointment) => deriveAppointmentStatus(appointment.appointmentDate) === 'Today'
      ).length
  );

  protected readonly columns: TableColumn<Appointment>[] = [
    {
      key: 'appointmentDate',
      header: 'appointments.date',
      sortKey: 'appointmentDate',
      value: (row) => row.appointmentDate,
      width: '190px',
    },
    {
      key: 'patientName',
      header: 'appointments.patient',
      sortKey: 'patientName',
      value: (row) => row.patientName,
      variant: 'strong',
    },
    {
      key: 'doctorName',
      header: 'appointments.doctor',
      sortKey: 'doctorName',
      value: (row) => row.doctorName,
      hideBelow: 'sm',
    },
    {
      // The stored lifecycle status, not the derived one. Before the API had a
      // status column this showed Upcoming/Today/Past, which could never say
      // "Cancelled" — the one thing a status column most needs to say.
      key: 'status',
      header: 'common.status',
      variant: 'badge',
      width: '130px',
      badge: (row) => ({
        label: lifecycleStatusLabel(row.status),
        tone: lifecycleStatusTone(row.status),
      }),
    },
    {
      // The time dimension, kept as its own column so the filter above it still
      // has something to point at.
      key: 'timing',
      header: 'appointments.timing',
      variant: 'badge',
      width: '120px',
      hideBelow: 'md',
      badge: (row) => {
        const timing = deriveAppointmentStatus(row.appointmentDate);
        return {
          label: appointmentStatusLabel(timing),
          tone: appointmentStatusTone(timing),
          dot: timing === 'Today',
        };
      },
    },
  ];

  protected readonly rowActions: TableRowAction<Appointment>[] = [
    { id: 'view', icon: 'show', label: 'common.view' },
    {
      id: 'edit',
      icon: 'edit',
      label: 'appointments.edit',
      // A past appointment cannot be moved — its slot no longer exists — and a
      // cancelled or completed one has nothing left to move.
      visible: (row) =>
        deriveAppointmentStatus(row.appointmentDate) !== 'Past' &&
        row.status !== 'Cancelled' &&
        row.status !== 'Completed',
    },
    {
      id: 'delete',
      icon: 'delete',
      label: 'appointments.delete',
      tone: 'danger',
      visible: (row) => row.status !== 'Cancelled' && row.status !== 'Completed',
    },
  ];

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);

    forkJoin({
      appointments: this.api
        .getAppointments({ pageIndex: 1, pageSize: 500, sort: 'Descending' })
        .pipe(catchError(() => of(EMPTY_PAGE))),
      doctors: this.doctorsApi
        .getDoctors({ pageIndex: 1, pageSize: 200 })
        .pipe(catchError(() => of(EMPTY_PAGE))),
    }).subscribe({
      next: ({ appointments, doctors }) => {
        this.all.set(appointments.data as Appointment[]);
        this.doctors.set(doctors.data as Doctor[]);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected onSearch(event: SearchEvent): void {
    this.search.set(event.term ? event : null);
    this.resetPage();
  }

  protected onDoctor(value: number | 'all'): void {
    this.doctorId.set(value);
    this.resetPage();
  }

  protected onStatus(value: AppointmentTimeStatus | 'all'): void {
    this.status.set(value);
    this.resetPage();
  }

  protected onDay(value: Date | null): void {
    this.day.set(value);
    this.resetPage();
  }

  protected onSort(sort: SortState): void {
    this.sort.set(sort);
  }

  protected onPage(page: PageState): void {
    this.page.set(page);
  }

  protected clearFilters(): void {
    this.search.set(null);
    this.doctorId.set('all');
    this.status.set('all');
    this.day.set(null);
    this.resetPage();
  }

  protected showToday(): void {
    this.day.set(new Date());
    this.status.set('all');
    this.resetPage();
  }

  protected openAppointment(row: Appointment): void {
    void this.router.navigate(['/appointments', row.id]);
  }

  protected onRowAction(event: RowActionEvent<Appointment>): void {
    switch (event.action) {
      case 'view':
        this.openAppointment(event.row);
        break;
      case 'edit':
        void this.router.navigate(['/appointments', event.row.id, 'edit']);
        break;
      case 'delete':
        this.confirmCancel(event.row);
        break;
    }
  }

  protected statusOf(row: Appointment): AppointmentTimeStatus {
    return deriveAppointmentStatus(row.appointmentDate);
  }

  private confirmCancel(row: Appointment): void {
    confirmDialog(this.dialog, {
      title: 'appointments.delete',
      message: 'appointments.deleteConfirm',
      messageParams: {
        patient: row.patientName,
        date: new Date(row.appointmentDate).toLocaleDateString(),
      },
      confirmLabel: 'common.confirm',
      tone: 'danger',
    }).subscribe((confirmed) => {
      if (!confirmed) {
        return;
      }

      // Marked Cancelled, not removed, so the status column can show it.
      this.api
        .cancelAppointment(row, this.settings.settings().slotMinutes)
        .subscribe(() => {
          this.notifications.success(this.translate.instant('appointments.statusChanged'), {
            detail: `${row.patientName} · ${row.doctorName}`,
          });
          this.load();
        });
    });
  }

  private resetPage(): void {
    this.page.update((page) => ({ ...page, pageIndex: 1 }));
  }
}