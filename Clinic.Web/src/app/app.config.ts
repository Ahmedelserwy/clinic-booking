import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  MAT_DATE_FORMATS,
  MAT_NATIVE_DATE_FORMATS,
  provideNativeDateAdapter,
} from '@angular/material/core';
import { MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS } from '@angular/material/snack-bar';
import { MAT_TOOLTIP_DEFAULT_OPTIONS } from '@angular/material/tooltip';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import {
  PreloadAllModules,
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withPreloading,
} from '@angular/router';
import { provideTranslateLoader, provideTranslateService } from '@ngx-translate/core';

import { routes } from './app.routes';
import { DEFAULT_LANGUAGE } from './core/i18n/locale.model';
import { LocaleService } from './core/i18n/locale.service';
import { StaticTranslateLoader } from './core/i18n/static-translate.loader';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { loadingInterceptor } from './core/interceptors/loading.interceptor';
import { ThemeService } from './core/services/theme.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimationsAsync(),

    // PreloadAllModules downloads every lazy feature chunk in the background
    // right after the first page loads, so moving between pages doesn't wait
    // on a network request for the feature's JavaScript.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ anchorScrolling: 'enabled', scrollPositionRestoration: 'enabled' }),
      withPreloading(PreloadAllModules)
    ),

    provideHttpClient(withInterceptors([loadingInterceptor, errorInterceptor, authInterceptor])),

    // ----------------------------------------------------------------- i18n --
    provideTranslateService({
      lang: DEFAULT_LANGUAGE,
      fallbackLang: DEFAULT_LANGUAGE,
    }),
    provideTranslateLoader(StaticTranslateLoader),

    // Datepicker/timepicker run on the native adapter; LocaleService pushes the
    // active locale into it, so month names and the first day of the week
    // follow the language without a second date library in the bundle.
    provideNativeDateAdapter(),

    // The application shows 12-hour time and nothing else. Left to the locale,
    // `hour: 'numeric'` renders 24-hour under en-GB and 12-hour under en-US —
    // so the hour cycle is pinned here instead of varying by language. Arabic
    // still gets its own ص/م markers because only the cycle is forced.
    {
      provide: MAT_DATE_FORMATS,
      useValue: {
        ...MAT_NATIVE_DATE_FORMATS,
        display: {
          ...MAT_NATIVE_DATE_FORMATS.display,
          timeInput: { hour: 'numeric', minute: '2-digit', hour12: true },
          timeOptionLabel: { hour: 'numeric', minute: '2-digit', hour12: true },
        },
      },
    },

    // Instantiating these at boot is what makes theme and direction correct on
    // the first paint rather than after the shell renders.
    provideAppInitializer(() => {
      inject(ThemeService);
      inject(LocaleService);
    }),

    // ------------------------------------------------- Material defaults --
    {
      provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
      useValue: { appearance: 'outline', floatLabel: 'auto', subscriptSizing: 'dynamic' },
    },
    {
      provide: MAT_SNACK_BAR_DEFAULT_OPTIONS,
      useValue: { duration: 4500, horizontalPosition: 'center', verticalPosition: 'bottom' },
    },
    {
      provide: MAT_DIALOG_DEFAULT_OPTIONS,
      useValue: { autoFocus: 'first-tabbable', restoreFocus: true, maxWidth: '94vw' },
    },
    {
      provide: MAT_TOOLTIP_DEFAULT_OPTIONS,
      useValue: { showDelay: 400, hideDelay: 0, touchendHideDelay: 1200 },
    },
  ],
};