import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

import { IconComponent } from '../icon/icon.component';
import { IconName } from '../icon/icon.registry';

/**
 * The panel every block of content sits in.
 *
 *   <ui-card title="dashboard.recentPayments" icon="payment">
 *     <button actions mat-button>…</button>
 *     …content…
 *     <div footer>…</div>
 *   </ui-card>
 *
 * `padded="false"` is for content that must run edge to edge — tables, lists,
 * calendars — so the card border stays the outer edge and the child owns its
 * own rhythm.
 */
@Component({
  selector: 'ui-card',
  imports: [TranslatePipe, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [class.card-flat]="flat()">
      @if (title() || hasHeader()) {
        <header class="card-head">
          @if (icon(); as name) {
            <span class="icon-tile"><ui-icon [name]="name" size="md" /></span>
          }

          <div class="head-text">
            @if (title(); as text) {
              <h2 class="text-section-title head-title" [attr.title]="text | translate">
                {{ text | translate }}
              </h2>
            }
            @if (subtitle(); as text) {
              <p class="head-sub">{{ text | translate }}</p>
            }
          </div>

          <div class="head-actions">
            <ng-content select="[actions]" />
          </div>
        </header>
      }

      <div class="card-body" [class.card-body-flush]="!padded()">
        <ng-content />
      </div>

      <ng-content select="[footer]" />
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }

    .card {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--c-surface);
      border: 1px solid var(--c-border);
      border-radius: var(--r-lg);
      box-shadow: var(--sh-card);
      overflow: hidden;
    }

    .card-flat {
      box-shadow: none;
    }

    .card-head {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
      padding: var(--sp-4) var(--sp-5);
      border-block-end: 1px solid var(--c-border);
    }

    .head-text {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
      flex: 1 1 0;
    }

    // A long title shrinks with an ellipsis instead of running under the actions slot.
    .head-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .head-sub {
      font-size: var(--fs-xs);
      color: var(--c-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .head-actions {
      display: flex;
      align-items: center;
      gap: var(--sp-1);
      flex: 0 0 auto;
    }

    .card-body {
      flex: 1 1 auto;
      min-width: 0;
      padding: var(--sp-5);
    }

    .card-body-flush {
      padding: 0;
    }

    ::ng-deep [footer] {
      padding: var(--sp-3) var(--sp-5);
      border-block-start: 1px solid var(--c-border);
      background: var(--c-surface-2);
    }
  `,
})
export class CardComponent {
  readonly title = input<string | null>(null);
  readonly subtitle = input<string | null>(null);
  readonly icon = input<IconName | null>(null);
  readonly padded = input(true);
  readonly flat = input(false);
  /** Force the header to render for an actions-only card with no title. */
  readonly hasHeader = input(false);
}