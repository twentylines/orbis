import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { ResetState } from '../system-reset/reset-state';
import { SystemBackupsService } from './system-backups.service';
import { setBackupRecoveryRequired, setRestoreRecoveryRequired, setResetRecoveryRequired } from '@/common/backup-maintenance';
let root: string;
let service: SystemBackupsService;
let id: string;
const actor = { userId: 7, sessionBinding: 'session', securityBinding: 'security' };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const policy = { version: 1, revision: 1, requireCaptureAuthentication: false, requireRestoreAuthentication: false };
const security = { read: vi.fn() };
const runtime = { resume: vi.fn() };
const request = {} as Request;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-session-actions-')));
  id = randomUUID();
  auth.operatorActionContext.mockReset().mockResolvedValue(actor);
  auth.verifySensitiveAction.mockReset().mockResolvedValue(undefined);
  security.read.mockReset().mockResolvedValue(policy);
  runtime.resume.mockReset().mockResolvedValue(undefined);
  setBackupRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  setResetRecoveryRequired(false);
  const directory = path.join(root, 'backups', 'full', id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(directory, 'job.json'),
    JSON.stringify({
      version: 1,
      id,
      ownerId: 7,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'succeeded',
      stage: 'complete',
      completedBytes: 64,
      totalBytes: 64,
      message: 'Complete',
      resumePending: [],
      restartRequired: false,
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(path.join(directory, 'backup.orbis'), Buffer.alloc(64, 7), { mode: 0o600 });
  service = new SystemBackupsService(
    ...([{ get: () => ({ dataDir: root }) }, auth, {}, {}, {}, runtime, { warn: vi.fn() }, {}, {}, security] as unknown as ConstructorParameters<
      typeof SystemBackupsService
    >),
  );
});
afterEach(async () => {
  await service.onModuleDestroy();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it('downloads the real owner archive with only the current session by default and never calls account proof', async () => {
  const result = await service.downloadForSession(id, 7, request);
  let bytes = 0;
  for await (const chunk of result.stream) bytes += chunk.length;
  expect(bytes).toBe(64);
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  await expect(service.downloadForSession(id, 8, request)).rejects.toThrow();
});
it('creates with the session plus encryption key while the actual archive worker is a declared boundary', async () => {
  const begin = vi.fn().mockResolvedValue({ id });
  const cancel = vi.fn().mockResolvedValue(undefined);
  Reflect.set(service, 'begin', begin);
  Reflect.set(service, 'transferGrant', vi.fn().mockReturnValue({ ready: new Promise(() => undefined), cancel }));
  await service.startForSession(7, undefined, 'entered encryption key', request);
  expect(begin).toHaveBeenCalledWith(7, 'entered encryption key');
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
});
it('requires opted-in proof and fails closed on policy or session changes before exposing ciphertext', async () => {
  security.read.mockResolvedValue({ ...policy, requireCaptureAuthentication: true });
  await expect(service.downloadForSession(id, 7, request)).rejects.toThrow('account password');
  const result = await service.downloadForSession(id, 7, request, { password: 'proof', totpCode: '123456' });
  result.stream.destroy();
  expect(auth.verifySensitiveAction).toHaveBeenCalledWith(7, 'proof', '123456');
  security.read.mockRejectedValueOnce(new Error('Policy unavailable'));
  await expect(service.downloadForSession(id, 7, request)).rejects.toThrow('Policy unavailable');
  security.read.mockResolvedValue(policy);
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, sessionBinding: 'different' });
  await expect(service.downloadForSession(id, 7, request)).rejects.toThrow('session or security setting changed');
});
it('uses the same opt-in for application recovery without a default password prompt', async () => {
  await service.recoverForSession(id, 7, request);
  expect(runtime.resume).toHaveBeenCalledOnce();
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  security.read.mockResolvedValue({ ...policy, requireCaptureAuthentication: true });
  await expect(service.recoverForSession(id, 7, request)).rejects.toThrow('account password');
  expect(runtime.resume).toHaveBeenCalledOnce();
});

it('a completed reset keeps the valid saved archive listed with its generation receipt', async () => {
  const resetId = randomUUID();
  await new ResetState(root).save({
    version: 1,
    id: resetId,
    controller: 'fixture',
    users: [7],
    accounts: 'keep',
    phase: 'complete',
    createdAt: Date.now() + 10,
  });
  const list = await service.list(7);
  expect(list.jobs.map((job) => job.id)).toEqual([id]);
  expect(list.resetGeneration?.id).toBe(resetId);
  expect((await fs.stat(path.join(root, 'backups', 'full', id, 'backup.orbis'))).size).toBe(64);
});
