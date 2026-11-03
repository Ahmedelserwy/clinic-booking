import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LocaleService } from '../../../core/i18n/locale.service';
import { minutesToDate } from '../../../core/utils/date.util';
import { statusConfig } from '../../../core/utils/appointment-status.util';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PositionedItem } from './calendar.model';

/**
 * One appointment on the grid.
 *
 * Presentational: it is handed a box that the layout engine already resolved and
 * draws it. Position comes in as `topPx`/`heightPx` and never from a hard-coded
 * size, so a 90-minute appointment is three rows tall because it is 90 minutes
 * long, not because anything said "90 means three".
 *
 * Status is carried by an icon and a word as well as a colour. Colour alone
 * fails for the ~8% of men with a colour vision deficiency, and this is a screen
 * where confusing "cancelled" with "confirmed" wastes a patient's morning.
 *
 * The patient's name is the most important line, so it gets priority for space:
 * the doctor line (already implied by the column in day view) only appears once
 * the block is tall enough, the name may wrap onto a second line when there is
 * room, and even the compact one-row layout keeps the name. The full name is
 * always available as a tooltip.
 */
@Component({
  selector: 'app-appointment-block',
  imports: [TranslatePipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block-host',
    '[style.top.px]': 'item().topPx',
    '[style.height.px]': 'item().heightPx',
    '[style.inset-inline-start.%]': 'item().offsetPct',
    '[style.width.%]': 'item().widthPct',
    '[style.z-index]': 'item().zIndex',
  },
  template: `
    <div
      class="block"
      [class.block-compact]="compact()"
      [class.block-narrow]="item().clusterSize > 1"
      [class.block-muted]="muted()"
      [class.block-draggable]="draggable()"
      [style.--block-accent]="config().accent"
      [style.--block-surface]="config().surface"
      [style.--name-lines]="nameLines()"
      role="button"
      [attr.tabindex]="0"
      [attr.aria-label]="ariaLabel()"
      [attr.title]="item().appointment.patientName"
      (click)="open.emit()"
      (keydown.enter)="onActivate($event)"
      (keydown.space)="onActivate($event)"
    >
      <span class="block-rail" aria-hidden="true"></span>

      <span class="block-time">
        <ui-icon [name]="config().icon" size="sm" class="block-status-icon" />
        {{ timeRange() }}
      </span>

      <span class="block-patient">{{ item().appointment.patientName }}</span>

      @if (showDoctor()) {
        <span class="block-doctor">{{ item().appointment.doctorName }}</span>
      }

      @if (showStatus()) {
        <span class="block-status">{{ config().label | translate }}</span>
      }
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      padding-inline-end: 3px;
      /* Blocks are positioned, not laid out: the lane owns the coordinate space
         and a block must never push its neighbours around. */
    }

    .block {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 1px;
      height: 100%;
      padding: 5px var(--sp-2) 5px calc(var(--sp-2) + 5px);
      border: 1px solid color-mix(in srgb, var(--block-accent) 48%, transparent);
      border-radius: var(--r-sm);
      /* The status surface alone is a pastel that vanishes on a white working
         band; pulling in the accent gives each status a body colour you can read
         across the room, and still follows the theme. */
      background: color-mix(in srgb, var(--block-accent) 17%, var(--block-surface));
      box-shadow: 0 1px 2px color-mix(in srgb, var(--block-accent) 28%, transparent);
      color: var(--c-text);
      overflow: hidden;
      text-align: start;
      cursor: pointer;
      transition:
        box-shadow var(--dur-micro) var(--ease-standard),
        transform var(--dur-micro) var(--ease-standard);
    }

    /* The padding above is physical-start on purpose — mirrored here rather than
       written as a logical property so the rail and its inset stay in step. */
    :host-context(html[dir='rtl']) .block {
      padding: 5px calc(var(--sp-2) + 5px) 5px var(--sp-2);
    }

    .block:hover {
      box-shadow: var(--sh-raised);
      background: color-mix(in srgb, var(--block-accent) 24%, var(--block-surface));
    }

    .block:focus-visible {
      outline: none;
      box-shadow: var(--sh-focus);
    }

    /* The colour bar. Its own element rather than a border-inline-start so it
       keeps its radius and flips with the writing direction for free. */
    .block-rail {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      width: 5px;
      background: var(--block-accent);
    }

    .block-time {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
      font-size: var(--fs-2xs);
      font-weight: var(--fw-bold);
      color: color-mix(in srgb, var(--block-accent) 70%, var(--c-text));
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .block-status-icon {
      flex: 0 0 auto;
    }

    /* The name wraps (up to --name-lines lines) instead of being cut to one
       line, so a full name is readable whenever the block has the height. */
    .block-patient {
      min-width: 0;
      font-size: var(--fs-sm);
      font-weight: var(--fw-bold);
      line-height: var(--lh-tight);
      overflow: hidden;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: var(--name-lines, 1);
      line-clamp: var(--name-lines, 1);
    }

    .block-doctor,
    .block-status {
      flex: 0 0 auto;
      font-size: var(--fs-2xs);
      color: var(--c-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .block-status {
      margin-block-start: auto;
      font-weight: var(--fw-medium);
      color: color-mix(in srgb, var(--block-accent) 70%, var(--c-text-muted));
    }

    /* One row tall: time and name sit side by side, and the name takes whatever
       width the time leaves. */
    .block-compact {
      flex-direction: row;
      align-items: center;
      gap: var(--sp-2);
      padding-block: 2px;
    }

    .block-compact .block-patient {
      flex: 1 1 0;
      display: block;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    /* Overlapping appointments share the lane width; keep the time off the name. */
    .block-narrow .block-time {
      font-size: var(--fs-2xs);
    }

    /* Cancelled and completed recede: they are history, not today's plan. */
    .block-muted {
      opacity: 0.74;
    }

    .block-muted .block-patient {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }

    .block-draggable {
      cursor: grab;
    }

    :host(.cdk-drag-dragging) {
      /* Let elementFromPoint see the lane underneath when the drag lands. */
      pointer-events: none;
      z-index: 200;
    }

    :host(.cdk-drag-dragging) .block {
      box-shadow: var(--sh-overlay);
      transform: scale(1.02);
    }
  `,
})
export class AppointmentBlockComponent {
  private readonly locale = inject(LocaleService);

