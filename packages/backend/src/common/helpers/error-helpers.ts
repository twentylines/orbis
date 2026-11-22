import type { Breadcrumb, ErrorEvent, EventHint } from '@sentry/core';
import cloneDeep from 'lodash.clonedeep';
import validator from 'validator';

const IgnoreErrors = [
  // Innocuous browser errors
  /ResizeObserver loop limit exceeded/,
  /ResizeObserver loop completed with undelivered notifications/,
  // Dark reader extension
  /WeakMap key undefined must be an object or an unregistered symbol/,
  // Docker-compose error
  /no space left on device/,
  /port is already allocated/,
  /address already in use/,
  /Error with your custom app/,
  /cannot assign requested address/,
];

const cleanseUrl = (url: string) => {
  if (validator.isURL(url)) {
    const { pathname, search } = new URL(url);

    return `${pathname}${search}`;
  }

  return url;
};

const shouldIgnoreException = (s: string) => {
  return s && IgnoreErrors.find((pattern) => pattern.test(s));
};

export function isRecoveryKeyHandoffPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const url = value.replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '');
  if (!url.startsWith('/') && !/^https?:\/\//i.test(url)) return false;
  try {
    const pathname = decodeURIComponent(new URL(url, 'http://orbis.invalid').pathname);
    return /^\/(?:api\/)?system\/sentinel\/enrollment\/(?:save-key|confirm-key)\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

type RecoveryTelemetryMarker = {
  request?: { url?: unknown };
  transaction?: unknown;
  tags?: Record<string, unknown>;
  contexts?: { trace?: { data?: Record<string, unknown> } };
  spans?: { description?: unknown; data?: Record<string, unknown> }[];
};

const hasRecoveryKeyUrl = (data?: Record<string, unknown>) =>
  ['url', 'url.full', 'url.path', 'http.url', 'http.target'].some((key) => isRecoveryKeyHandoffPath(data?.[key]));

export function isRecoveryKeyHandoffEvent(event: RecoveryTelemetryMarker): boolean {
  return (
    isRecoveryKeyHandoffPath(event.request?.url) ||
    isRecoveryKeyHandoffPath(event.transaction) ||
    hasRecoveryKeyUrl(event.tags) ||
    hasRecoveryKeyUrl(event.contexts?.trace?.data) ||
    (event.spans?.some((span) => isRecoveryKeyHandoffPath(span.description) || hasRecoveryKeyUrl(span.data)) ?? false)
  );
}

export function isRecoveryKeyHandoffBreadcrumb(breadcrumb: Pick<Breadcrumb, 'data'>): boolean {
  return hasRecoveryKeyUrl(breadcrumb.data);
}

export const cleanseErrorData = (event: ErrorEvent, hint: EventHint) => {
  if (isRecoveryKeyHandoffEvent(event)) return null;
  const result = cloneDeep(event);

  const error = hint && (hint.originalException as Error);

  if (result.transaction) {
    result.transaction = cleanseUrl(result.transaction);
  }

  if (result.breadcrumbs) {
    result.breadcrumbs = result.breadcrumbs.filter((breadcrumb) => !isRecoveryKeyHandoffBreadcrumb(breadcrumb));
    for (const breadcrumb of result.breadcrumbs) {
      if (breadcrumb.data?.url) {
        breadcrumb.data.url = cleanseUrl(breadcrumb.data.url);
      }
    }
  }

  if (result.exception?.values) {
    for (const exception of result.exception.values) {
      if (exception.stacktrace?.frames) {
        for (const frame of exception.stacktrace.frames) {
          if (frame.filename) {
            frame.filename = cleanseUrl(frame.filename);
          }
        }
      }
    }
  }

  if (error?.message && shouldIgnoreException(error.message)) {
    return null;
  }

  // IF error message starts with 'Command failed: docker-compose' then grab only the 200 last characters
  if (error?.message?.startsWith('Command failed: docker-compose')) {
    // Command failed: docker-compose --env-file /storage/app-data/<app-name>/app.env
    const appName = error.message.split('/')[3];
    const message = error.message.slice(-200);
    result.message = `Error with ${appName}: ${message}`;
  }

  if (result.request?.url) {
    result.request.url = cleanseUrl(result.request.url);
  }

  return result;
};
