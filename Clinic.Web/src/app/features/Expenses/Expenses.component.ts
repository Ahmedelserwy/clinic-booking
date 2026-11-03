import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  CATEGORY_KEYS,
  CATEGORY_META,
  Expense,
  ExpenseCategory,
  ExpenseSummary,
  PAYMENT_KEYS,
  PAYMENT_LABELS,
  PaymentMethod,
}from'../../core/models/Expense.model' ;
import { ExpenseService } from '../../core/services/Expense.service';
import { NotificationService } from '../../core/services/notification.service';
import { ToastOptions } from '../../core/services/toast.store';

interface Toast {
  type: 'success' | 'error';
  text: string;
}

/**
 * Moves its host element to <body> while it exists.
 *
 * Why: `position: fixed` is positioned against the nearest ancestor that has a transform,
 * filter, contain, etc. (e.g. a page-transition animation on the layout). When that happens the
 * backdrop covers the whole (tall) page instead of the screen, and the dialog is centred in the
 * page, so it shows up near the bottom, cut off. Rendering dialogs under <body> avoids that.
 */
@Directive({ selector: '[appPortal]', standalone: true })
export class PortalDirective implements OnInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  ngOnInit(): void {
    document.body.appendChild(this.el);
  }

  ngOnDestroy(): void {
    this.el.remove();
  }
}

