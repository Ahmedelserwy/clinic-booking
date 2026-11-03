import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { ToastStore } from '../../../../core/services/toast.store';

/**
 * Draws the toasts held by `ToastStore`.
 *
 * It is created by `NotificationService` the first time a message is shown, and
 * attached straight to <body>, so nothing needs adding to the app shell.
 */
@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.scss',
})
export class ToastHostComponent {
  protected readonly store = inject(ToastStore);
  private readonly translate = inject(TranslateService);

  protected closeLabel(): string {
    const text = this.translate.instant('common.close');
    if (text && text !== 'common.close') {
      return text;
    }
    return (document.documentElement.lang || 'ar').toLowerCase().startsWith('ar')
      ? 'إغلاق'
      : 'Close';
  }
}