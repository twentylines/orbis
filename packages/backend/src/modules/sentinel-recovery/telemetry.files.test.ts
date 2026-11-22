import type { Envelope } from '@sentry/core';
import * as Sentry from '@sentry/nestjs';
import type { ArgumentsHost } from '@nestjs/common';
import { type } from 'arktype';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';
import { MainExceptionFilter } from '@/common/error/exception.filter';
import { cleanseErrorData, isRecoveryKeyHandoffEvent, isRecoveryKeyHandoffPath } from '@/common/helpers/error-helpers';

vi.mock('@sentry/nestjs', async (original) => {
  const sdk = await original<typeof import('@sentry/nestjs')>();
  return { ...sdk, init: vi.fn(), captureException: vi.fn(sdk.captureException), httpIntegration: vi.fn(sdk.httpIntegration) };
});

const envelopes: Envelope[] = [];
const paths = ['/api/system/sentinel/enrollment/save-key', '/api/system/sentinel/enrollment/confirm-key'];
const concurrentPrivateFailure = () => ['Synthetic', 'private', 'concurrent', 'failure'].join(' ');
let sdk: typeof Sentry;

const payloads = (kind: string) =>
  envelopes.flatMap((envelope) => envelope[1].filter(([header]) => header.type === kind).map(([, payload]) => payload));

beforeAll(async () => {
  await import('../../instrument');
  const options = vi.mocked(Sentry.init).mock.calls.at(-1)?.[0];
  expect(options).toBeDefined();
  sdk = await vi.importActual<typeof Sentry>('@sentry/nestjs');
  sdk.init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
});

beforeEach(() => {
  envelopes.length = 0;
  vi.mocked(Sentry.captureException).mockClear();
});

afterAll(async () => {
  await sdk.close(2000);
});

describe('recovery key telemetry route matching', () => {
  it.each(paths)('recognises path, URL and transaction markers for %s', (path) => {
    for (const value of [path, path.replace('/api/', '/'), `${path}/`, `https://orbis.invalid${path}?format=text`, `POST ${path}`]) {
      expect(isRecoveryKeyHandoffPath(value)).toBe(true);
    }
    expect(isRecoveryKeyHandoffPath(path.replace('enrollment', '%65nrollment'))).toBe(true);
  });

  it.each([
    undefined,
    '/api/system/sentinel',
    '/api/system/sentinel/enrollment/save-key-status',
    '/api/system/sentinel/enrollment/confirm-key/next',
    '/api/unrelated/system/sentinel/enrollment/save-key',
    '/api/settings?next=/system/sentinel/enrollment/save-key',
    'https://orbis.invalid/api/settings#system/sentinel/enrollment/save-key',
    '/api/%broken/system/sentinel/enrollment/save-key',
  ])('keeps unrelated and invalid markers: %s', (value) => {
    expect(isRecoveryKeyHandoffPath(value)).toBe(false);
  });

  it.each(paths)('covers URL tags, trace data and child spans for %s', (path) => {
    expect(isRecoveryKeyHandoffEvent({ tags: { url: path } })).toBe(true);
    expect(isRecoveryKeyHandoffEvent({ contexts: { trace: { data: { 'http.target': path } } } })).toBe(true);
    expect(isRecoveryKeyHandoffEvent({ spans: [{ description: `POST ${path}` }] })).toBe(true);
    expect(isRecoveryKeyHandoffEvent({ spans: [{ data: { 'url.full': `https://orbis.invalid${path}` } }] })).toBe(true);
  });

  it('removes an already retained sensitive breadcrumb without mutating the original event', () => {
    const event = { type: undefined, breadcrumbs: [{ data: { url: paths[0] } }, { message: 'ordinary breadcrumb' }] };
    expect(cleanseErrorData(event, {})).toEqual({ type: undefined, breadcrumbs: [{ message: 'ordinary breadcrumb' }] });
    expect(event.breadcrumbs).toHaveLength(2);
  });
});