@Component({
  selector: 'app-expenses',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, PortalDirective],
  templateUrl: './Expenses.component .html',
  styleUrl: './expenses.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpensesComponent {
  private readonly api = inject(ExpenseService);
  private readonly fb = inject(FormBuilder);
  private readonly notifications = inject(NotificationService);

  readonly categoryKeys = CATEGORY_KEYS;
  readonly paymentKeys = PAYMENT_KEYS;
  readonly meta = CATEGORY_META;
  readonly paymentLabels = PAYMENT_LABELS;

  // ---- list state ----
  readonly items = signal<Expense[]>([]);
  readonly totalCount = signal(0);
  readonly page = signal(1);
  readonly pageSize = signal(10);
  readonly pageSizes = [10, 25, 50];
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  // ---- filters ----
  readonly search = signal('');
  readonly categoryFilter = signal<ExpenseCategory | ''>('');
  readonly from = signal('');
  readonly to = signal('');
  readonly hasFilters = computed(
    () => !!(this.search() || this.categoryFilter() || this.from() || this.to()),
  );
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- summary ----
  readonly summary = signal<ExpenseSummary | null>(null);
  readonly monthDelta = computed(() => {
    const s = this.summary();
    if (!s || s.prevMonthTotal === 0) return null;
    return ((s.monthTotal - s.prevMonthTotal) / s.prevMonthTotal) * 100;
  });
  readonly topCategories = computed(() => {
    const s = this.summary();
    if (!s) return [];
    const sorted = [...s.byCategory].sort((a, b) => b.total - a.total).slice(0, 5);
    const max = sorted[0]?.total || 1;
    return sorted.map((c) => ({ ...c, pct: Math.max(4, (c.total / max) * 100) }));
  });
  readonly biggestCategory = computed(() => this.topCategories()[0] ?? null);

  // ---- paging ----
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalCount() / this.pageSize())));
  readonly pageFrom = computed(() => (this.totalCount() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1));
  readonly pageTo = computed(() => Math.min(this.page() * this.pageSize(), this.totalCount()));

  /** Page numbers to draw; 0 stands for an ellipsis. Always shows first, last and the neighbours of the current page. */
  readonly pageList = computed(() => {
    const total = this.totalPages();
    const cur = this.page();
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages = new Set([1, total, cur - 1, cur, cur + 1]);
    const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out: number[] = [];
    sorted.forEach((p, i) => {
      if (i > 0 && p - sorted[i - 1] > 1) out.push(0);
      out.push(p);
    });
    return out;
  });

  // ---- modal / form ----
  readonly modalOpen = signal(false);
  readonly editing = signal<Expense | null>(null);
  readonly saving = signal(false);
  readonly submitted = signal(false);

  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(120)]],
    category: ['rent' as ExpenseCategory, Validators.required],
    amount: [null as number | null, [Validators.required, Validators.min(0.01)]],
    expenseDate: [this.today(), Validators.required],
    paymentMethod: ['cash' as PaymentMethod, Validators.required],
    isRecurring: [false],
    notes: ['', Validators.maxLength(500)],
  });

  // ---- delete confirm ----
  readonly deleteTarget = signal<Expense | null>(null);
  readonly deleting = signal(false);

  // ---- toast ----
  // Toasts now come from the global NotificationService. This signal is kept only so the
  // old toast block in the template (`toast()`) still compiles; nothing sets it any more.
  // Delete both when convenient.
  readonly toast = signal<Toast | null>(null);

  constructor() {
    this.load();
    this.loadSummary();
  }

  // ================= data =================
  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .list({
        page: this.page(),
        pageSize: this.pageSize(),
        search: this.search().trim(),
        category: this.categoryFilter(),
        from: this.from(),
        to: this.to(),
      })
      .subscribe({
        next: (res) => {
          this.items.set(res.items);
          this.totalCount.set(res.totalCount);
          this.loading.set(false);
        },
        error: (e) => {
          this.loadError.set(this.errText(e));
          this.loading.set(false);
        },
      });
  }

  loadSummary(): void {
    this.api.summary().subscribe({
      next: (s) => this.summary.set(s),
      error: () => this.summary.set(null),
    });
  }

  private refresh(): void {
    this.load();
    this.loadSummary();
  }

  // ================= filters =================
  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.load();
    }, 350);
  }

  setCategoryFilter(value: string): void {
    this.categoryFilter.set(value as ExpenseCategory | '');
    this.page.set(1);
    this.load();
  }

  setFrom(value: string): void {
    this.from.set(value);
    this.page.set(1);
    this.load();
  }

  setTo(value: string): void {
    this.to.set(value);
    this.page.set(1);
    this.load();
  }

  clearFilters(): void {
    this.search.set('');
    this.categoryFilter.set('');
    this.from.set('');
    this.to.set('');
    this.page.set(1);
    this.load();
  }

  setPageSize(value: string): void {
    this.pageSize.set(Number(value) || 10);
    this.page.set(1);
    this.load();
  }

  goTo(p: number): void {
    if (p < 1 || p > this.totalPages() || p === this.page()) return;
    this.page.set(p);
    this.load();
  }

  // ================= modal =================
  openAdd(): void {
    this.editing.set(null);
    this.submitted.set(false);
    this.form.reset({
      title: '',
      category: 'rent',
      amount: null,
      expenseDate: this.today(),
      paymentMethod: 'cash',
      isRecurring: false,
      notes: '',
    });
    this.modalOpen.set(true);
    // Land on the amount: it is the first thing every entry needs.
    setTimeout(() => document.getElementById('exp-amount')?.focus(), 60);
  }

  openEdit(e: Expense): void {
    this.editing.set(e);
    this.submitted.set(false);
    this.form.reset({
      title: e.title,
      category: e.category,
      amount: e.amount,
      expenseDate: e.expenseDate.slice(0, 10),
      paymentMethod: e.paymentMethod,
      isRecurring: e.isRecurring,
      notes: e.notes ?? '',
    });
    this.modalOpen.set(true);
  }

  /** Esc closes whichever dialog is on top. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.deleteTarget()) this.cancelDelete();
    else if (this.modalOpen()) this.closeModal();
  }

  closeModal(): void {
    if (this.saving()) return;
    this.modalOpen.set(false);
  }

  pickCategory(c: ExpenseCategory): void {
    this.form.controls.category.setValue(c);
  }

  pickPayment(p: PaymentMethod): void {
    this.form.controls.paymentMethod.setValue(p);
  }

  save(): void {
    this.submitted.set(true);
    if (this.form.invalid || this.saving()) return;

    const v = this.form.getRawValue();
    const body = {
      title: v.title.trim(),
      category: v.category,
      amount: Number(v.amount),
      expenseDate: v.expenseDate,
      paymentMethod: v.paymentMethod,
      isRecurring: v.isRecurring,
      notes: v.notes.trim() || null,
    };

    const editing = this.editing();
    this.saving.set(true);
    const req$ = editing ? this.api.update(editing.id, body) : this.api.create(body);
    req$.subscribe({
      next: () => {
        this.saving.set(false);
        this.modalOpen.set(false);
        this.showToast('success', editing ? 'تم تعديل المصروف' : 'تمت إضافة المصروف', {
          kind: 'receipt',
          detail: `${body.title} · ${this.fmt(body.amount)}`,
        });
        if (!editing) this.page.set(1);
        this.refresh();
      },
      error: (e) => {
        this.saving.set(false);
        this.showToast('error', this.errText(e));
      },
    });
  }

  // ================= delete =================
  askDelete(e: Expense): void {
    this.deleteTarget.set(e);
  }

  cancelDelete(): void {
    if (this.deleting()) return;
    this.deleteTarget.set(null);
  }

  confirmDelete(): void {
    const target = this.deleteTarget();
    if (!target || this.deleting()) return;
    this.deleting.set(true);
    this.api.remove(target.id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.deleteTarget.set(null);
        this.showToast('success', 'تم حذف المصروف', {
          detail: `${target.title} · ${this.fmt(target.amount)}`,
          duration: 7000,
          action: { label: this.notifications.undoLabel(), run: () => this.restore(target) },
        });
        if (this.items().length === 1 && this.page() > 1) this.page.update((p) => p - 1);
        this.refresh();
      },
      error: (e) => {
        this.deleting.set(false);
        this.showToast('error', this.errText(e));
      },
    });
  }

  // ================= helpers =================
  fmt(n: number): string {
    return (n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  fmtDate(iso: string): string {
    const d = new Date(iso.slice(0, 10) + 'T00:00:00');
    return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  invalid(name: 'title' | 'amount' | 'expenseDate' | 'notes'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || this.submitted());
  }

  private today(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  private showToast(type: Toast['type'], text: string, options?: ToastOptions): void {
    if (type === 'success') this.notifications.success(text, options);
    else this.notifications.error(text, options);
  }

  /** Undo for a delete: the expense is created again with the same values. */
  private restore(target: Expense): void {
    const body = {
      title: target.title,
      category: target.category,
      amount: target.amount,
      expenseDate: target.expenseDate.slice(0, 10),
      paymentMethod: target.paymentMethod,
      isRecurring: target.isRecurring,
      notes: target.notes ?? null,
    };

    this.api.create(body).subscribe({
      next: () => {
        this.showToast('success', 'تمت استعادة المصروف', {
          kind: 'receipt',
          detail: `${target.title} · ${this.fmt(target.amount)}`,
        });
        this.refresh();
      },
      error: (e) => this.showToast('error', this.errText(e)),
    });
  }

  private errText(e: unknown): string {
    const err = e as { error?: { message?: string; title?: string }; message?: string };
    return err?.error?.message || err?.error?.title || err?.message || 'تعذر تنفيذ العملية، حاول مرة أخرى';
  }
}