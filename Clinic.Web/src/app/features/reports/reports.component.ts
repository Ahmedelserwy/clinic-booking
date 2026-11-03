import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map, startWith } from 'rxjs';

import { AccountsStore } from '../../core/data/accounts.store';
import { ClinicSettingsStore } from '../../core/data/clinic-settings.store';
import { round2 } from '../../core/data/finance.model';
import { NotificationService } from '../../core/services/notification.service';
import { addDays, startOfDay, startOfMonth } from '../../core/utils/date.util';
import {
  CollectionKind,
  CollectionMethod,
  IncomeBreakdown,
  MethodTotal,
  PaymentList,
  PaymentRecord,
  Period,
} from '../../core/services/reportservice';
// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

type ReportId = 'dailyClosing' | 'collections' | 'incomeExpenses' | 'profitability' | 'summary';
type Tone = 'blue' | 'green' | 'amber' | 'violet' | 'rose';
type PresetId = 'today' | 'yesterday' | '7' | '30' | 'month' | 'year' | 'custom';
type Cell = string | number;

interface ReportDef {
  id: ReportId;
  tone: Tone;
  icon: string;
}

interface Column {
  header: string;
  align?: 'start' | 'end';
  strong?: boolean;
}

/**
 * One line of the table. A report is a single table; where it has parts each part is a
 * `heading` followed by its `data` rows and, where totals make sense, a `total` row.
 * For a heading, `cells[0]` is the translation key.
 */
interface TableRow {
  kind: 'data' | 'heading' | 'total';
  cells: Cell[];
}

/** A card on the page: an optional heading (translation key) and its rows. */
interface Section {
  title: string | null;
  rows: TableRow[];
}

interface ReportView {
  columns: Column[];
  rows: TableRow[];
  /** Draw every row in ONE table, with headings as bands, instead of one card per part. */
  single?: boolean;
}

// ----------------------------------------------------------------------------
// Static data
// ----------------------------------------------------------------------------

/** Stroke icons (24x24 viewBox) so the page needs no extra icon dependency. */
const ICONS = {
  revenue: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  wallet:
    'M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z',
  expenses: 'M4 2v20l3-2 3 2 3-2 3 2 3-2V2l-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5',
  trend: 'M3 17l6-6 4 4 8-8M14 7h7v7',
  records:
    'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9z',
  search: 'M21 21l-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  print:
    'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
} as const;

const REPORTS: ReportDef[] = [
  { id: 'dailyClosing', tone: 'amber', icon: ICONS.wallet },
  { id: 'collections', tone: 'green', icon: ICONS.revenue },
  { id: 'incomeExpenses', tone: 'violet', icon: ICONS.expenses },
  { id: 'profitability', tone: 'blue', icon: ICONS.trend },
  { id: 'summary', tone: 'blue', icon: ICONS.records },
];

const isReportId = (value: string | null): value is ReportId =>
  REPORTS.some((def) => def.id === value);

const PRESETS: { id: PresetId; key: string }[] = [
  { id: 'today', key: 'common.today' },
  { id: 'yesterday', key: 'common.yesterday' },
  { id: '7', key: 'reports.last7' },
  { id: '30', key: 'reports.last30' },
  { id: 'month', key: 'reports.thisMonth' },
  { id: 'year', key: 'common.thisYear' },
];

const data = (...cells: Cell[]): TableRow => ({ kind: 'data', cells });
const total = (...cells: Cell[]): TableRow => ({ kind: 'total', cells });

/** Compares the date part only, so a time of day can never push a record out of its day. */
const within = (iso: string, start: string, end: string): boolean => {
  const day = iso.slice(0, 10);
  return day >= start && day <= end;
};

type PaymentItem = PaymentList['items'][number];

/** There are no free visits at this clinic, so they never appear in the grids. */
const isPaid = (payment: PaymentItem): boolean => payment.kind !== 'free';

const METHOD_KEYS: Record<string, string> = {
  cash: 'accounts.methodCash',
  card: 'accounts.methodCard',
  wallet: 'accounts.methodWallet',
  bank: 'accounts.methodTransfer',
};

const KIND_KEYS: Record<string, string> = {
  examination: 'reports.finance.examination',
  visit: 'reports.finance.visit',
  free: 'reports.finance.freeVisit',
};

const isoDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * The financial reports. Each has its own URL (`/reports/:report`) and its own entry in the
 * sidebar; the route reuses this one component, so the date range survives moving between
 * reports while the search box is cleared.
 *
 * Every report has the same anatomy: a title, a banner saying what the report is, the date
 * range with a Search button, then one table. The dates are drafts until Search is pressed,
 * so a half-edited range never reloads the page.
 *
 * A report only PRESENTS data. Every figure is computed here from the clinic's books
 * (`AccountsStore`): an invoice saved with its payment, and an expense. There are no refunds
 * at this clinic, so none are counted.
 */
@Component({
  selector: 'app-reports',
  imports: [
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reports.component.html',
  styleUrl: './reports.component.scss',
})
export class ReportsComponent {
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly settings = inject(ClinicSettingsStore);

  private readonly store = inject(AccountsStore);

  protected readonly icons = ICONS;
  protected readonly presets = PRESETS;

  // ----------------------------------------------------------------- state --

  /** The range the report on screen was loaded for. */
  protected readonly from = signal<Date>(startOfMonth(new Date()));
  protected readonly to = signal<Date>(new Date());

  /** The range being edited in the date fields; it becomes `from` / `to` on Search. */
  protected readonly draftFrom = signal<Date>(startOfMonth(new Date()));
  protected readonly draftTo = signal<Date>(new Date());

  protected readonly preset = signal<PresetId>('month');

  protected readonly active = signal<ReportId>('dailyClosing');
  protected readonly query = signal('');

  /**
   * Reading this inside a computed makes it re-run when the language changes.
   *
   * `currentLang` is a signal in this ngx-translate version, so it must not be
   * passed to `startWith` / `initialValue` directly: `getCurrentLang()` returns
   * the plain string.
   */
  private readonly lang = toSignal(
    this.translate.onLangChange.pipe(
      map((event) => event.lang),
      startWith(this.translate.getCurrentLang())
    ),
    { initialValue: this.translate.getCurrentLang() }
  );

  private readonly currency = computed(() => this.settings.settings().currency);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('report');
      if (isReportId(id)) {
        this.active.set(id);
        this.query.set('');
        // Moving to another report drops any half-edited range.
        this.draftFrom.set(this.from());
        this.draftTo.set(this.to());
      }
    });
  }

  // -------------------------------------------------------------- helpers --

  private t(key: string): string {
    this.lang();
    return this.translate.instant(key);
  }

  private num(value: number): string {
    return value.toLocaleString(this.lang() || undefined, { maximumFractionDigits: 2 });
  }

  /** An amount of money: currency, two decimals, and the minus sign in front so negatives show in red. */
  private money(value: number): string {
    const digits = Math.abs(value).toLocaleString(this.lang() || undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${value < 0 ? '-' : ''}${this.currency()} ${digits}`;
  }

  private fullDate(date: Date): string {
    return date.toLocaleDateString(this.lang() || undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  /** `yyyy-mm-dd` or a full ISO string to a Date, or null when unreadable. */
  private dateFrom(value: string): Date | null {
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private dayLabel(value: string): string {
    const date = this.dateFrom(value);
    return date ? this.fullDate(date) : value;
  }

  private monthLabel(key: string): string {
    const date = this.dateFrom(`${key}-01`);
    return date
      ? date.toLocaleDateString(this.lang() || undefined, { month: 'long', year: 'numeric' })
      : key;
  }

  private kindLabel(kind: string): string {
    return this.t(KIND_KEYS[kind] ?? KIND_KEYS['examination'] ?? kind);
  }

  private methodLabel(method: string): string {
    const key = METHOD_KEYS[method];
    return key ? this.t(key) : method;
  }

  /** Net profit as a share of income; a dash when nothing was earned to measure against. */
  private margin(income: number, expenses: number): string {
    return income > 0 ? `${this.num(Math.round(((income - expenses) / income) * 1000) / 10)}%` : '—';
  }

  /** Negative figures are shown in red. Arabic formatting prefixes a direction mark, so skip it. */
  protected isNegative(cell: Cell): boolean {
    return typeof cell === 'string' && /^[\u200e\u200f\u061c]*[-\u2212]/.test(cell);
  }

  // ---------------------------------------------------------------- period --

  protected readonly periodLabel = computed(
    () => `${this.fullDate(this.from())} – ${this.fullDate(this.to())}`
  );

  protected readonly generatedOn = computed(() => this.fullDate(new Date()));

  /** Short ranges read best day by day; long ones month by month. */
  private periodGroup(): 'day' | 'month' {
    const span =
      Math.round((startOfDay(this.to()).getTime() - startOfDay(this.from()).getTime()) / 86_400_000) + 1;
    return span <= 62 ? 'day' : 'month';
  }

  // ------------------------------------------------------------ the books --

  /**
   * Every payment, as the reports see it. The doctor and the visit type come from the invoice the
   * payment belongs to. There are no refunds at this clinic, so `refundedAmount` is always 0.
   */
  private readonly records = computed<PaymentRecord[]>(() => {
    const invoices = new Map(this.store.invoices().map((invoice) => [invoice.id, invoice]));
    const followUp = this.translate.instant('accounts.followUp');

    return [...this.store.payments()]
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt))
      .map((payment, index): PaymentRecord => {
        const invoice = invoices.get(payment.invoiceId);

        // The invoice form saves the visit type with the payment; older payments fall back to the
        // invoice line, which holds the translated name of the visit type.
        const isFollowUp =
          payment.reference === 'followUp' ||
          (payment.reference !== 'examination' && invoice?.items[0]?.description === followUp);
        const kind: CollectionKind = isFollowUp ? 'visit' : 'examination';

        return {
          id: index + 1,
          appointmentId: 0,
          patientId: invoice?.patientId ?? null,
          patientName: payment.patientName,
          doctorId: invoice?.doctorId ?? null,
          doctorName: invoice?.doctorName ?? '',
          kind,
          amount: payment.amount,
          method: (payment.method === 'transfer' ? 'bank' : payment.method) as CollectionMethod,
          paidAt: payment.paidAt,
          notes: null,
          refundedAmount: 0,
          receivedBy: payment.recordedBy,
        };
      });
  });

  private listFor(from: string, to: string): PaymentList {
    const items = this.records().filter((p) => within(p.paidAt, from, to));
    return {
      items,
      totalCount: items.length,
      totalCollected: round2(items.reduce((sum, p) => sum + p.amount, 0)),
      totalRefunded: 0,
    };
  }

  private methodTotals(items: PaymentRecord[]): MethodTotal[] {
    const totals = new Map<string, MethodTotal>();
    for (const p of items) {
      const row = totals.get(p.method) ?? { method: p.method, collected: 0, refunded: 0, net: 0 };
      row.collected = round2(row.collected + p.amount);
      row.net = row.collected;
      totals.set(p.method, row);
    }
    return [...totals.values()];
  }

  private breakdownOf(items: PaymentRecord[]): IncomeBreakdown {
    const sum = (list: PaymentRecord[]): number => round2(list.reduce((total, p) => total + p.amount, 0));
    const exams = items.filter((p) => p.kind === 'examination');
    const visits = items.filter((p) => p.kind === 'visit');
    const collected = sum(items);

    return {
      examinationCount: exams.length,
      examinationAmount: sum(exams),
      visitCount: visits.length,
      visitAmount: sum(visits),
      freeCount: 0,
      collected,
      refunded: 0,
      net: collected,
    };
  }

  private periodFor(from: string, to: string, group: 'day' | 'month'): Period {
    const items = this.records().filter((p) => within(p.paidAt, from, to));
    const spent = this.store.expenses().filter((e) => within(e.spentAt, from, to));
    const keyOf = (iso: string): string => (group === 'month' ? iso.slice(0, 7) : iso.slice(0, 10));

    const rows = new Map<string, { income: number; expenses: number }>();
    const row = (key: string) => {
      const found = rows.get(key) ?? { income: 0, expenses: 0 };
      rows.set(key, found);
      return found;
    };
    for (const p of items) {
      row(keyOf(p.paidAt)).income += p.amount;
    }
    for (const e of spent) {
      row(keyOf(e.spentAt)).expenses += e.amount;
    }

    const breakdown = this.breakdownOf(items);
    const expenses = round2(spent.reduce((sum, e) => sum + e.amount, 0));

    return {
      from,
      to,
      group,
      breakdown,
      expenses,
      netProfit: round2(breakdown.net - expenses),
      byMethod: this.methodTotals(items),
      expensesByCategory: [],
      rows: [...rows.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, r]) => ({
          key,
          income: round2(r.income),
          expenses: round2(r.expenses),
          net: round2(r.income - r.expenses),
        })),
    };
  }

  /** The daily closing is about one day (the "to" date); every other report covers the range. */
  private readonly payments = computed(() =>
    this.active() === 'dailyClosing'
      ? this.listFor(isoDate(this.to()), isoDate(this.to()))
      : this.listFor(isoDate(this.from()), isoDate(this.to()))
  );

  private readonly periodData = computed(() =>
    this.periodFor(
      isoDate(this.from()),
      isoDate(this.to()),
      this.active() === 'profitability' ? 'month' : this.periodGroup()
    )
  );

  // --------------------------------------------------------------- the views --
  // Every report is ONE table.

  /**
   * Sums payments into a grid: one row per `rowOf`, one column per `colOf`, each cell the
   * amount paid, with totals on the right edge and in the last row. Pass `fixedCols` to always
   * show those columns, otherwise only the columns that occur are shown, in payment-method order.
   */
  private crossTable(
    items: PaymentItem[],
    rowOf: (payment: PaymentItem) => string,
    rowLabel: (key: string) => string,
    colOf: (payment: PaymentItem) => string,
    colLabel: (key: string) => string,
    firstHeader: string,
    fixedCols?: string[]
  ): { columns: Column[]; rows: TableRow[] } {
    const grid = new Map<string, Map<string, number>>();
    const present = new Set<string>();

    for (const payment of items) {
      const rowKey = rowOf(payment);
      const colKey = colOf(payment);
      present.add(colKey);

      const row = grid.get(rowKey) ?? new Map<string, number>();
      row.set(colKey, (row.get(colKey) ?? 0) + payment.amount);
      grid.set(rowKey, row);
    }

    const methodOrder = Object.keys(METHOD_KEYS);
    const order = (key: string): number => {
      const index = methodOrder.indexOf(key);
      return index < 0 ? methodOrder.length : index;
    };
    const cols = fixedCols ?? [...present].sort((a, b) => order(a) - order(b));

    const show = (sum: number | undefined): string => (sum ? this.money(sum) : '\u2014');
    const colTotals = new Map<string, number>(cols.map((key) => [key, 0]));
    let all = 0;

    const lines = [...grid.entries()]
      .map(([key, row]) => {
        let line = 0;
        const cells = cols.map((col) => {
          const sum = row.get(col);
          if (sum) {
            line += sum;
            colTotals.set(col, (colTotals.get(col) ?? 0) + sum);
          }
          return show(sum);
        });
        all += line;
        return { label: rowLabel(key), line, cells };
      })
      .sort((a, b) => b.line - a.line);

    return {
      columns: [
        { header: firstHeader, strong: true },
        ...cols.map((key): Column => ({ header: colLabel(key), align: 'end' })),
        { header: 'common.total', align: 'end' },
      ],
      rows: lines.length
        ? [
            ...lines.map((entry) => data(entry.label, ...entry.cells, show(entry.line))),
            total(this.t('common.total'), ...cols.map((col) => show(colTotals.get(col))), show(all)),
          ]
        : [],
    };
  }

  /** Income / expenses / net / margin for every day or month of the range. */
  private periodColumns(group: 'day' | 'month'): Column[] {
    return [
      { header: group === 'month' ? 'reports.month' : 'common.date', strong: true },
      { header: 'accounts.income', align: 'end' },
      { header: 'accounts.expenses', align: 'end' },
      { header: 'accounts.netProfit', align: 'end' },
      { header: 'reports.margin', align: 'end' },
    ];
  }

  private periodRows(p: Period): TableRow[] {
    if (!p.rows.length) {
      return [];
    }
    const label = (key: string): string => (p.group === 'month' ? this.monthLabel(key) : this.dayLabel(key));
    const income = p.rows.reduce((sum, r) => sum + r.income, 0);
    const expenses = p.rows.reduce((sum, r) => sum + r.expenses, 0);

    return [
      ...p.rows.map((r) =>
        data(label(r.key), this.money(r.income), this.money(r.expenses), this.money(r.net), this.margin(r.income, r.expenses))
      ),
      total(
        this.t('common.total'),
        this.money(income),
        this.money(expenses),
        this.money(income - expenses),
        this.margin(income, expenses)
      ),
    ];
  }

  /** The day's takings as a grid: payment methods down the side, visit types across the top. */
  private dailyClosingView(): ReportView {
    return this.crossTable(
      this.payments().items.filter(isPaid),
      (p) => p.method,
      (key) => this.methodLabel(key),
      (p) => p.kind,
      (key) => this.kindLabel(key),
      'reports.finance.method',
      ['examination', 'visit']
    );
  }

  /** Who collected how much: doctors down the side, payment methods across the top. */
  private collectionsView(): ReportView {
    return this.crossTable(
      this.payments().items.filter(isPaid),
      (p) => p.doctorName || '\u2014',
      (key) => key,
      (p) => p.method,
      (key) => this.methodLabel(key),
      'reports.finance.doctor'
    );
  }

  private incomeExpensesView(): ReportView {
    const p = this.periodData();
    return {
      columns: this.periodColumns(p.group),
      rows: this.periodRows(p),
    };
  }

  /** Month by month: what the clinic earned, spent and kept, and how that moved from the month before. */
  private profitabilityView(): ReportView {
    const p = this.periodData();
    if (p.group !== 'month') {
      return { columns: [], rows: [] };
    }

    const income = p.rows.reduce((sum, r) => sum + r.income, 0);
    const expenses = p.rows.reduce((sum, r) => sum + r.expenses, 0);

    const rows = p.rows.map((r, index): TableRow => {
      const previous = index > 0 ? p.rows[index - 1] : undefined;
      let change = '—';
      if (previous && previous.net !== 0) {
        const percent = ((r.net - previous.net) / Math.abs(previous.net)) * 100;
        change = `${percent >= 0 ? '+' : ''}${this.num(Math.round(percent * 10) / 10)}%`;
      }

      return data(
        this.monthLabel(r.key),
        this.money(r.income),
        this.money(r.expenses),
        this.money(r.net),
        this.margin(r.income, r.expenses),
        change
      );
    });

    return {
      columns: [
        { header: 'reports.month', strong: true },
        { header: 'reports.finance.netIncome', align: 'end' },
        { header: 'accounts.expenses', align: 'end' },
        { header: 'accounts.netProfit', align: 'end' },
        { header: 'reports.margin', align: 'end' },
        { header: 'reports.finance.change', align: 'end' },
      ],
      rows: rows.length
        ? [
            ...rows,
            total(
              this.t('common.total'),
              this.money(income),
              this.money(expenses),
              this.money(income - expenses),
              this.margin(income, expenses),
              ''
            ),
          ]
        : [],
    };
  }

  /** The summary: the period's takings as a grid of payment methods by visit type. */
  private summaryView(): ReportView {
    return this.crossTable(
      this.payments().items.filter(isPaid),
      (payment) => payment.method,
      (key) => this.methodLabel(key),
      (payment) => payment.kind,
      (key) => this.kindLabel(key),
      'reports.finance.method',
      ['examination', 'visit']
    );
  }

  // ------------------------------------------------------------ the report --

  protected readonly activeDef = computed(
    () => REPORTS.find((def) => def.id === this.active()) ?? REPORTS[0]
  );

  /** Only the open report is computed; the others cost nothing until visited. */
  protected readonly view = computed<ReportView>(() => {
    switch (this.active()) {
      case 'collections':
        return this.collectionsView();
      case 'incomeExpenses':
        return this.incomeExpensesView();
      case 'profitability':
        return this.profitabilityView();
      case 'summary':
        return this.summaryView();
      default:
        return this.dailyClosingView();
    }
  });

  /** True when the report has anything to show, whatever the search box says. */
  protected readonly hasData = computed(() => this.view().rows.some((row) => row.kind === 'data'));

  /**
   * The table lines. While a search narrows the list only matching data rows
   * remain: headings and totals describe the whole period, so they step aside.
   */
  protected readonly rows = computed<TableRow[]>(() => {
    const rows = this.view().rows;
    const q = this.query().trim().toLowerCase();
    return q
      ? rows.filter(
          (row) => row.kind === 'data' && row.cells.some((cell) => String(cell).toLowerCase().includes(q))
        )
      : rows;
  });

  /** The rows split at each heading: one card per part, with its heading above it. */
  protected readonly sections = computed<Section[]>(() => {
    if (this.view().single) {
      const all = this.rows();
      return all.length ? [{ title: null, rows: all }] : [];
    }

    const sections: Section[] = [];
    let current: Section | null = null;

    for (const row of this.rows()) {
      if (row.kind === 'heading') {
        current = { title: String(row.cells[0]), rows: [] };
        sections.push(current);
        continue;
      }
      if (!current) {
        current = { title: null, rows: [] };
        sections.push(current);
      }
      current.rows.push(row);
    }

    return sections;
  });

  /** How many real records are on screen (headings and totals do not count). */
  protected readonly count = computed(() => this.rows().filter((row) => row.kind === 'data').length);

  /** Row count, except on the daily closing, which is about one day and says which. */
  protected readonly note = computed(() =>
    this.active() === 'dailyClosing'
      ? this.fullDate(this.to())
      : `${this.count()} ${this.t('reports.rows')}`
  );

  protected readonly titleKey = computed(() => `reports.${this.active()}.title`);
  protected readonly subtitleKey = computed(() => `reports.${this.active()}.desc`);

  // --------------------------------------------------------------- actions --

  protected setQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** Editing a date only changes the draft; Search applies it. */
  protected setFrom(value: Date | null): void {
    if (!value) {
      return;
    }
    this.draftFrom.set(value);
    if (value.getTime() > this.draftTo().getTime()) {
      this.draftTo.set(value);
    }
    this.preset.set('custom');
  }

  protected setTo(value: Date | null): void {
    if (!value) {
      return;
    }
    this.draftTo.set(value);
    if (value.getTime() < this.draftFrom().getTime()) {
      this.draftFrom.set(value);
    }
    this.preset.set('custom');
  }

  /** Applies the dates in the fields to the report. */
  protected search(): void {
    this.from.set(this.draftFrom());
    this.to.set(this.draftTo());
  }

  private setRange(from: Date, to: Date): void {
    this.from.set(from);
    this.to.set(to);
    this.draftFrom.set(from);
    this.draftTo.set(to);
  }

  protected applyPreset(id: PresetId): void {
    const today = startOfDay(new Date());

    switch (id) {
      case 'today':
        this.setRange(today, today);
        break;
      case 'yesterday': {
        const yesterday = addDays(today, -1);
        this.setRange(yesterday, yesterday);
        break;
      }
      case '7':
        this.setRange(addDays(today, -6), today);
        break;
      case '30':
        this.setRange(addDays(today, -29), today);
        break;
      case 'year':
        this.setRange(new Date(today.getFullYear(), 0, 1), today);
        break;
      default:
        this.setRange(startOfMonth(today), today);
    }

    this.preset.set(id);
  }

  // ---- export & print ------------------------------------------------------

  /** CSV export of the table currently on screen (respecting the search box). */
  protected exportCsv(): void {
    const view = this.view();
    const rows = this.rows();

    if (!this.hasData() || (this.query().trim() && this.count() === 0)) {
      this.notifications.info(this.translate.instant('reports.empty'));
      return;
    }

    // Cells starting with = + - @ are prefixed so Excel never runs them as formulas.
    const safe = (cell: Cell): string => {
      const text = String(cell);
      return /^[=+\-@]/.test(text) ? `'${text}` : text;
    };

    const header = view.columns.map((column) => this.translate.instant(column.header));

    const lines = rows.map((row) =>
      row.kind === 'heading' ? [this.translate.instant(String(row.cells[0]))] : row.cells.map(safe)
    );
    const csv = [header, ...lines]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    // The BOM makes Excel open UTF-8 correctly, which matters for Arabic names.
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `${this.active()}-report-${isoDate(this.from())}_${isoDate(this.to())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected print(): void {
    window.print();
  }
}