import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  forwardRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';

const stamp = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * Date picker with the month, year and day visible at once: twelve month chips,
 * a scrollable year list and the day grid. Nothing is typed, so there is no
 * format to get wrong, and picking a birth year is one tap instead of paging.
 *
 * Works with Reactive Forms (`formControlName`) and binds a `Date | null`.
 */
@Component({
  selector: 'ui-date-picker',
  imports: [OverlayModule, MatButtonModule, MatFormFieldModule, MatInputModule, TranslatePipe],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => DatePickerComponent),
      multi: true,
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './date-picker.component.html',
  styleUrl: './date-picker.component.scss',
})
export class DatePickerComponent implements ControlValueAccessor {
  /** Translation key of the field label. */
  readonly label = input('');
  readonly max = input<Date | null>(null);
  readonly min = input<Date | null>(null);
  /** Lets the parent show the red error state (for example after a failed submit). */
  readonly invalid = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly translate = inject(TranslateService);
  private readonly yearList = viewChild<ElementRef<HTMLElement>>('yearList');

  protected readonly value = signal<Date | null>(null);
  protected readonly isOpen = signal(false);
  protected readonly disabled = signal(false);
  protected readonly viewYear = signal(new Date().getFullYear());
  protected readonly viewMonth = signal(new Date().getMonth());

  private readonly lang = toSignal(this.translate.onLangChange.pipe(map((event) => event.lang)), {
    initialValue: (typeof document !== 'undefined' && document.documentElement.lang) || 'ar',
  });

  protected readonly isArabic = computed(() => this.lang().toLowerCase().startsWith('ar'));

  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
  ];

  protected readonly display = computed(() => {
    const date = this.value();
    if (!date) {
      return '';
    }
    const pad = (n: number): string => `${n}`.padStart(2, '0');
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  });

  protected readonly monthNames = computed(() => {
    const format = new Intl.DateTimeFormat(this.isArabic() ? 'ar-EG-u-nu-latn' : 'en', {
      month: 'long',
    });
    return Array.from({ length: 12 }, (_, index) => format.format(new Date(2000, index, 1)));
  });

  /** Arabic weeks start on Saturday, English on Sunday. */
  private readonly weekStart = computed(() => (this.isArabic() ? 6 : 0));

  protected readonly weekdays = computed(() => {
    const labels = this.isArabic()
      ? ['أح', 'اث', 'ثل', 'أر', 'خم', 'جم', 'سب']
      : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const start = this.weekStart();
    return [...labels.slice(start), ...labels.slice(0, start)];
  });

  protected readonly years = computed(() => {
    const top = this.max()?.getFullYear() ?? new Date().getFullYear();
    const bottom = this.min()?.getFullYear() ?? top - 120;
    return Array.from({ length: Math.max(top - bottom + 1, 1) }, (_, index) => top - index);
  });

  /** `null` entries are the blank cells before the 1st. */
  protected readonly days = computed<(number | null)[]>(() => {
    const year = this.viewYear();
    const month = this.viewMonth();
    const lead = (new Date(year, month, 1).getDay() - this.weekStart() + 7) % 7;
    const count = new Date(year, month + 1, 0).getDate();
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: count }, (_, index) => index + 1),
    ];
  });

  private onChange: (value: Date | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(value: Date | null): void {
    this.value.set(value ? new Date(value) : null);
  }

  registerOnChange(fn: (value: Date | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  protected open(): void {
    if (this.disabled()) {
      return;
    }
    const max = this.max();
    const fallback = max && stamp(max) < stamp(new Date()) ? max : new Date();
    const anchor = this.value() ?? fallback;
    this.viewYear.set(anchor.getFullYear());
    this.viewMonth.set(anchor.getMonth());
    this.isOpen.set(true);
  }

  protected close(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      this.onTouched();
    }
  }

  protected onOutsideClick(event: MouseEvent): void {
    // A click on the field itself is handled by toggle(); don't close and reopen.
    if (this.host.nativeElement.contains(event.target as Node)) {
      return;
    }
    this.close();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  /** Brings the selected year into view when the panel opens. */
  protected onAttach(): void {
    setTimeout(() => {
      const list = this.yearList()?.nativeElement;
      const active = list?.querySelector<HTMLElement>('.dp-year.active');
      if (list && active) {
        list.scrollTop = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
      }
    });
  }

  protected monthDisabled(month: number): boolean {
    const year = this.viewYear();
    const max = this.max();
    const min = this.min();
    if (max && stamp(new Date(year, month, 1)) > stamp(max)) {
      return true;
    }
    if (min && stamp(new Date(year, month + 1, 0)) < stamp(min)) {
      return true;
    }
    return false;
  }

  protected dayDisabled(day: number): boolean {
    const time = stamp(new Date(this.viewYear(), this.viewMonth(), day));
    const max = this.max();
    const min = this.min();
    return Boolean((max && time > stamp(max)) || (min && time < stamp(min)));
  }

  protected isSelected(day: number): boolean {
    const date = this.value();
    return (
      !!date &&
      date.getFullYear() === this.viewYear() &&
      date.getMonth() === this.viewMonth() &&
      date.getDate() === day
    );
  }

  protected isToday(day: number): boolean {
    return stamp(new Date(this.viewYear(), this.viewMonth(), day)) === stamp(new Date());
  }

  protected selectMonth(month: number): void {
    if (!this.monthDisabled(month)) {
      this.viewMonth.set(month);
    }
  }

  protected selectYear(year: number): void {
    this.viewYear.set(year);
    // Keep the month valid: e.g. moving to the current year while on a later month.
    if (this.monthDisabled(this.viewMonth())) {
      const allowed = Array.from({ length: 12 }, (_, index) => index).filter(
        (index) => !this.monthDisabled(index)
      );
      if (allowed.length) {
        const current = this.viewMonth();
        this.viewMonth.set(current > allowed[allowed.length - 1] ? allowed[allowed.length - 1] : allowed[0]);
      }
    }
  }

  protected selectDay(day: number): void {
    if (this.dayDisabled(day)) {
      return;
    }
    const date = new Date(this.viewYear(), this.viewMonth(), day);
    this.value.set(date);
    this.onChange(date);
    this.close();
  }

  protected clear(): void {
    this.value.set(null);
    this.onChange(null);
    this.close();
  }
}