describe('enabled error and transaction capture with an in-memory transport', () => {
  it.each(paths)('does not emit a tags-only error from %s', async (path) => {
    sdk.captureException(new Error('Synthetic handoff failure'), { tags: { url: path } });
    expect(await sdk.flush(2000)).toBe(true);
    expect(payloads('event')).toEqual([]);
  });

  it.each(paths)('does not emit a transaction marked only by its name: %s', async (path) => {
    sdk.startSpan({ name: `POST ${path}`, op: 'http.server', forceTransaction: true }, () => {});
    expect(await sdk.flush(2000)).toBe(true);
    expect(payloads('transaction')).toEqual([]);
  });

  it.each(paths)('excludes opaque errors, spans and breadcrumbs inside the request scope: %s', async (path) => {
    await sdk.withIsolationScope(async (scope) => {
      scope.setSDKProcessingMetadata({ normalizedRequest: { url: `https://orbis.invalid${path}` } });
      sdk.addBreadcrumb({ message: 'Synthetic handoff payload' });
      expect(scope.getScopeData().breadcrumbs).toEqual([]);
      sdk.startSpan({ name: 'opaque-handler', forceTransaction: true }, () => {
        sdk.captureException(new Error('Synthetic early failure'));
      });
      expect(await sdk.flush(2000)).toBe(true);
    });
    expect(payloads('event')).toEqual([]);
    expect(payloads('transaction')).toEqual([]);
    expect(JSON.stringify(envelopes)).not.toContain('Synthetic handoff payload');
    expect(JSON.stringify(envelopes)).not.toContain('Synthetic early failure');
  });

  it('keeps ordinary errors, transactions and breadcrumbs including query-string neighbours', async () => {
    const path = '/api/settings?next=/system/sentinel/enrollment/save-key';
    await sdk.withIsolationScope(async (scope) => {
      scope.setSDKProcessingMetadata({ normalizedRequest: { url: `https://orbis.invalid${path}` } });
      sdk.addBreadcrumb({ message: 'Ordinary settings action' });
      expect(scope.getScopeData().breadcrumbs).toHaveLength(1);
      sdk.startSpan({ name: 'POST /api/settings', forceTransaction: true }, () => {
        sdk.captureException(new Error('Ordinary settings failure'), { tags: { url: path } });
      });
      expect(await sdk.flush(2000)).toBe(true);
    });
    expect(payloads('event')).toHaveLength(1);
    expect(payloads('transaction')).toHaveLength(1);
  });

  it('keeps concurrent request scopes isolated when capture happens after an await', async () => {
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Promise.all([
      sdk.withIsolationScope(async (scope) => {
        scope.setSDKProcessingMetadata({ normalizedRequest: { url: `https://orbis.invalid${paths[0]}` } });
        await ready;
        sdk.captureException(new Error(concurrentPrivateFailure()));
      }),
      sdk.withIsolationScope(async (scope) => {
        scope.setSDKProcessingMetadata({ normalizedRequest: { url: 'https://orbis.invalid/api/settings' } });
        release();
        await ready;
        sdk.captureException(new Error('Ordinary concurrent failure'));
      }),
    ]);
    expect(await sdk.flush(2000)).toBe(true);
    expect(payloads('event')).toHaveLength(1);
    expect(JSON.stringify(payloads('event'))).toContain('Ordinary concurrent failure');
    expect(JSON.stringify(envelopes)).not.toContain(concurrentPrivateFailure());
  });

  it('excludes key request bodies and incoming/outgoing request tracing at instrumentation entry', () => {
    const options = vi.mocked(Sentry.httpIntegration).mock.calls.at(-1)?.[0];
    expect(options).toBeDefined();
    for (const path of paths) {
      expect(options?.ignoreIncomingRequests?.(path, {} as never)).toBe(true);
      expect(options?.ignoreIncomingRequestBody?.(`https://orbis.invalid${path}`, {} as never)).toBe(true);
      expect(options?.ignoreOutgoingRequests?.(`https://orbis.invalid${path}`, {} as never)).toBe(true);
    }
    expect(options?.ignoreIncomingRequests?.('/api/system/sentinel', {} as never)).toBe(false);
    expect(options?.ignoreIncomingRequestBody?.('https://orbis.invalid/api/settings', {} as never)).toBe(false);
  });
});

describe('HTTP exception boundary', () => {
  it.each(paths)('omits capture and detailed local logging for %s', (originalUrl) => {
    const logger = { error: vi.fn() };
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })) };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ originalUrl, url: '/mounted-route' }), getResponse: () => response }),
    } as unknown as ArgumentsHost;
    const exception = Object.assign(new Error('Synthetic private failure'), {
      error: type({ recoveryKey: 'number' })({ recoveryKey: 'Synthetic private value' }),
    });
    new MainExceptionFilter(logger as unknown as LoggerService).catch(exception, host);
    expect(logger.error).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Internal server error' }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('Synthetic private failure');
  });
});
