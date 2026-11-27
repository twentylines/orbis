import type { ArgumentsHost } from '@nestjs/common';
import { type } from 'arktype';
import { describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';
import { MainExceptionFilter } from '@/common/error/exception.filter';
import { isRecoveryKeyHandoffPath } from '@/common/helpers/error-helpers';

const paths = ['/api/system/sentinel/enrollment/save-key', '/api/system/sentinel/enrollment/confirm-key'];

describe('recovery key path matching', () => {
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
});

describe('HTTP exception boundary', () => {
  it.each(paths)('omits detailed local logging for %s', (originalUrl) => {
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
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, message: 'Internal server error' }));
    expect(JSON.stringify(json.mock.calls)).not.toContain('Synthetic private failure');
  });
});
