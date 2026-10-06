import { Routes } from '@angular/router';

import { authGuard } from './core/guards/auth.guard';
import { guestGuard } from './core/guards/guest.guard';
import { permissionGuard } from './core/guards/permission.guard';
import { AuthLayoutComponent } from './layouts/auth-layout/auth-layout.component';
import { ShellLayoutComponent } from './layouts/shell-layout/shell-layout.component';

/**
 * Routing.
 *
 * Every feature is lazy-loaded and states the *permission* it needs rather than
 * a role list, so changing what a Receptionist may reach is a change on the
 * Roles screen and not in this file.
 */
export const routes: Routes = [
  {
    path: 'auth',
    component: AuthLayoutComponent,
    canActivate: [guestGuard],
    loadChildren: () => import('./features/auth/auth.routes').then((m) => m.AUTH_ROUTES),
  },

  // The waiting-room screen. Deliberately outside the shell: no sidebar or top
  // bar, so it can fill a TV or second monitor. It must stay above the shell
  // route below, whose own `**` child would otherwise swallow this path.
  {
    path: 'queue-display',
    title: 'Waiting room | Clinic',
    canActivate: [authGuard, permissionGuard('appointments.view')],
    loadComponent: () =>
      import('./features/appointments/queue-display/queue-display.component').then(
        (m) => m.QueueDisplayComponent
      ),
  },

  {
    path: '',
    component: ShellLayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },

      {
        path: 'dashboard',
        title: 'Dashboard | Clinic',
        data: { breadcrumb: 'nav.dashboard' },
        canActivate: [permissionGuard('dashboard.view')],
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },

      // ------------------------------------------------------------ clinical --
      {
        path: 'patients',
        data: { breadcrumb: 'nav.patients' },
        loadChildren: () =>
          import('./features/patients/patients.routes').then((m) => m.PATIENTS_ROUTES),
      },
      {
        path: 'doctors',
        data: { breadcrumb: 'nav.doctors' },
        loadChildren: () =>
          import('./features/doctors/doctors.routes').then((m) => m.DOCTORS_ROUTES),
      },
      {
        path: 'records',
        data: { breadcrumb: 'nav.records' },
        loadChildren: () =>
          import('./features/records/records.routes').then((m) => m.RECORDS_ROUTES),
      },

      // ---------------------------------------------------------- operations --
      {
        path: 'appointments',
        data: { breadcrumb: 'nav.appointments' },
        loadChildren: () =>
          import('./features/appointments/appointments.routes').then((m) => m.APPOINTMENTS_ROUTES),
      },
      {
        path: 'schedules',
        data: { breadcrumb: 'nav.schedules' },
        loadChildren: () =>
          import('./features/schedules/schedules.routes').then((m) => m.SCHEDULES_ROUTES),
      },
      // The module was renamed; the old path is kept so existing bookmarks and
      // links in saved documents keep working.
      { path: 'doctor-schedules', redirectTo: 'schedules', pathMatch: 'full' },

      // ------------------------------------------------------------- finance --
      // The billing module was removed. Anything still pointing at /accounts -
      // a bookmark, an old link in the patient page - lands on the dashboard
      // rather than the not-found screen.
      { path: 'accounts', redirectTo: 'dashboard', pathMatch: 'prefix' },
      {
        path: 'reports',
        title: 'Reports | Clinic',
        data: { breadcrumb: 'nav.reports' },
        canActivate: [permissionGuard('reports.view')],
        loadComponent: () =>
          import('./features/reports/reports.component').then((m) => m.ReportsComponent),
      },

      // ------------------------------------------------------ administration --
      {
        path: 'users',
        data: { breadcrumb: 'nav.users' },
        loadChildren: () => import('./features/users/users.routes').then((m) => m.USERS_ROUTES),
      },
      {
        path: 'roles',
        data: { breadcrumb: 'nav.roles' },
        loadChildren: () => import('./features/roles/roles.routes').then((m) => m.ROLES_ROUTES),
      },
      {
        path: 'settings',
        title: 'Settings | Clinic',
        data: { breadcrumb: 'nav.settings' },
        canActivate: [permissionGuard('settings.view')],
        loadComponent: () =>
          import('./features/settings/settings.component').then((m) => m.SettingsComponent),
      },

      // ------------------------------------------------------------ personal --
      {
        path: 'profile',
        title: 'Profile | Clinic',
        data: { breadcrumb: 'nav.profile' },
        loadComponent: () =>
          import('./features/profile/profile.component').then((m) => m.ProfileComponent),
      },
      {
        path: 'notifications',
        title: 'Notifications | Clinic',
        data: { breadcrumb: 'nav.notifications' },
        loadComponent: () =>
          import('./features/notifications/notifications.component').then(
            (m) => m.NotificationsComponent
          ),
      },

      // -------------------------------------------------------------- errors --
      {
        path: 'unauthorized',
        title: 'Access denied | Clinic',
        data: { breadcrumb: 'errors.forbiddenTitle' },
        loadComponent: () =>
          import('./features/errors/unauthorized.component').then((m) => m.UnauthorizedComponent),
      },
      {
        path: '**',
        title: 'Not found | Clinic',
        data: { breadcrumb: 'errors.notFoundTitle' },
        loadComponent: () =>
          import('./features/errors/not-found.component').then((m) => m.NotFoundComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