  readonly item = input.required<PositionedItem>();
  readonly draggable = input(false);

  readonly open = output<void>();

  protected readonly config = computed(() => statusConfig(this.item().appointment.status));

  /** Under ~46px there is only room for one row: time and name side by side. */
  protected readonly compact = computed(() => this.item().heightPx < 46);

  /** Two lines for the name once there is room for them under the time. */
  protected readonly nameLines = computed(() => (this.item().heightPx >= 70 ? 2 : 1));

  /** The doctor is the column header in day view, so it only earns a line in taller blocks. */
  protected readonly showDoctor = computed(() => !this.compact() && this.item().heightPx >= 88);

  /** The status word needs its own line below a two-line name. */
  protected readonly showStatus = computed(
    () => this.item().heightPx >= 104 && this.item().clusterSize === 1
  );

  protected readonly muted = computed(() => {
    const status = this.item().appointment.status;
    return status === 'Cancelled' || status === 'Completed';
  });

  protected readonly timeRange = computed(() => {
    const item = this.item();
    const locale = this.locale.definition().locale;
    const format = (minutes: number) =>
      minutesToDate(minutes).toLocaleTimeString(locale, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    return `${format(item.startMinutes)} – ${format(item.endMinutes)}`;
  });

  /**
   * Everything the block shows, in one string.
   *
   * Screen readers announce the host, not the visual arrangement, and a compact
   * block hides the doctor entirely — so the label carries it regardless of how
   * much of the card is drawn.
   */
  protected readonly ariaLabel = computed(() => {
    const { appointment } = this.item();
    return `${appointment.patientName}, ${appointment.doctorName}, ${this.timeRange()}`;
  });

  protected onActivate(event: Event): void {
    // Space scrolls the grid otherwise, which moves the thing under the cursor.
    event.preventDefault();
    this.open.emit();
  }
}