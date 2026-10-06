import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap, timer } from 'rxjs';

import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { Appointment } from '../../../core/models/appointment.model';
import { Doctor } from '../../../core/models/doctor.model';
import { AppointmentsService } from '../../../core/services/appointments.service';
import { DoctorsService } from '../../../core/services/doctors.service';
import { appointmentStart } from '../../../core/utils/appointment-time.util';
import { addDays, isSameDay, startOfDay, toLocalIso } from '../../../core/utils/date.util';
import { SpecialtyPipe } from '../../../shared/pipes/specialty.pipe';

interface QueueEntry {
  appointment: Appointment;
  /** Position in today's list by time. Stable: it does not change when someone before them finishes. */
  no: number;
}

interface Tip {
  icon: string;
  title: string;
  body: string;
}

const EMPTY_PAGE = { pageIndex: 1, pageSize: 0, count: 0, data: [] };

/** How often the screen re-reads today's appointments. */
const REFRESH_MS = 15_000;
/** How long each instruction stays on screen. Keep in sync with `--tip-ms` in the scss. */
const TIP_MS = 6_000;

const TIPS: Tip[] = [
  { icon: '🪪', title: 'جهّز أوراقك', body: 'البطاقة الشخصية والتحاليل السابقة' },
  { icon: '🔔', title: 'انتبه لرقمك', body: 'سيظهر رقمك على الشاشة عند ندائك' },
  { icon: '🚶', title: 'عند ندائك توجّه مباشرة', body: 'إلى غرفة الطبيب المحدد' },
  { icon: '😷', title: 'ارتدِ الكمامة عند الحاجة', body: 'إذا كانت لديك أعراض تنفسية أو حرارة' },
  { icon: '🚭', title: 'ممنوع التدخين', body: 'داخل العيادة وفي صالة الانتظار' },
  { icon: '🗑️', title: 'حافظ على نظافة المكان', body: 'ضع المخلفات في سلة المهملات' },
  { icon: '👶', title: 'راقب أطفالك', body: 'ولا تتركهم دون مرافق' },
  { icon: '💊', title: 'أخبر الطبيب بأدويتك', body: 'وبأي حساسية لديك من أدوية أو أطعمة' },
  { icon: '🧍', title: 'مرافق واحد فقط لكل مريض', body: 'لتجنب الازدحام داخل الصالة' },
  { icon: '⏱️', title: 'الالتزام بالمواعيد', body: 'يساعدنا على تقليل وقت الانتظار' },
  { icon: '🙏', title: 'شكرًا لتعاونكم', body: 'نتمنى لكم دوام الصحة والعافية' },
  { icon: '📅', title: 'لا تنسَ موعد المتابعة', body: 'اسأل الاستقبال عن موعد زيارتك القادمة' },
];

// The stored status is matched loosely so "Canceled" / "Cancelled" both work.
const statusOf = (appointment: Appointment): string =>
  String(appointment.status ?? '').toLowerCase();
const isCancelled = (appointment: Appointment) => statusOf(appointment).includes('cancel');
const isCompleted = (appointment: Appointment) => statusOf(appointment).includes('complet');
const isConfirmed = (appointment: Appointment) => statusOf(appointment).includes('confirm');

/** A 404 from this API's list endpoints means "nothing booked", not a failure. */
const isNotFound = (error: unknown): boolean =>
  error instanceof HttpErrorResponse && error.status === 404;

/**
 * Full-screen waiting-room display. Opens in its own tab (no shell, no sidebar)
 * and is meant for a TV or a second monitor facing the patients.
 *
 * "Who is being seen now" is derived, not stored: there is no in-progress
 * status, so the earliest confirmed appointment today that is not yet completed
 * is the current one. Marking it Completed on the calendar moves the queue on.
 */
