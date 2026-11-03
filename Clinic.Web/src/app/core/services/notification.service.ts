import {
  ApplicationRef,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { ToastHostComponent } from '../../shared/ui/toast/toast-host/toast-host';
import { ToastOptions, ToastStore, ToastType } from './toast.store';

export type { ToastAction, ToastKind, ToastOptions } from './toast.store';

/**
 * The one place the app shows a message to the user.
 *
 * `success(message)`, `error(message)` and `info(message)` work exactly as they
 * did when this wrapped MatSnackBar, so existing calls keep working. A second
 * argument adds the clinic touches:
 *
 *   notifications.success('تم تأكيد الموعد', {
 *     kind: 'calendar',
 *     detail: 'أحمد علي · د. كمال · 5:30 م',
 *   });
 *
 *   notifications.success('تم حذف المصروف', {
 *     action: { label: notifications.undoLabel(), run: () => restore() },
 *   });
 *
 * The toast host mounts itself the first time something is shown, so it does
 * not have to be added to `app.component.html`.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private readonly store = inject(ToastStore);
  private readonly translate = inject(TranslateService);

  private mounted = false;

  success(message: string, options?: ToastOptions): void {
    this.push('success', message, options);
  }

  error(message: string, options?: ToastOptions): void {
    this.push('error', message, options);
  }

  info(message: string, options?: ToastOptions): void {
    this.push('info', message, options);
  }

  warning(message: string, options?: ToastOptions): void {
    this.push('warning', message, options);
  }

  /** The label for an Undo button: the translation if there is one, otherwise a built-in. */
  undoLabel(): string {
    const text = this.translate.instant('common.undo');
    if (text && text !== 'common.undo') {
      return text;
    }
    return this.isArabic() ? 'تراجع' : 'Undo';
  }

  private push(type: ToastType, message: string, options?: ToastOptions): void {
    this.mount();
    this.store.show(type, message, options);
  }

  private mount(): void {
    if (this.mounted || typeof document === 'undefined') {
      return;
    }
    this.mounted = true;

    const host = createComponent(ToastHostComponent, { environmentInjector: this.injector });
    this.appRef.attachView(host.hostView);
    document.body.appendChild(host.location.nativeElement);
  }

  private isArabic(): boolean {
    return (document.documentElement.lang || 'ar').toLowerCase().startsWith('ar');
  }
}