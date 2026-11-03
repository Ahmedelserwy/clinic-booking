import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, contentChildren, inject, input, output } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';

import { IconComponent } from '../icon/icon.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import {
  CellTemplateDirective,
  PageState,
  RowActionEvent,
  SortState,
  TableColumn,
  TableRowAction,
} from './data-table.model';

/**
 * The one table in this application.
 *
 * Sticky header, sortable headers, row actions, a skeleton while loading, a
 * real empty state, and a card layout below the `md` breakpoint so a table is
 * still usable on a phone at the front desk. Every list screen uses it, which
 * is what makes sorting, spacing and pagination behave identically everywhere.
 *
 * Data is *not* sorted or paged here: the parent owns the query and reacts to
 * `sortChange` / `pageChange`. That keeps client-side lists and server-paged
 * endpoints on exactly the same contract.
 */
@Component({
  selector: 'ui-data-table',
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
    IconComponent,
    EmptyStateComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-table.component.html',
  styleUrl: './data-table.component.scss',
})
export class DataTableComponent<T extends { id: string | number }> {
  readonly columns = input.required<TableColumn<T>[]>();
  readonly rows = input<readonly T[]>([]);
  readonly loading = input(false);
  readonly rowActions = input<TableRowAction<T>[]>([]);
  readonly sort = input<SortState | null>(null);
  readonly page = input<PageState | null>(null);
  readonly total = input(0);
  readonly pageSizeOptions = input<number[]>([10, 25, 50, 100]);
  readonly clickableRows = input(false);
  readonly emptyTitle = input('common.noResults');
  readonly emptyMessage = input<string | null>(null);
  readonly emptyIcon = input<'empty' | 'noResults'>('empty');
  /** Number of placeholder rows shown while the first page loads. */
  readonly skeletonRows = input(6);
  /** Optional translation key; when set, the footer shows "<label>: <total>" beside the pager. */
  readonly totalLabel = input<string | null>(null);

  readonly sortChange = output<SortState>();
  readonly pageChange = output<PageState>();
  readonly rowClick = output<T>();
  readonly action = output<RowActionEvent<T>>();

  private readonly translate = inject(TranslateService);

  private readonly lang = toSignal(this.translate.onLangChange.pipe(map((event) => event.lang)), {
    initialValue:
      (typeof document !== 'undefined' && document.documentElement.lang) || 'ar',
  });

  protected readonly isArabic = computed(() => this.lang().toLowerCase().startsWith('ar'));

  protected readonly pageCount = computed(() => {
    const size = this.page()?.pageSize || 1;
    return Math.max(1, Math.ceil(this.total() / size));
  });

  /** Page numbers to show; `null` is a "…" gap. Always keeps first, last and the neighbours of the current page. */
  protected readonly pageItems = computed<(number | null)[]>(() => {
    const last = this.pageCount();
    const current = this.page()?.pageIndex ?? 1;

    if (last <= 7) {
      return Array.from({ length: last }, (_, index) => index + 1);
    }

    const start = Math.max(2, Math.min(current - 1, last - 4));
    const end = Math.min(last - 1, Math.max(current + 1, 5));
    const items: (number | null)[] = [1];
    if (start > 2) {
      items.push(null);
    }
    for (let value = start; value <= end; value++) {
      items.push(value);
    }
    if (end < last - 1) {
      items.push(null);
    }
    items.push(last);
    return items;
  });

  private readonly cellTemplates = contentChildren(CellTemplateDirective);

  protected readonly templateMap = computed(() => {
    const map = new Map<string, CellTemplateDirective>();
    for (const directive of this.cellTemplates()) {
      map.set(directive.uiCell(), directive);
    }
    return map;
  });

  protected readonly hasActions = computed(() => this.rowActions().length > 0);

  protected readonly showSkeleton = computed(() => this.loading() && this.rows().length === 0);

  protected readonly skeletonItems = computed(() =>
    Array.from({ length: this.skeletonRows() }, (_, index) => index)
  );

  /** Varied but stable line widths (a percentage), so the placeholders look like real text. */
  protected skeletonWidth(column: number, row: number): number {
    const widths = [70, 55, 85, 62, 76, 48];
    return widths[(column * 3 + row) % widths.length];
  }

  protected readonly showEmpty = computed(() => !this.loading() && this.rows().length === 0);

  /** A reload (new page, sort or search) keeps the rows on screen and runs a thin bar over the table. */
  protected readonly showProgress = computed(() => this.loading() && this.rows().length > 0);

  protected readonly loadingText = computed(() => (this.isArabic() ? 'جارٍ التحميل' : 'Loading'));

  protected onSort(column: TableColumn<T>): void {
    const key = column.sortKey;
    if (!key) {
      return;
    }

    const current = this.sort();
    const direction =
      current?.key === key && current.direction === 'asc' ? 'desc' : 'asc';

    this.sortChange.emit({ key, direction });
  }

  protected sortDirectionFor(column: TableColumn<T>): 'asc' | 'desc' | null {
    const current = this.sort();
    return current && column.sortKey === current.key ? current.direction : null;
  }

  protected ariaSortFor(column: TableColumn<T>): string | null {
    if (!column.sortKey) {
      return null;
    }
    const direction = this.sortDirectionFor(column);
    return direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  }

  protected goToPage(pageIndex: number): void {
    const state = this.page();
    if (!state || pageIndex < 1 || pageIndex > this.pageCount() || pageIndex === state.pageIndex) {
      return;
    }
    this.pageChange.emit({ pageIndex, pageSize: state.pageSize });
  }

  protected onPageSize(event: Event): void {
    const pageSize = Number((event.target as HTMLSelectElement).value);
    this.pageChange.emit({ pageIndex: 1, pageSize });
  }

  protected onRowClick(row: T): void {
    if (this.clickableRows()) {
      this.rowClick.emit(row);
    }
  }

  protected onRowKeydown(event: KeyboardEvent, row: T): void {
    if (!this.clickableRows()) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.rowClick.emit(row);
    }
  }

  protected visibleActions(row: T): TableRowAction<T>[] {
    return this.rowActions().filter((action) => action.visible?.(row) ?? true);
  }

  protected cellText(column: TableColumn<T>, row: T): string {
    const value = column.value?.(row);
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  protected secondaryText(column: TableColumn<T>, row: T): string | null {
    const value = column.secondary?.(row);
    return value === null || value === undefined || value === '' ? null : String(value);
  }

  protected trackRow = (_: number, row: T) => row.id;
}