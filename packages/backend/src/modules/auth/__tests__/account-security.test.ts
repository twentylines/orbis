import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { AccountSecurityService } from '../account-security.service';
import { AccountSecurityController } from '../account-security.controller';
import { AuthGuard } from '../auth.guard';
import type { Request } from 'express';
let directory: string;
let service: AccountSecurityService;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-account-security-'));
  service = new AccountSecurityService({ get: () => ({ dataDir: directory }) } as never);
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
it('defaults off, persists per account privately, rejects stale writes and requires fresh proof to relax an enabled policy', async () => {
  expect(await service.read(1)).toEqual({ version: 1, revision: 0, requireCaptureAuthentication: false, requireRestoreAuthentication: false });
  const authorize = vi.fn().mockResolvedValue(undefined);
  await service.update(1, { expectedRevision: 0, requireCaptureAuthentication: true }, authorize);
  expect(authorize).not.toHaveBeenCalled();
  expect((await service.read(2)).requireCaptureAuthentication).toBe(false);
  const reload = new AccountSecurityService({ get: () => ({ dataDir: directory }) } as never);
  expect(await reload.read(1)).toMatchObject({ revision: 1, requireCaptureAuthentication: true });
  expect((await fs.stat(path.join(directory, 'state/account-security/1.json'))).mode & 0o777).toBe(0o600);
  await expect(service.update(1, { expectedRevision: 0, requireCaptureAuthentication: false }, authorize)).rejects.toThrow('changed');
  await expect(
    service.update(1, { expectedRevision: 1, requireCaptureAuthentication: false }, async () => {
      throw new Error('Fresh proof rejected');
    }),
  ).rejects.toThrow('Fresh proof');
  expect((await service.read(1)).requireCaptureAuthentication).toBe(true);
  await service.update(1, { expectedRevision: 1, requireCaptureAuthentication: false }, authorize);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(await service.read(1)).toMatchObject({ revision: 2, requireCaptureAuthentication: false });
});
it('fails closed for malformed, unsafe and symlinked policy files', async () => {
  await service.update(1, { expectedRevision: 0, requireCaptureAuthentication: true }, async () => undefined);
  const file = path.join(directory, 'state/account-security/1.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await expect(service.read(1)).rejects.toThrow('could not be verified');
  await fs.writeFile(file, '{"version":1,"revision":1,"requireCaptureAuthentication":false}');
  await fs.chmod(file, 0o644);
  await expect(service.read(1)).rejects.toThrow('could not be verified');
  await fs.rm(file);
  await fs.symlink(path.join(directory, 'missing'), file);
  await expect(service.read(1)).rejects.toThrow('could not be verified');
});
it('keeps an opted-in restore policy across older capture-only updates and requires proof to disable it', async () => {
  const authorize = vi.fn().mockResolvedValue(undefined);
  await service.update(1, { expectedRevision: 0, requireCaptureAuthentication: false, requireRestoreAuthentication: true }, authorize);
  expect(authorize).not.toHaveBeenCalled();
  await service.update(1, { expectedRevision: 1, requireCaptureAuthentication: true }, authorize);
  expect(await service.read(1)).toMatchObject({ requireCaptureAuthentication: true, requireRestoreAuthentication: true });
  await service.update(1, { expectedRevision: 2, requireCaptureAuthentication: true, requireRestoreAuthentication: false }, authorize);
  expect(authorize).toHaveBeenCalledOnce();
});
it('policy endpoints and manual capture admission retain operator-session and same-origin enforcement', async () => {
  const auth = { verifySensitiveAction: vi.fn().mockResolvedValue(undefined) };
  const controller = new AccountSecurityController(service, auth as never);
  const operator = { authMethod: 'session', user: { id: 1, operator: true } } as Request;
  expect(await controller.read(operator)).toMatchObject({ requireCaptureAuthentication: false });
  for (const request of [
    { authMethod: 'session', user: { id: 2, operator: false } },
    { authMethod: 'cli', user: { id: 1, operator: true } },
  ])
    expect(() => controller.read(request as Request)).toThrow('operator session');
  const guard = new AuthGuard({ debug: () => undefined } as never);
  const context = (origin: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          ...operator,
          method: 'POST',
          protocol: 'https',
          url: '/api/system-backups/time-machine/captures',
          headers: { host: 'orbis.test', origin },
        }),
      }),
    }) as ExecutionContext;
  expect(await guard.canActivate(context('https://orbis.test'))).toBe(true);
  await expect(guard.canActivate(context('https://other.test'))).rejects.toThrow('Invalid request origin');
});
