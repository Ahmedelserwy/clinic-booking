import { CanMatchFn, Routes } from '@angular/router';

/** The reports that exist. An unknown id falls through to the not-found page. */
const REPORT_IDS = ['dailyClosing', 'collections', 'incomeExpenses', 'profitability', 'summary'];

const knownReport: CanMatchFn = (_route, segments) =>
  REPORT_IDS.includes(segments[0]?.path ?? '');

/**
 * `/reports`            -> redirects to the first report (daily closing)
 * `/reports/:report`    -> one report per page (see ReportsComponent)
 *
 * The permission guard stays on the parent `reports` route in app.routes.ts.
 */
export const REPORTS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dailyClosing' },
  {
    path: ':report',
    title: 'Reports | Clinic',
    canMatch: [knownReport],
    loadComponent: () =>
      import('./reports.component').then((m) => m.ReportsComponent),
  },
];