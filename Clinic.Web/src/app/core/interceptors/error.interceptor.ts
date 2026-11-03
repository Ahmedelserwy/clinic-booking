import { HttpContextToken, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { catchError, throwError } from 'rxjs';

import { NotificationService } from '../services/notification.service';

/** Set on a request's HttpContext to opt out of the automatic error notification. */
export const SKIP_ERROR_NOTIFY = new HttpContextToken<boolean>(() => false);

/** The wording used when the translation files are not available yet. */
const FALLBACK: Record<string, string> = {
  network: 'We couldn’t reach the server. Please check your connection and try again.',
  badRequest:
    'We couldn’t complete your request. Please review the information entered and try again.',
  unauthorized: 'Your session has expired. Please sign in again to continue.',
  forbidden: 'You don’t have permission to perform this action.',
  notFound: 'The requested record could not be found.',
  conflict: 'This change conflicts with existing information. Please refresh and try again.',
  tooMany: 'Too many requests. Please wait a moment and try again.',
  server: 'Something went wrong on our end. Please try again shortly.',
  generic: 'Something went wrong. Please try again.',
};

/**
 * Titles that ASP.NET Core attaches to every problem response. They describe the
 * category of failure, not what the person should do, so they are not shown.
 */
const BOILERPLATE_TITLES = [
  /one or more validation errors/i,
  /an error occurred while processing your request/i,
  /^bad request$/i,
  /^not found$/i,
  /^internal server error$/i,
];

/**
 * Catch-all sentences a backend writes when it has no real reason to give
 * ("An unexpected error occurred."). They are English-only and say nothing the
 * person can act on, so the translated standard message is shown instead.
 */
const GENERIC_SERVER_TEXT = [
  /unexpected error/i,
  /an error (has )?occurred/i,
  /something went wrong/i,
  /internal server error/i,
  /request failed/i,
];

const isGeneric = (text: string): boolean => GENERIC_SERVER_TEXT.some((p) => p.test(text));

export const errorInterceptor: HttpInterceptorFn = (request, next) => {
  const notifications = inject(NotificationService);
  const translate = inject(TranslateService);

  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        shouldNotify(request.url, error, request.context.get(SKIP_ERROR_NOTIFY))
      ) {
        notifications.error(toUserMessage(error, (key) => standardMessage(translate, key)));
      }

      return throwError(() => error);
    })
  );
};

function shouldNotify(url: string, error: HttpErrorResponse, skip: boolean): boolean {
  if (skip || url.includes('/Accounts/RefreshToken')) {
    return false;
  }

  // The backend returns 404 for empty collections; components render their own
  // empty state, so a global error notification would just be noise.
  return error.status !== 404;
}

/** One of our standard messages, in the current language, or its English fallback. */
function standardMessage(translate: TranslateService, key: string): string {
  const path = `errors.http.${key}`;
  const text = translate.instant(path);
  return text && text !== path ? text : FALLBACK[key];
}

function toUserMessage(error: HttpErrorResponse, standard: (key: string) => string): string {
  const body = error.error;

  // A server fault is never something the person can fix, and its text is written
  // for developers, so it is always replaced by the translated standard message.
  if (error.status >= 500) {
    return standard('server');
  }

  // A plain-text reason from the API, unless it is a page of HTML from a proxy.
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.length > 0 && text.length <= 300 && !text.startsWith('<') && !isGeneric(text)) {
      return text;
    }
  }

  if (
    typeof body?.message === 'string' &&
    body.message.trim().length > 0 &&
    !isGeneric(body.message)
  ) {
    return body.message.trim();
  }

  // RFC 7807 `ProblemDetails`: a rejected booking carries its reason in `title`
  // ("That slot has just been taken"). The framework's own boilerplate titles
  // are skipped so they never replace the standard wording below.
  if (typeof body?.title === 'string') {
    const title = body.title.trim();
    if (
      title.length > 0 &&
      !isGeneric(title) &&
      !BOILERPLATE_TITLES.some((pattern) => pattern.test(title))
    ) {
      return title;
    }
  }

  if (Array.isArray(body)) {
    const text = body
      .map((item) => item?.description ?? item?.message ?? item)
      .filter((item) => typeof item === 'string' && item.trim().length > 0 && !isGeneric(item))
      .join(' ');
    if (text) {
      return text;
    }
  }

  switch (error.status) {
    case 0:
      return standard('network');
    case 400:
    case 422:
      return standard('badRequest');
    case 401:
      return standard('unauthorized');
    case 403:
      return standard('forbidden');
    case 404:
      return standard('notFound');
    case 409:
      return standard('conflict');
    case 429:
      return standard('tooMany');
    default:
      return standard('generic');
  }
}