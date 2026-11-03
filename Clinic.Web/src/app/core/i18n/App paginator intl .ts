import { Injectable, inject } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';
import { TranslateService } from '@ngx-translate/core';

const LABELS = {
  ar: {
    itemsPerPage: 'عدد الصفوف في الصفحة:',
    nextPage: 'الصفحة التالية',
    previousPage: 'الصفحة السابقة',
    firstPage: 'الصفحة الأولى',
    lastPage: 'الصفحة الأخيرة',
    of: 'من',
  },
  en: {
    itemsPerPage: 'Items per page:',
    nextPage: 'Next page',
    previousPage: 'Previous page',
    firstPage: 'First page',
    lastPage: 'Last page',
    of: 'of',
  },
} as const;

/**
 * Angular Material's paginator text, in the app's language.
 *
 * Out of the box it is English only, and its "1 – 3 of 3" range scrambles into "of 3 3 – 1" on a
 * right-to-left page. In Arabic the range reads "1 – 3 من 3", which keeps its order in RTL.
 *
 * Register once in app.config.ts:  { provide: MatPaginatorIntl, useClass: AppPaginatorIntl }
 */
@Injectable()
export class AppPaginatorIntl extends MatPaginatorIntl {
  private readonly translate = inject(TranslateService);

  constructor() {
    super();
    this.apply();
    // Let the app finish switching <html lang/dir> before reading it back.
    this.translate.onLangChange.subscribe(() =>
      setTimeout(() => {
        this.apply();
        this.changes.next();
      })
    );
  }

  override getRangeLabel = (page: number, pageSize: number, length: number): string => {
    const of = this.labels().of;
    if (length === 0 || pageSize === 0) {
      return `0 ${of} ${length}`;
    }

    const total = Math.max(length, 0);
    const start = page * pageSize;
    const end = start < total ? Math.min(start + pageSize, total) : start + pageSize;
    return `${start + 1} – ${end} ${of} ${total}`;
  };

  private labels() {
    const html = typeof document !== 'undefined' ? document.documentElement : null;
    // currentLang is a plain string in older ngx-translate and a signal in newer ones.
    const current: unknown = this.translate.currentLang;
    const serviceLang = typeof current === 'function' ? (current as () => string | null)() : current;
    const lang = html?.lang || (typeof serviceLang === 'string' ? serviceLang : '') || 'ar';
    return lang.toLowerCase().startsWith('ar') ? LABELS.ar : LABELS.en;
  }

  private apply(): void {
    const text = this.labels();
    this.itemsPerPageLabel = text.itemsPerPage;
    this.nextPageLabel = text.nextPage;
    this.previousPageLabel = text.previousPage;
    this.firstPageLabel = text.firstPage;
    this.lastPageLabel = text.lastPage;
  }
}