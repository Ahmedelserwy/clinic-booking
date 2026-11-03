import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Observable, Subscription, catchError, forkJoin, map, of, switchMap } from 'rxjs';

import { PermissionService } from '../../../core/authz/permission.service';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { parseDate } from '../../../core/utils/date.util';
import { DataTableComponent } from '../../../shared/ui/data-table/data-table.component';
import {
  CellTemplateDirective,
  PageState,
  SortState,
  TableColumn,
} from '../../../shared/ui/data-table/data-table.model';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';
import {
  SearchEvent,
  SearchFieldComponent,
} from '../../../shared/ui/search-field/search-field.component';
import { FollowUpInfo, PatientView, PatientsFacade, followUpInfo } from '../patients.facade';

@Component({
  selector: 'app-patient-list',
  imports: [
    RouterLink,
    MatButtonModule,
    TranslatePipe,
    CellTemplateDirective,
    DataTableComponent,
    IconComponent,
    PageHeaderComponent,
    SearchFieldComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './patient-list.component.html',
  styleUrl: './patient-list.component.scss',
})
export class PatientListComponent {
  private readonly appointmentsApi = inject(AppointmentsService);
  private readonly facade = inject(PatientsFacade);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly permissions = inject(PermissionService);

  protected readonly rows = signal<PatientView[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly search = signal<SearchEvent | null>(null);
  protected readonly page = signal<PageState>({ pageIndex: 1, pageSize: 10 });
  protected readonly sort = signal<SortState>({ key: 'name', direction: 'asc' });

  /** Last visit per patient id for the rows on screen; absent or `null` means no past appointment. */
  protected readonly lastVisits = signal<Record<number, Date | null>>({});
  private loadRequest?: Subscription;

  /** Follows the language switch in the toolbar, so dates re-render when it changes. */
  private readonly language = toSignal(
    this.translate.onLangChange.pipe(map((event) => event.lang)),
    { initialValue: document.documentElement.lang || 'ar' }
  );

  /** Day, month name and year in the active language, with Latin digits to match the rest of the table. */
  private readonly visitFormat = computed(
    () =>
      new Intl.DateTimeFormat(
        this.language().toLowerCase().startsWith('ar') ? 'ar-EG-u-nu-latn' : 'en-GB',
        { day: 'numeric', month: 'long', year: 'numeric' }
      )
  );

  protected readonly hasFilters = computed(() => Boolean(this.search()?.term));

  protected readonly columns: TableColumn<PatientView>[] = [
    {
      key: 'fileNumber',
      header: 'patients.fileNumber',
      value: (row) => row.profile.fileNumber,
      variant: 'mono',
      width: '120px',
      hideBelow: 'md',
    },
    { key: 'name', header: 'patients.name', sortKey: 'name', value: (row) => row.name },
    {
      key: 'age',
      header: 'patients.age',
      value: (row) => (row.age === null ? '—' : row.age),
      align: 'center',
      width: '80px',
      hideBelow: 'sm',
    },
    {
      key: 'gender',
      header: 'patients.gender',
      variant: 'badge',
      width: '110px',
      hideBelow: 'md',
      badge: (row) => ({
        label:
          row.gender === 'Male'
            ? 'patients.genderMale'
            : row.gender === 'Female'
              ? 'patients.genderFemale'
              : 'patients.genderOther',
        tone: 'neutral',
      }),
    },
    { key: 'phone', header: 'patients.phone', value: (row) => row.phone, hideBelow: 'sm' },
    {
      key: 'lastVisit',
      header: 'patients.lastVisit',
      value: () => '',
      width: '150px',
      hideBelow: 'md',
    },
    {
      key: 'medical',
      header: 'patients.sectionMedical',
      value: () => '',
      width: '170px',
      hideBelow: 'lg',
    },
  ];

  /** The medical column is a column of dashes until at least one patient on the page has a flag. */
  protected readonly visibleColumns = computed(() =>
    this.rows().some((row) => this.medicalFlags(row).length > 0)
      ? this.columns
      : this.columns.filter((column) => column.key !== 'medical')
  );

  constructor() {
    this.load();
  }

  protected load(): void {
    // A newer load (paging, searching) cancels the one still in flight.
    this.loadRequest?.unsubscribe();
    this.loading.set(true);

    this.loadRequest = this.facade
      .list({
        ...this.page(),
        sort: this.sort().direction === 'desc' ? 'Desc' : 'Asc',
        search: this.search(),
      })
      .pipe(
        // The rows are held back until their last-visit dates are in, so the table
        // appears once, complete, instead of filling in a column a few seconds later.
        switchMap((result) =>
          this.fetchLastVisits(result.data).pipe(map((visits) => ({ result, visits })))
        )
      )
      .subscribe({
        next: ({ result, visits }) => {
          this.lastVisits.set(visits);
          this.rows.set(result.data);
          this.total.set(result.count);
          this.loading.set(false);
        },
        error: () => {
          this.lastVisits.set({});
          this.rows.set([]);
          this.total.set(0);
          this.loading.set(false);
        },
      });
  }

  protected onSearch(event: SearchEvent): void {
    this.search.set(event.term ? event : null);
    this.page.update((page) => ({ ...page, pageIndex: 1 }));
    this.load();
  }

  protected onSort(sort: SortState): void {
    this.sort.set(sort);
    this.load();
  }

  protected onPage(page: PageState): void {
    this.page.set(page);
    this.load();
  }

  protected clearFilters(): void {
    this.search.set(null);
    this.page.update((page) => ({ ...page, pageIndex: 1 }));
    this.load();
  }

  /**
   * The whole row opens the patient file. Editing and deleting live inside the
   * file (behind their own permissions and a confirmation), so the list has no
   * per-row buttons to mis-click.
   */
  protected openPatient(row: PatientView): void {
    void this.router.navigate(['/patients', row.id]);
  }

  /** Set when the doctor's follow-up date is today (or missed) and the patient has not been back since. */
  protected followUpFor(row: PatientView): FollowUpInfo | null {
    return followUpInfo(this.facade.followUpDateFor(row.id), this.lastVisits()[row.id]);
  }

  protected formatVisit(date: Date): string {
    return this.visitFormat().format(date);
  }

  /** The most recent past appointment, or null/undefined if the patient has never visited. */
  protected lastVisitFor(row: PatientView): Date | null | undefined {
    return this.lastVisits()[row.id];
  }

  /**
   * Fetches the appointments of the patients on this page in parallel and keeps the
   * most recent one that is already in the past. Same rule as the patient file, so
   * the list and the file never disagree. Never errors: a failed lookup is just "no visit".
   */
  private fetchLastVisits(patients: PatientView[]): Observable<Record<number, Date | null>> {
    if (!patients.length) {
      return of({});
    }

    const now = Date.now();

    return forkJoin(
      patients.map((patient) =>
        this.appointmentsApi
          .getAppointments({ patientId: patient.id, pageIndex: 1, pageSize: 100 })
          .pipe(
            map((result) => {
              let latest: Date | null = null;
              for (const entry of result.data) {
                if (entry.patientId && entry.patientId !== patient.id) {
                  continue;
                }
                const date = parseDate(entry.appointmentDate);
                if (date && date.getTime() <= now && (!latest || date > latest)) {
                  latest = date;
                }
              }
              return [patient.id, latest] as const;
            }),
            catchError(() => of([patient.id, null] as const))
          )
      )
    ).pipe(map((entries) => Object.fromEntries(entries)));
  }

  /** A stable colour per patient, so rows are easier to tell apart at a glance. */
  protected hue(name: string): number {
    return ((name.codePointAt(0) ?? 0) * 47) % 360;
  }

  /** wa.me wants the number with country code and no symbols; Egyptian 01x numbers become 201x. */
  protected whatsappUrl(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    const international = digits.startsWith('00')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? `20${digits.slice(1)}`
        : digits;
    return `https://wa.me/${international}`;
  }

  /** Compact summary of the clinical flags that change how a patient is handled. */
  protected medicalFlags(row: PatientView): { label: string; tone: string; title: string | null }[] {
    const flags: { label: string; tone: string; title: string | null }[] = [];

    // The badge shows the count; hovering names what it counts, so "2" is never a mystery.
    if (row.profile.allergies.length) {
      flags.push({
        label: `${row.profile.allergies.length}`,
        tone: 'danger',
        title: this.titleFor('patients.allergies'),
      });
    }
    if (row.profile.chronicDiseases.length) {
      flags.push({
        label: `${row.profile.chronicDiseases.length}`,
        tone: 'warning',
        title: this.titleFor('patients.chronicDiseases'),
      });
    }
    if (row.profile.bloodGroup) {
      flags.push({ label: row.profile.bloodGroup, tone: 'info', title: null });
    }

    return flags;
  }

  /** A translated tooltip, or nothing if the key is missing - never a raw key shown to the user. */
  private titleFor(key: string): string | null {
    const text = this.translate.instant(key);
    return text && text !== key ? text : null;
  }
}