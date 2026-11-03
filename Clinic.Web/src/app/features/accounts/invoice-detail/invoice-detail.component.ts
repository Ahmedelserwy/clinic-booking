import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { PermissionService } from '../../../core/authz/permission.service';
import { AccountsStore } from '../../../core/data/accounts.store';
import { ClinicSettingsStore } from '../../../core/data/clinic-settings.store';
import { round2 } from '../../../core/data/finance.model';
import { EmptyStateComponent } from '../../../shared/ui/empty-state/empty-state.component';
import { IconComponent } from '../../../shared/ui/icon/icon.component';
import { PageHeaderComponent } from '../../../shared/ui/page-header/page-header.component';

@Component({
  selector: 'app-invoice-detail',
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    MatButtonModule,
    TranslatePipe,
    EmptyStateComponent,
    IconComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invoice-detail.component.html',
  styleUrl: './invoice-detail.component.scss',
})
export class InvoiceDetailComponent {
  private readonly store = inject(AccountsStore);
  private readonly translate = inject(TranslateService);
  private readonly settings = inject(ClinicSettingsStore);

  protected readonly permissions = inject(PermissionService);

  /** Bound from the route (`:id`). */
  readonly id = input.required<string>();

  /** `?print=1` opens the print dialog as soon as the invoice is on screen. */
  readonly autoPrint = input<string | undefined>(undefined, { alias: 'print' });

  protected readonly currency = computed(() => this.settings.settings().currency);

  protected readonly clinicName = computed(
    () => (this.settings.settings() as unknown as { clinicName?: string }).clinicName ?? ''
  );

  protected readonly invoice = computed(
    () => this.store.invoices().find((entry) => entry.id === this.id()) ?? null
  );

  protected readonly payments = computed(() =>
    this.store.payments().filter((payment) => payment.invoiceId === this.id())
  );

  /** Each stored line is a service; its amount is quantity × unitPrice (quantity is always 1). */
  protected readonly lines = computed(() =>
    (this.invoice()?.items ?? []).map((item) => ({
      ...item,
      amount: round2(item.quantity * item.unitPrice),
    }))
  );

  protected readonly subtotal = computed(() =>
    round2(this.lines().reduce((sum, line) => sum + line.amount, 0))
  );

  protected readonly discount = computed(() => this.invoice()?.discount ?? 0);

  protected readonly statusLabel = computed(() => {
    const status = this.invoice()?.effectiveStatus;
    if (!status) {
      return '';
    }
    const key = `accounts.status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
    const text = this.translate.instant(key);
    return text && text !== key ? text : status;
  });

  private printed = false;

  constructor() {
    effect(() => {
      if (this.autoPrint() && this.invoice() && !this.printed) {
        this.printed = true;
        // Let the sheet render before the browser snapshots it.
        setTimeout(() => window.print(), 300);
      }
    });
  }

  protected print(): void {
    window.print();
  }
}