@Component({
  selector: 'app-queue-display',
  imports: [SpecialtyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queue-display.component.html',
  styleUrl: './queue-display.component.scss',
})
export class QueueDisplayComponent {
  private readonly api = inject(AppointmentsService);
  private readonly doctorsApi = inject(DoctorsService);
  private readonly settings = inject(ClinicSettingsStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly all = signal<Appointment[]>([]);
  protected readonly doctors = signal<Doctor[]>([]);
  protected readonly now = signal(new Date());
  protected readonly tipIndex = signal(0);

  protected readonly tips = TIPS;
  protected readonly tipMs = TIP_MS;
  protected readonly tip = computed(() => TIPS[this.tipIndex()]);

  protected readonly time = computed(() =>
    this.now().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
  );
  protected readonly date = computed(() =>
    this.now().toLocaleDateString('ar-EG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  );

  /** Changes only when the calendar day does, so the queue is not rebuilt every second. */
  private readonly dayKey = computed(() => this.now().toDateString());

  /** Today's confirmed and completed appointments in time order — the patients who are actually coming. */
  private readonly today = computed<QueueEntry[]>(() => {
    const day = new Date(this.dayKey());

    return this.all()
      .map((appointment) => ({ appointment, start: appointmentStart(appointment) }))
      .filter(
        (entry): entry is { appointment: Appointment; start: Date } =>
          entry.start !== null &&
          isSameDay(entry.start, day) &&
          !isCancelled(entry.appointment) &&
          (isConfirmed(entry.appointment) || isCompleted(entry.appointment))
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((entry, index) => ({ appointment: entry.appointment, no: index + 1 }));
  });

  private readonly waiting = computed(() =>
    this.today().filter((entry) => !isCompleted(entry.appointment))
  );

  protected readonly total = computed(() => this.today().length);
  protected readonly current = computed(() => this.waiting()[0] ?? null);

  /** The next three, each with an estimated wait of one average slot per person ahead. */
  protected readonly upcoming = computed(() => {
    const slot = this.settings.slotMinutes();
    return this.waiting()
      .slice(1, 4)
      .map((entry, index) => ({ ...entry, waitMinutes: (index + 1) * slot }));
  });

  private readonly doctorsById = computed(
    () => new Map(this.doctors().map((doctor) => [doctor.id, doctor]))
  );

  constructor() {
    timer(0, REFRESH_MS)
      .pipe(
        switchMap(() => {
          // Recomputed on every tick so the screen rolls over to the new day at midnight.
          const from = startOfDay(new Date());

          return this.api
            .getAppointments({
              pageIndex: 1,
              pageSize: 500,
              from: toLocalIso(from),
              to: toLocalIso(addDays(from, 1)),
              sort: 'Ascending',
            })
            .pipe(catchError((error: unknown) => of(isNotFound(error) ? EMPTY_PAGE : null)));
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((page) => {
        // A failed refresh keeps what is already on screen instead of blanking it.
        if (page) {
          this.all.set(page.data as Appointment[]);
        }
      });

    this.doctorsApi
      .getDoctors({ pageIndex: 1, pageSize: 200 })
      .pipe(catchError(() => of(null)), takeUntilDestroyed(this.destroyRef))
      .subscribe((page) => {
        if (page) {
          this.doctors.set(page.data as Doctor[]);
        }
      });

    const clock = setInterval(() => this.now.set(new Date()), 1000);
    const tips = setInterval(
      () => this.tipIndex.update((index) => (index + 1) % TIPS.length),
      TIP_MS
    );
    this.destroyRef.onDestroy(() => {
      clearInterval(clock);
      clearInterval(tips);
    });
  }

  protected doctorOf(doctorId: number): Doctor | null {
    return this.doctorsById().get(doctorId) ?? null;
  }

  /** First name plus the initial of the second — enough to recognise yourself, not enough to read out someone else's. */
  protected shortName(name: string): string {
    const [first = '', second] = name.trim().split(/\s+/);
    return second ? `${first} ${second.charAt(0)}.` : first;
  }

  protected digits(value: number): string {
    return value.toLocaleString('ar-EG', { useGrouping: false });
  }
}
