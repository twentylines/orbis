import { LoggerService } from '@/core/logger/logger.service';
import { backupMaintenanceMiddleware, holdCoreCaptureRecovery } from '@/common/backup-maintenance';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import httpRequest from 'supertest';
import { expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import type { CoreCaptureRecovery } from './time-machine-core-recovery';
import { CoreCaptureRecoveryController } from './time-machine-core-recovery.controller';
import { CoreCaptureRecoveryService } from './time-machine-core-recovery.service';

const id = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const service = new CoreCaptureRecoveryService();
  let running = false;
  const recovery = {
    status: vi.fn((point: string, owner: number) => {
      if (point !== id || owner !== 7) throw Error('Private storage details must not escape.');
      return { id, state: running ? 'starting' : 'needs-attention', canContinue: !running };
    }),
    retry: vi.fn(() => {
      running = true;
      return new Promise<void>(() => undefined);
    }),
  };
  service.register(recovery as unknown as CoreCaptureRecovery);
  return { service, recovery };
}

it('registers one startup recovery and redacts unavailable or foreign recovery details', () => {
  const empty = new CoreCaptureRecoveryService();
  expect(() => empty.status(id, 7)).toThrow('not ready');
  const { service, recovery } = fixture();
  expect(() => service.register(recovery as unknown as CoreCaptureRecovery)).toThrow('not ready');
  expect(() => service.status(id, 8)).toThrow('not ready');
  expect(() => service.continue(id, 8)).toThrow('not ready');
  expect(recovery.retry).not.toHaveBeenCalled();
});

it('accepts one background continuation and retains shutdown cancellation', () => {
  const { service, recovery } = fixture();
  expect(service.continue(id, 7)).toEqual({ id, state: 'starting' });
  expect(() => service.continue(id, 7)).toThrow('not ready');
  expect(recovery.retry).toHaveBeenCalledExactlyOnceWith(id, 7);
  service.onModuleDestroy();
  expect(service.signal.aborted).toBe(true);
  expect(() => service.continue(id, 7)).toThrow('not ready');
});

it('handles a rejected background attempt without leaking its private error or treating it as complete', async () => {
  const { service, recovery } = fixture();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  recovery.retry.mockRejectedValueOnce(Error('Private socket details.'));
  try {
    expect(service.continue(id, 7)).toEqual({ id, state: 'starting' });
    await Promise.resolve();
    expect(warning).toHaveBeenCalledExactlyOnceWith('Snapshot recovery needs attention. Orbis remains held.');
    expect(service.status(id, 7).state).not.toBe('complete');
  } finally {
    warning.mockRestore();
  }
});

it('keeps only authenticated same-origin owner recovery reachable through a real capture maintenance hold', async () => {
  const { service, recovery } = fixture();
  const module = await Test.createTestingModule({
    controllers: [CoreCaptureRecoveryController],
    providers: [AuthGuard, { provide: LoggerService, useValue: { debug: vi.fn() } }, { provide: CoreCaptureRecoveryService, useValue: service }],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('/api');
  app.use(backupMaintenanceMiddleware);
  app.use((request: Request, _response: Response, next: () => void) => {
    const identity = request.headers.authorization;
    if (identity) {
      request.user = { id: identity === 'other-owner' ? 8 : 7, operator: identity !== 'member' } as Request['user'];
      request.authMethod = identity === 'token' ? 'cli' : 'session';
    }
    next();
  });
  holdCoreCaptureRecovery();
  await app.listen(0, '127.0.0.1');
  const post = (identity?: string, origin = 'http://orbis.test', body: object = {}) => {
    const action = httpRequest(app.getHttpServer())
      .post(`/api/system-backups/time-machine/recovery/${id}/continue`)
      .set('Host', 'orbis.test')
      .set('Origin', origin);
    if (identity) action.set('Authorization', identity);
    return action.send(body);
  };
  try {
    expect((await post()).status).toBe(401);
    expect((await post('operator', 'http://other.test')).status).toBe(403);
    expect((await post('member')).status).toBe(403);
    expect((await post('token')).status).toBe(403);
    expect((await post('other-owner')).status).toBe(409);
    expect((await post('operator', 'http://orbis.test', { sourceHoldSha256: 'forged' })).status).toBe(400);
    expect(recovery.retry).not.toHaveBeenCalled();
    const status = await httpRequest(app.getHttpServer()).get(`/api/system-backups/time-machine/recovery/${id}`).set('Authorization', 'operator');
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toEqual({ id, state: 'needs-attention', canContinue: true });
    for (const path of [
      '/api/apps',
      `/api/system-backups/time-machine/recovery/${id}/continue/extra`,
      `/api/system-backups/time-machine/recovery/${id}/extra`,
      '/api/system-backups/time-machine/recovery/not-a-point/continue',
      '/api/system-backups/time-machine/core-captures',
    ]) {
      expect((await httpRequest(app.getHttpServer()).post(path)).status).toBe(503);
    }
    expect((await httpRequest(app.getHttpServer()).get(`/api/system-backups/time-machine/recovery/${id}/continue`)).status).toBe(503);
    expect((await httpRequest(app.getHttpServer()).post(`/api/system-backups/time-machine/recovery/${id}`)).status).toBe(503);
    const accepted = await post('operator');
    expect(accepted.status).toBe(202);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(accepted.body).toEqual({ id, state: 'starting' });
    expect((await post('operator')).status).toBe(409);
    expect(recovery.retry).toHaveBeenCalledExactlyOnceWith(id, 7);
  } finally {
    await app.close();
  }
});
