import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import {
  Expense,
  ExpenseInput,
  ExpenseQuery,
  ExpenseSummary,
  PageResult,
} from '../models/Expense.model';
import { ApiService } from './api.service';

/**
 * Talks to ExpensesController through the shared ApiService, exactly like PatientsService,
 * so the base URL, auth header and error handling all come from the same place.
 */
@Injectable({ providedIn: 'root' })
export class ExpenseService {
  private readonly api = inject(ApiService);

  list(q: ExpenseQuery): Observable<PageResult<Expense>> {
    const params: Record<string, string | number> = { Page: q.page, PageSize: q.pageSize };
    if (q.search) params['Search'] = q.search;
    if (q.category) params['Category'] = q.category;
    if (q.from) params['From'] = q.from;
    if (q.to) params['To'] = q.to;
    return this.api.get<unknown>('Expenses', params).pipe(map((r) => this.unwrap<PageResult<Expense>>(r)));
  }

  summary(): Observable<ExpenseSummary> {
    return this.api.get<unknown>('Expenses/summary').pipe(map((r) => this.unwrap<ExpenseSummary>(r)));
  }

  create(body: ExpenseInput): Observable<Expense> {
    return this.api.post<unknown>('Expenses', body).pipe(map((r) => this.unwrap<Expense>(r)));
  }

  update(id: number, body: ExpenseInput): Observable<Expense> {
    return this.api.put<unknown>(`Expenses/${id}`, body).pipe(map((r) => this.unwrap<Expense>(r)));
  }

  remove(id: number): Observable<void> {
    return this.api.delete<unknown>(`Expenses/${id}`).pipe(map(() => undefined));
  }

  /** Works with both plain DTOs and a { isSuccess, data, message } wrapper. */
  private unwrap<T>(res: unknown): T {
    if (res && typeof res === 'object' && 'data' in (res as object)) {
      const r = res as { isSuccess?: boolean; success?: boolean; message?: string; data: T };
      if (r.isSuccess === false || r.success === false) {
        throw new Error(r.message || 'حدث خطأ غير متوقع');
      }
      return r.data;
    }
    return res as T;
  }
}