export type ExpenseCategory =
  | 'rent'
  | 'electricity'
  | 'water'
  | 'internet'
  | 'salaries'
  | 'transport'
  | 'maintenance'
  | 'marketing'
  | 'taxes'
  | 'supplies'
  | 'other';

export type PaymentMethod = 'cash' | 'bank' | 'wallet';

export interface Expense {
  id: number;
  title: string;
  category: ExpenseCategory;
  amount: number;
  expenseDate: string; // yyyy-MM-dd
  paymentMethod: PaymentMethod;
  isRecurring: boolean;
  notes?: string | null;
}

export type ExpenseInput = Omit<Expense, 'id'>;

export interface ExpenseQuery {
  page: number;
  pageSize: number;
  search?: string;
  category?: ExpenseCategory | '';
  from?: string;
  to?: string;
}

export interface PageResult<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface CategoryTotal {
  category: ExpenseCategory;
  total: number;
}

export interface ExpenseSummary {
  monthTotal: number;
  prevMonthTotal: number;
  monthCount: number;
  yearTotal: number;
  byCategory: CategoryTotal[]; // current month
}

export interface CategoryMeta {
  label: string;
  icon: string;
  color: string;
}

export const CATEGORY_META: Record<ExpenseCategory, CategoryMeta> = {
  rent: { label: 'إيجار', icon: '🏢', color: 'var(--c-primary)' },
  electricity: { label: 'كهرباء', icon: '⚡', color: 'var(--warning-500)' },
  water: { label: 'مياه', icon: '💧', color: '#0ea5e9' },
  internet: { label: 'إنترنت وهاتف', icon: '📶', color: 'var(--accent-500)' },
  salaries: { label: 'رواتب وأجور', icon: '👥', color: 'var(--success-600)' },
  transport: { label: 'نقل ومواصلات', icon: '🚚', color: '#f97316' },
  maintenance: { label: 'صيانة', icon: '🛠️', color: '#64748b' },
  marketing: { label: 'تسويق وإعلان', icon: '📣', color: '#ec4899' },
  taxes: { label: 'ضرائب ورسوم', icon: '🧾', color: 'var(--danger-500)' },
  supplies: { label: 'مستلزمات', icon: '📦', color: '#14b8a6' },
  other: { label: 'أخرى', icon: '📌', color: '#94a3b8' },
};

export const CATEGORY_KEYS = Object.keys(CATEGORY_META) as ExpenseCategory[];

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'نقداً',
  bank: 'تحويل بنكي',
  wallet: 'محفظة إلكترونية',
};

export const PAYMENT_KEYS = Object.keys(PAYMENT_LABELS) as PaymentMethod[];