import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';

import { PermissionService } from '../../core/authz/permission.service';
import { NotificationsStore } from '../../core/data/notifications.store';
import { AppLanguage } from '../../core/i18n/locale.model';
import { LocaleService } from '../../core/i18n/locale.service';
import { AuthService } from '../../core/services/auth.service';
import { LoadingService } from '../../core/services/loading.service';
import { ThemeService } from '../../core/services/theme.service';
import { NAV_GROUPS } from '../../routes/navigation.config';
import { IconComponent } from '../../shared/ui/icon/icon.component';

const SIDEBAR_STORAGE_KEY = 'clinic.sidebar.collapsed';

/**
 * The application shell: sidebar, top bar and the routed content region.
 *
 * Two behaviours are worth calling out.
 *
 * The sidebar collapses to an icon rail rather than disappearing, because
 * clinic staff navigate constantly and losing the rail costs a click every
 * time. The choice is persisted per device.
 *
 * Navigation is rendered from `NAV_GROUPS` filtered by permission, and a group
 * whose items are all filtered out is dropped along with its heading — so the
 * sidebar always describes what this user can actually do. An item with
 * `children` (Reports) renders as an expandable list; it opens by itself when
 * the current URL is inside it and can be toggled by hand afterwards.
 */
@Component({
  selector: 'app-shell-layout',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatDividerModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
    IconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shell-layout.component.html',
  styleUrl: './shell-layout.component.scss',
})
export class ShellLayoutComponent {
  private readonly auth = inject(AuthService);
  private readonly breakpoints = inject(BreakpointObserver);
  private readonly permissions = inject(PermissionService);
  private readonly router = inject(Router);

  protected readonly loading = inject(LoadingService);
  protected readonly locale = inject(LocaleService);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly theme = inject(ThemeService);

  protected readonly user = toSignal(this.auth.currentUser$, {
    initialValue: this.auth.currentUser,
  });

  protected readonly isHandset = toSignal(
    this.breakpoints
      .observe([Breakpoints.Handset, Breakpoints.TabletPortrait])
      .pipe(map((state) => state.matches)),
    { initialValue: false }
  );

  protected readonly collapsed = signal(this.readCollapsed());
  protected readonly drawerOpen = signal(false);

  /** True while the router is loading the next page; drives the progress line under the top bar. */
  protected readonly navigating = signal(false);

  protected readonly loadingText = computed(() =>
    this.locale.current() === 'ar' ? 'جارٍ التحميل' : 'Loading'
  );

  /** Current URL, kept as a signal so the active branch re-renders on navigation. */
  protected readonly url = signal(this.router.url);

  /** Routes of the expandable items that are currently open. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  /** Permission-filtered navigation; empty groups are dropped with their heading. */
  protected readonly navGroups = computed(() => {
    // Touch the permission set so the sidebar re-renders when a role changes.
    this.permissions.granted();

    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items
        .map((item) =>
          item.children
            ? {
                ...item,
                children: item.children.filter((child) => this.permissions.canAny(child.permissions)),
              }
            : item
        )
        // An expandable item with nothing left to show is dropped, not left empty.
        .filter(
          (item) =>
            this.permissions.canAny(item.permissions) && (!item.children || item.children.length > 0)
        ),
    })).filter((group) => group.items.length > 0);
  });

  protected readonly initials = computed(() => {
    const name = this.user()?.displayName?.trim();
    if (!name) {
      return '—';
    }
    const parts = name.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  });

  protected readonly roleLabel = computed(() => this.permissions.roleNames().join(' · '));

  constructor() {
    // A page that takes a moment to load (first visit to a lazy route) shows a
    // thin progress line under the top bar instead of a blank gap. It only fades
    // in after a short delay, so quick navigations never flash it.
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.navigating.set(true);
      } else if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.navigating.set(false);
      }
    });

    // Closing the drawer on navigation is what makes the mobile sidebar feel
    // like a menu rather than a page that has to be dismissed manually.
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.drawerOpen.set(false);
        this.url.set(event.urlAfterRedirects);
        this.revealActive(event.urlAfterRedirects);
      });

    effect(() => {
      const collapsed = this.collapsed();
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed));
      } catch {
        /* storage blocked — the rail simply resets on reload */
      }
    });
  }

  protected toggleSidebar(): void {
    if (this.isHandset()) {
      this.drawerOpen.update((open) => !open);
      return;
    }
    this.collapsed.update((value) => !value);
  }

  protected closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  protected isExpanded(route: string): boolean {
    return this.expanded().has(route);
  }

  /** True while the current page is inside the item's branch (e.g. any /reports/*). */
  protected isBranchActive(route: string): boolean {
    return this.inBranch(this.url(), route);
  }

  protected toggleGroup(route: string): void {
    // On the icon rail there is no room for a list: widen the sidebar and open it.
    if (this.collapsed() && !this.isHandset()) {
      this.collapsed.set(false);
      this.setExpanded(route, true);
      return;
    }
    this.setExpanded(route, !this.isExpanded(route));
  }

  protected setLanguage(language: AppLanguage): void {
    this.locale.use(language);
  }

  protected logout(): void {
    this.auth.logout();
  }

  /** Opens whichever expandable item contains the page the user just landed on. */
  private revealActive(url: string): void {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.children && this.inBranch(url, item.route)) {
          this.setExpanded(item.route, true);
        }
      }
    }
  }

  private setExpanded(route: string, open: boolean): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (open) {
        next.add(route);
      } else {
        next.delete(route);
      }
      return next;
    });
  }

  private inBranch(url: string, route: string): boolean {
    const path = url.split(/[?#]/)[0];
    return path === route || path.startsWith(`${route}/`);
  }

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}