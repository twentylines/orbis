import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueueFactory } from '../queue/queue.factory';
const base = process.env.ORBIS_CORE_CAPTURE_TEST_DIR ?? os.tmpdir();
let data: string;
let subject: typeof import('./time-machine-core-source-hold');
let maintenance: typeof import('@/common/backup-maintenance');
const prep = () => ({
  id: randomUUID(),
  operatorAuthorizationId: randomUUID(),
  preparationSha256: 'a'.repeat(64),
  sourceSha256: 'b'.repeat(64),
  controller: { id: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: 'e'.repeat(64) },
});
const queue = () => {
  let busy = false;
  const pauseId = randomUUID();
  const state = {
    pauseId,
    generation: 1,
    checkedAt: Date.now(),
    queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0 as const, consumers: 0 as const })),
  };
  const release = vi.fn(() => {
    busy = false;
  });
  const verify = vi.fn(async () => state);
  return {
    instance: {
      pauseForBackup: vi.fn(async () => {
        if (busy) throw new Error('Queue capture is already in progress.');
        busy = true;
        return { initial: state, verify, release };
      }),
    } as unknown as Pick<QueueFactory, 'pauseForBackup'>,
    release,
    verify,
  };
};
beforeEach(async () => {
  vi.resetModules();
  subject = await import('./time-machine-core-source-hold');
  maintenance = await import('@/common/backup-maintenance');
  data = path.join(base, `orbis-core-source-hold-${randomUUID()}`);
  await fs.mkdir(path.join(data, 'backups', 'time-machine'), { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await fs.rm(data, { recursive: true, force: true });
});
it.skipIf(process.platform !== 'linux')('persists and rechecks a private hold and retains it after uncertain handoff', async () => {
  const q = queue();
  const session = await subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal);
  const file = path.join(data, 'backups/time-machine/core-capture/source-hold.json');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(session.marker);
  expect(session.marker.drainReservationId).toBe(session.marker.queueDrain.pauseId);
  await expect(
    session.handoff(async () => {
      throw new Error('unknown outcome');
    }),
  ).rejects.toThrow('unknown outcome');
  expect(q.release).not.toHaveBeenCalled();
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('held');
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
it('unwinds before marker creation when queue verification fails', async () => {
  const q = queue();
  q.verify.mockRejectedValueOnce(new Error('not drained'));
  await expect(subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal)).rejects.toThrow('not drained');
  expect(q.release).toHaveBeenCalledOnce();
  await expect(fs.lstat(path.join(data, 'backups/time-machine/core-capture/source-hold.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('persists draft work under the drain and reports a fully unwound pre-marker failure', async () => {
  const q = queue();
  const error = new Error('Draft storage refused.');
  const beforeMarker = vi.fn(async () => {
    expect(maintenance.backupMaintenanceActive()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
    throw error;
  });
  await expect(subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal, beforeMarker)).rejects.toBe(error);
  expect(subject.coreCaptureSourceFailureWasUnwound(error)).toBe(true);
  expect(subject.coreCaptureSourceFailureWasUnwound(new Error('Draft storage refused.'))).toBe(false);
  expect(q.release).toHaveBeenCalledOnce();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  await expect(fs.lstat(path.join(data, 'backups/time-machine/core-capture/source-hold.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.skipIf(process.platform !== 'linux')('pins the original point reservation in a distinct v2 hold', async () => {
  const q = queue();
  const preparation = { ...prep(), pointReservationSha256: 'f'.repeat(64) };
  const session = await subject.prepareCoreCaptureSourceHold(data, preparation, q.instance, new AbortController().signal);
  expect(session.marker.schema).toBe('orbis.core-capture-source-hold.v2');
  expect(session.marker.pointReservationSha256).toBe(preparation.pointReservationSha256);
  await session.recheck();
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('held');
  expect(q.release).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== 'linux')('does not reinterpret an invalid v2 binding as a legacy hold', async () => {
  const q = queue();
  await expect(
    subject.prepareCoreCaptureSourceHold(data, { ...prep(), pointReservationSha256: '../point' }, q.instance, new AbortController().signal),
  ).rejects.toThrow();
  expect(q.release).toHaveBeenCalledOnce();
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('absent');
});
it('drains queue workers before acquiring the managed mutation hold', async () => {
  const q = queue();
  const originalPause = q.instance.pauseForBackup;
  q.instance.pauseForBackup = async (signal) => {
    expect(maintenance.backupMaintenanceActive()).toBe(false);
    return originalPause(signal);
  };
  q.verify.mockImplementationOnce(async () => {
    expect(maintenance.backupMaintenanceActive()).toBe(true);
    throw new Error('verification stopped before marker');
  });
  await expect(subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal)).rejects.toThrow(
    'verification stopped before marker',
  );
  expect(q.release).toHaveBeenCalledOnce();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});
it.skipIf(process.platform !== 'linux')('holds on malformed and symlink markers after restart', async () => {
  const dir = path.join(data, 'backups/time-machine/core-capture');
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'source-hold.json'), '{}', { mode: 0o600 });
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
  vi.resetModules();
  subject = await import('./time-machine-core-source-hold');
  maintenance = await import('@/common/backup-maintenance');
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
  expect(maintenance.backupMaintenanceActive()).toBe(true);
  await fs.unlink(path.join(dir, 'source-hold.json'));
  await fs.symlink('/dev/null', path.join(dir, 'source-hold.json'));
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
});
it.skipIf(process.platform !== 'linux')('refuses a replaced marker before the request and retains the queue', async () => {
  const q = queue();
  const session = await subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal);
  const file = path.join(data, 'backups/time-machine/core-capture/source-hold.json');
  await fs.unlink(file);
  await fs.writeFile(file, '{}', { mode: 0o600 });
  const request = vi.fn(async () => undefined);
  await expect(session.handoff(request)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(q.release).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== 'linux')('rejects a byte-identical replacement before handing ownership to root', async () => {
  const q = queue();
  const session = await subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal);
  const file = path.join(data, 'backups/time-machine/core-capture/source-hold.json');
  const bytes = await fs.readFile(file);
  await fs.rename(file, `${file}.retained`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const request = vi.fn(async () => undefined);
  await expect(session.handoff(request)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  expect(q.release).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== 'linux')('keeps a present marker held when descriptor traversal is unavailable', async () => {
  const q = queue();
  await subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, new AbortController().signal);
  const traversal = vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('proc unavailable'), { code: 'ENOENT' }));
  try {
    expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
  } finally {
    traversal.mockRestore();
  }
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
it.skipIf(process.platform !== 'linux')('serializes concurrent acquisition and retains hold after abort', async () => {
  const q = queue();
  const abort = new AbortController();
  const attempts = await Promise.allSettled([
    subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, abort.signal),
    subject.prepareCoreCaptureSourceHold(data, prep(), q.instance, abort.signal),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  abort.abort();
  const success = attempts.find((x) => x.status === 'fulfilled');
  if (!success || success.status !== 'fulfilled') throw new Error('missing session');
  await expect(success.value.recheck()).rejects.toThrow();
  expect(q.release).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'linux')('allows a safely absent marker and holds a present marker on an unsupported platform', async () => {
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('absent');
  const dir = path.join(data, 'backups/time-machine/core-capture');
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'source-hold.json'), '{}', { mode: 0o600 });
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
it('blocks startup before migrations and rejects mutations while permitting authentication', async () => {
  maintenance.holdCoreCaptureRecovery();
  maintenance.setBackupRecoveryRequired(false);
  maintenance.setRestoreRecoveryRequired(false);
  maintenance.setResetRecoveryRequired(false);
  const { AppService } = await import('@/app.service');
  const migrate = vi.fn();
  const prepare = vi.fn();
  await AppService.prototype.bootstrap.call({ logger: { warn: vi.fn() }, databaseService: { migrate } } as never, prepare);
  expect(migrate).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const setHeader = vi.fn();
  const response = { status, json, setHeader } as never;
  const next = vi.fn();
  maintenance.backupMaintenanceMiddleware({ method: 'GET', originalUrl: '/api/tasks' } as never, response, next);
  expect(status).toHaveBeenCalledWith(503);
  expect(next).not.toHaveBeenCalled();
  maintenance.backupMaintenanceMiddleware({ method: 'POST', originalUrl: '/api/auth/login' } as never, response, next);
  expect(next).toHaveBeenCalledOnce();
});
it('does not create queue consumers while capture recovery is held', async () => {
  maintenance.holdCoreCaptureRecovery();
  const { Queue, QueueLifecycle } = await import('../queue/queue.entity');
  const rabbit = { createConsumer: vi.fn() };
  const queue = new Queue(
    rabbit as never,
    {} as never,
    {} as never,
    'app-events-queue',
    1,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    new QueueLifecycle(),
  );
  queue.onEvent(vi.fn());
  expect(rabbit.createConsumer).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('holds a marker with foreign ownership', async () => {
  const dir = path.join(data, 'backups/time-machine/core-capture');
  await fs.mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, 'source-hold.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await fs.chown(file, 65534, 65534);
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
it.skipIf(process.platform !== 'linux')('holds a multiply linked marker', async () => {
  const dir = path.join(data, 'backups/time-machine/core-capture');
  await fs.mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, 'source-hold.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await fs.link(file, path.join(dir, 'other'));
  expect(await subject.inspectCoreCaptureSourceHold(data)).toBe('invalid');
});
it('skips mutating backup service initialization while held', async () => {
  maintenance.holdCoreCaptureRecovery();
  const { TimeMachineService } = await import('./time-machine.service');
  const { BackupDatabaseService } = await import('./backup-database.service');
  const { SystemBackupsService } = await import('./system-backups.service');
  const { BackupImportsService } = await import('./backup-imports.service');
  const initialize = vi.fn();
  const fake = { initialize } as never;
  await TimeMachineService.prototype.onModuleInit.call(fake);
  await BackupDatabaseService.prototype.onModuleInit.call(fake);
  await SystemBackupsService.prototype.onModuleInit.call(fake);
  await BackupImportsService.prototype.onModuleInit.call(fake);
  expect(initialize).not.toHaveBeenCalled();
});
