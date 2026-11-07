import { type ArgumentsHost, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';
import { timeMachineConflict } from '@/modules/system-backups/time-machine-policy';
import { MainExceptionFilter } from './exception.filter';

describe('Time Machine HTTP issues', () => {
  function serialize(exception: ConflictException) {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url: '/api/system-backups/time-machine/onboarding-captures/test' }),
      }),
    } as unknown as ArgumentsHost;
    new MainExceptionFilter({ error: vi.fn() } as unknown as LoggerService).catch(exception, host);
    expect(status).toHaveBeenCalledWith(409);
    return json.mock.calls[0]?.[0];
  }

  it('preserves the missing-point code used to start an onboarding capture', () => {
    expect(serialize(timeMachineConflict('point-not-found'))).toMatchObject({
      statusCode: 409,
      code: 'point-not-found',
      message: 'This restore point is not available.',
    });
  });

  it('preserves known restore authorization codes', () => {
    expect(serialize(new ConflictException({ code: 'authorization-expired', message: 'Authorize this point again.' }))).toMatchObject({
      code: 'authorization-expired',
    });
  });

  it('does not forward arbitrary exception payloads or unrecognised codes', () => {
    expect(serialize(new ConflictException({ code: 'private-code', message: 'Conflict', privateData: 'not public' }))).not.toHaveProperty('code');
    expect(serialize(new ConflictException({ code: 'point-not-found', message: 'Conflict', privateData: 'not public' }))).not.toHaveProperty(
      'privateData',
    );
  });
});
