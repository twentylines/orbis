import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppEventsQueue, type AppEvent, appEventResultSchema, appEventSchema } from '@/modules/queue/entities/app-events';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { createMockApp, createMockAppInfo, createMockAppStore } from '@/tests/helpers/app-mocks';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Test, type TestingModule } from '@nestjs/testing';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppStatusSyncService } from './app-status-sync.service';
import { AppJobService } from './services/app-job.service';
import { InstallAppHandler } from './handlers/install-app.handler';
import { StartAppHandler } from './handlers/start-app.handler';
import { hasInstallRequestHold, installRequestDirectory, reserveInstallRequest, takeInstallRequestReceipt } from './install-request-receipt';
import { AppValidationService } from './services/app-validation.service';
import { StatusManagerService } from './services/status-manager.service';
import { AppUpdateStage } from '../docker/app-update-stage';
import { freshInstallResultBinding } from '../apps/app-fresh-commit';
import { retainFreshInstallResult } from './install-result';
import { requestInputHash } from './commands/update-app-command';

const appUrn = createAppUrn('demo', 'store');
type AppResult = typeof appEventResultSchema.infer;

function pending<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe('install reservation through queue delivery', () => {
  let directory: string;
  let testingModule: TestingModule | undefined;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-install-replay-'));
  });

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    config.get.calledWith('userSettings').mockReturnValue({ eventsTimeout: 5 } as never);
    const repository = mock<AppsRepository>();
    const queue = mock<AppEventsQueue>();
    const statusManager = mock<StatusManagerService>();
    const store = mock<AppStoreRepository>();
    const marketplace = mock<MarketplaceService>();
    const backups = mock<BackupManager>();
    const mutex = new AsyncMutex();
    const tasks = new TasksService(config, mock<LoggerService>());
    const factory = mock<AppLifecycleCommandFactory>();
    const execute = vi.fn<() => Promise<AppResult>>().mockResolvedValue({ success: true, message: 'Installed' });
    factory.createCommand.mockReturnValue({ execute });
    store.getAppStoreBySlug.mockResolvedValue(createMockAppStore({ slug: 'store' }));
    marketplace.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(createMockAppInfo({ tipi_version: 1 }));
    backups.hasPendingRestore.mockResolvedValue(false);

    let row: ReturnType<typeof createMockApp> | undefined;
    const current = () => row;
    const replace = (currentRow: typeof row) => {
      row = currentRow;
    };
    const reservationMatches = (reservation: { id: number; createdAt: number; appName: string; appStoreSlug: string }) =>
      row?.status === 'installing' &&
      row.id === reservation.id &&
      row.createdAt === reservation.createdAt &&
      row.appName === reservation.appName &&
      row.appStoreSlug === reservation.appStoreSlug;
    repository.getAppByUrn.mockImplementation(async () => row);
    repository.getApps.mockImplementation(async () => (row ? [row] : []));
    repository.createApp.mockImplementation(async (values) => {
      row = createMockApp({ ...values, id: 42, createdAt: 1000, updatedAt: 1000 });
      return row;
    });
    repository.deleteInstallReservation.mockImplementation(async (reservation) => {
      if (!reservationMatches(reservation)) return false;
      row = undefined;
      return true;
    });
    repository.finishInstallReservation.mockImplementation(async (reservation, status) => {
      if (!row || !reservationMatches(reservation)) return false;
      row = { ...row, status };
      return true;
    });

    const rpc = pending<AppResult>();
    const sent = pending<AppEvent>();
    queue.publish.mockImplementation(async (raw) => {
      sent.settle(appEventSchema.assert(raw));
      return rpc.promise;
    });
    const newHandler = () =>
      new InstallAppHandler(
        repository,
        queue,
        statusManager,
        mock<AppValidationService>(),
        marketplace,
        mock<StartAppHandler>(),
        store,
        mutex,
        config,
        mock<LoggerService>(),
      );
    const handler = newHandler();
    testingModule = await Test.createTestingModule({ providers: [AppLifecycleService] })
      .useMocker((token) => {
        if (token === TasksService) return tasks;
        if (token === AppEventsQueue) return queue;
        if (token === AppLifecycleCommandFactory) return factory;
        if (token === APP_ASYNC_MUTEX) return mutex;
        if (token === InstallAppHandler) return handler;
        if (token === BackupManager) return backups;
        if (token === AppsRepository) return repository;
        if (token === DOCKERODE) return {};
        return mock();
      })
      .compile();
    const service = testingModule.get(AppLifecycleService);

    const deliver = (data: AppEvent, reply: (result: AppResult) => Promise<void> = async () => undefined, redelivered = false) =>
      service.invokeCommand(data, reply, redelivered);
    const publish = async (skipRun = false) => {
      const { requestId } = await service.installApp({ appUrn, form: { SERVICE_LABEL: 'fixture' }, skipRun });
      const data = await sent.promise;
      expect(data.requestId).toBe(requestId);
      return data;
    };
    const receiptFile = (data: AppEvent) => path.join(installRequestDirectory(directory, data.appUrn), data.requestId);
    const docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);
    const reconcile = () =>
      new AppStatusSyncService(
        mock<LoggerService>(),
        repository,
        mock<SSEService>(),
        mock<SystemEventsQueue>(),
        config,
        docker,
        mutex,
        mock<AppJobService>(),
      ).syncAllAppStatuses();
    return {
      current,
      replace,
      repository,
      statusManager,
      service,
      tasks,
      execute,
      publish,
      deliver,
      rpc,
      backups,
      newHandler,
      receiptFile,
      reconcile,
    };
  }

  it('revokes an unclaimed timeout and denies a delayed job against the replacement row', async () => {
    const f = await fixture();
    const data = await f.publish();
    f.rpc.settle({ success: false, message: 'RPC timeout' });
    await vi.waitFor(() => expect(f.current()).toBeUndefined());
    const replacement = createMockApp({ id: 43, createdAt: 1001, appName: 'demo', appStoreSlug: 'store', status: 'installing' });
    f.replace(replacement);

    await f.deliver(data);

    expect(f.current()).toBe(replacement);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backups.hasPendingRestore).not.toHaveBeenCalled();
    expect(f.repository.finishInstallReservation).not.toHaveBeenCalled();
    expect(f.repository.deleteInstallReservation).toHaveBeenCalledOnce();
    expect((await f.tasks.read()).tasks[0]?.status).toBe('interrupted');
  });

  it('allows only one winner when the worker and publisher both read the receipt before claiming it', async () => {
    const f = await fixture();
    const data = await f.publish();
    const receipt = f.receiptFile(data);
    const bothReady = pending<void>();
    const continueClaim = pending<void>();
    const actualRename = fs.rename.bind(fs);
    const outcomes: string[] = [];
    let entered = 0;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (file, destination) => {
      if (file === receipt) {
        if (++entered === 2) bothReady.settle();
        await continueClaim.promise;
      }
      try {
        await actualRename(file, destination);
        if (file === receipt) outcomes.push('renamed');
      } catch (error) {
        if (file === receipt) outcomes.push((error as NodeJS.ErrnoException).code ?? 'unknown');
        throw error;
      }
    });
    try {
      const delivery = f.deliver(data);
      f.rpc.settle({ success: false, message: 'RPC timeout' });
      await bothReady.promise;
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.repository.deleteInstallReservation).not.toHaveBeenCalled();
      continueClaim.settle();
      await delivery;
      await vi.waitFor(() => expect(outcomes.sort()).toEqual(['ENOENT', 'renamed']));
      await vi.waitFor(() =>
        expect({ executed: f.execute.mock.calls.length, deleted: f.repository.deleteInstallReservation.mock.calls.length }).toEqual(
          f.execute.mock.calls.length ? { executed: 1, deleted: 0 } : { executed: 0, deleted: 1 },
        ),
      );
      expect(f.current()?.status).toBe(f.execute.mock.calls.length ? 'running' : undefined);
    } finally {
      continueClaim.settle();
      rename.mockRestore();
    }
  });

  it('allows one claim across repeated real filesystem races and leaves the hold until cleanup', async () => {
    const app = { id: 42, createdAt: 1000, appName: 'demo', appStoreSlug: 'store' };
    const owner = randomUUID();
    for (let round = 0; round < 25; round++) {
      const request = { app, requestId: randomUUID(), owner, skipRun: false };
      await reserveInstallRequest(directory, appUrn, request, async () => app);
      const claims = await Promise.all(Array.from({ length: 4 }, () => takeInstallRequestReceipt(directory, request)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await hasInstallRequestHold(directory, appUrn)).toBe(true);
      expect(await takeInstallRequestReceipt(directory, request)).toBeUndefined();
      const cleanup = claims.find(Boolean);
      await cleanup?.();
      expect(await hasInstallRequestHold(directory, appUrn)).toBe(false);
    }
  });

  it.each([false, true])('settles the claimed result despite RPC timeout or a lost reply with skipRun=%s', async (skipRun) => {
    const f = await fixture();
    const entered = pending<void>();
    const release = pending<AppResult>();
    f.execute.mockImplementation(async () => {
      entered.settle();
      return release.promise;
    });
    const data = await f.publish(skipRun);
    const delivery = f.deliver(data, vi.fn().mockRejectedValue(new Error('Reply channel lost')));
    await entered.promise;
    await f.tasks.unconfirmed(data);
    f.rpc.settle({ success: false, message: 'RPC timeout' });
    await expect(fs.stat(f.receiptFile(data))).rejects.toHaveProperty('code', 'ENOENT');
    expect(await f.reconcile()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
    expect(f.current()?.status).toBe('installing');
    await expect(f.service.startApp({ appUrn })).rejects.toThrow('still running or needs review');
    release.settle({ success: true, message: 'Installed' });
    await expect(delivery).rejects.toThrow('Reply channel lost');

    const duplicate = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, duplicate, true);
    const status = skipRun ? 'stopped' : 'running';
    expect(f.current()).toMatchObject({ status, migrationsBaselined: false });
    expect(f.repository.deleteInstallReservation).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(false);
    expect(f.statusManager.emitEvent).toHaveBeenCalledWith({ appUrn, event: 'install_success', appStatus: status });
    expect(duplicate).toHaveBeenCalledExactlyOnceWith({
      success: true,
      alreadyCompleted: true,
      message: 'This install request has already completed.',
    });
    expect((await f.tasks.read()).tasks[0]?.status).toBe('succeeded');
  });

  it('uses the reserved row config even when the delivery form differs', async () => {
    const f = await fixture();
    const data = await f.publish(true);
    const request = { ...data, form: { ...data.form, SERVICE_LABEL: 'changed at delivery', skipEnv: true } };

    await f.deliver(request);

    expect(f.execute).toHaveBeenCalledExactlyOnceWith(appUrn, expect.objectContaining({ SERVICE_LABEL: 'fixture', skipRun: true, skipEnv: false }));
  });

  it('still reconciles an expired app install whose worker is inactive', async () => {
    const f = await fixture();
    const data = await f.publish();
    expect(await f.reconcile()).toMatchObject({ success: true, syncedCount: 1, skippedCount: 0 });
    expect(f.current()?.status).toBe('stopped');
    expect(f.repository.updateAppById).not.toHaveBeenCalled();

    await f.deliver(data);

    expect(f.execute).not.toHaveBeenCalled();
    expect(f.current()?.migrationsBaselined).toBe(false);
  });

  it('rejects a different row, install mode and replacement controller despite an unclaimed receipt', async () => {
    const f = await fixture();
    const data = await f.publish(true);
    const original = f.current();
    expect(original).toBeDefined();
    const replacement = createMockApp({ ...original, createdAt: 1001 });
    f.replace(replacement);
    await f.deliver(data);
    expect(f.current()).toBe(replacement);
    expect(f.execute).not.toHaveBeenCalled();

    f.replace(original);
    await f.deliver({ ...data, form: { ...data.form, skipRun: false } });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await fs.stat(f.receiptFile(data))).toMatchObject({ nlink: 1 });

    Object.assign(f.service, { installAppHandler: f.newHandler() });
    await f.deliver(data);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backups.hasPendingRestore).not.toHaveBeenCalled();
    expect(f.current()).toBe(original);
  });

  it('rejects old messages and avoids replaying a redelivered reservation', async () => {
    const f = await fixture();
    const data = await f.publish();
    await f.deliver({ ...data, requestId: randomUUID() });
    await f.deliver(data, undefined, true);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backups.hasPendingRestore).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('installing');
  });

  it('rejects a link in place of an otherwise matching ownership receipt', async () => {
    const f = await fixture();
    const data = await f.publish();
    const receipt = f.receiptFile(data);
    const saved = `${receipt}.fixture`;
    await fs.rename(receipt, saved);
    await fs.symlink(saved, receipt);

    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, reply);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backups.hasPendingRestore).not.toHaveBeenCalled();
    expect((await fs.lstat(receipt)).isSymbolicLink()).toBe(true);
    expect(f.current()?.status).toBe('installing');
  });

  it('creates no receipt through an aliased state directory', async () => {
    const f = await fixture();
    const other = path.join(directory, 'other');
    await fs.mkdir(other);
    await fs.symlink(other, path.join(directory, 'state'));

    await expect(f.publish()).rejects.toThrow();

    expect(await fs.readdir(other)).toEqual([]);
    expect(f.current()).toBeUndefined();
    expect(f.repository.createApp).not.toHaveBeenCalled();
  });

  it('holds the URN before row insertion and never publishes after an ambiguous insert', async () => {
    const f = await fixture();
    f.repository.createApp.mockImplementationOnce(async () => {
      const held = installRequestDirectory(directory, appUrn);
      const [provisional] = await fs.readdir(held);
      expect(provisional).toBeDefined();
      if (!provisional) throw new Error('Missing provisional receipt');
      expect(await fs.stat(path.join(held, provisional))).toMatchObject({ size: 0, nlink: 1 });
      throw new Error('Database insert reply lost');
    });

    await expect(f.publish()).rejects.toThrow('Database insert reply lost');

    expect(await hasInstallRequestHold(directory, appUrn)).toBe(true);
    expect(f.repository.deleteInstallReservation).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    await expect(f.service.installApp({ appUrn, form: {} })).rejects.toThrow('still running or needs review');
  });

  it('serializes simultaneous deliveries and only the exact claim executes', async () => {
    const f = await fixture();
    const data = await f.publish();
    const entered = pending<void>();
    const release = pending<AppResult>();
    f.execute.mockImplementation(async () => {
      entered.settle();
      return release.promise;
    });
    const first = f.deliver(data);
    await entered.promise;
    const duplicate = vi.fn().mockResolvedValue(undefined);
    const second = f.deliver(data, duplicate);
    release.settle({ success: true, message: 'Installed' });
    await Promise.all([first, second]);

    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.repository.finishInstallReservation).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ success: true, alreadyCompleted: true }));
  });

  it('never deletes a changed row when a claimed operation tries to settle', async () => {
    const f = await fixture();
    const data = await f.publish();
    const replacement = createMockApp({ ...f.current(), createdAt: 1001 });
    f.execute.mockImplementation(async () => {
      f.replace(replacement);
      return { success: false, message: 'Invalid package', statePreserved: true };
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, reply);
    expect(f.current()).toBe(replacement);
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(true);
    expect(f.repository.deleteInstallReservation).toHaveBeenCalledWith(expect.objectContaining({ id: 42, createdAt: 1000 }));
    expect(reply).toHaveBeenCalledWith({ success: false, message: 'The app install outcome could not be recorded. Review the app before retrying.' });
  });

  it.each([true, false])('preserves the app row after failure only when work may have changed it, with unchanged=%s', async (statePreserved) => {
    const f = await fixture();
    const data = await f.publish();
    const result = { success: false, message: 'Install failed', statePreserved };
    f.execute.mockResolvedValue(result);
    await f.deliver(data, async (value) => f.rpc.settle(value));
    expect(f.current()?.status).toBe(statePreserved ? undefined : 'stopped');
    expect(f.repository.deleteInstallReservation).toHaveBeenCalledTimes(statePreserved ? 1 : 0);
    expect(f.repository.finishInstallReservation).toHaveBeenCalledTimes(statePreserved ? 0 : 1);
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(!statePreserved);
    expect((await f.tasks.read()).tasks[0]?.status).toBe('failed');
  });

  it('blocks start, restart, and reinstall after an uncertain install, including already queued starts', async () => {
    const f = await fixture();
    const data = await f.publish();
    f.execute.mockResolvedValueOnce({ success: false, message: 'Activation reply lost', statePreserved: false });
    await f.deliver(data);
    expect(f.current()?.status).toBe('stopped');

    await expect(f.service.startApp({ appUrn })).rejects.toThrow('still running or needs review');
    await expect(f.service.restartApp({ appUrn })).rejects.toThrow('still running or needs review');
    await expect(f.service.installApp({ appUrn, form: {} })).rejects.toThrow('still running or needs review');

    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver({ command: 'start', appUrn, form: {}, requestId: randomUUID() }, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('needs review') }));
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.current()?.status).toBe('stopped');

    await f.deliver({ command: 'stop', appUrn, form: {}, requestId: randomUUID() });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(true);
  });

  it('leaves a pending restore untouched and retains the app row for review', async () => {
    const f = await fixture();
    const data = await f.publish();
    f.backups.hasPendingRestore.mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('interrupted restore') }));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.backups.recoverRestore).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('stopped');
  });

  it('settles an atomically completed fresh install without attempting a second status update', async () => {
    const f = await fixture();
    const data = await f.publish();
    const row = f.current();
    if (!row) throw new Error('Missing reservation');
    const state = {
      id: randomUUID(),
      requestId: data.requestId,
      appUrn,
      phase: 'committing',
      context: {
        purpose: 'fresh-install',
        appId: row.id,
        appCreatedAt: row.createdAt,
        fromVersion: row.version,
        toVersion: row.version,
        previousLedger: { baselined: false, migrationIds: [] },
        targetMigrationIds: [],
        originalContainers: [],
        updateStatus: 'running',
        requestInputSha256: requestInputHash(data.form),
        authoritySha256: '1'.repeat(64),
      },
      prepared: { envSha256: '2'.repeat(64) },
      pulledImages: { imageIds: { web: 'sha256:' + '3'.repeat(64) } },
      freshInstall: { phase: 'baselined', imagePinsSha256: '4'.repeat(64) },
    };
    // SQL commit transport is modeled here; the file tests exercise the real stage and the SQL tests its actual transaction.
    const checkedStage = Object.assign(Object.create(AppUpdateStage.prototype), { verifyFreshInstall: async () => state });
    const result = await freshInstallResultBinding(checkedStage);
    f.repository.readFreshInstallCommit.mockImplementation(async (record) => record.operationSha256 === result.operationSha256);
    f.execute.mockImplementation(async () => {
      await retainFreshInstallResult(directory, result);
      f.replace({ ...row, status: 'running', migrationsBaselined: true });
      return { success: true, message: 'Installed' };
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(f.repository.finishInstallReservation).not.toHaveBeenCalled();
    expect(f.statusManager.emitEvent).toHaveBeenCalledWith({ appUrn, event: 'install_success', appStatus: 'running' });
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(false);
    expect((await f.tasks.read()).tasks[0]?.status).toBe('succeeded');
  });

  it('does not fall back to legacy settlement when a fresh result lacks its SQL acknowledgement', async () => {
    const f = await fixture();
    const data = await f.publish(true);
    const row = f.current();
    if (!row) throw new Error('Missing reservation');
    const state = {
      id: randomUUID(),
      requestId: data.requestId,
      appUrn,
      phase: 'committing',
      context: {
        purpose: 'fresh-install',
        appId: row.id,
        appCreatedAt: row.createdAt,
        fromVersion: row.version,
        toVersion: row.version,
        previousLedger: { baselined: false, migrationIds: [] },
        targetMigrationIds: [],
        originalContainers: [],
        updateStatus: 'stopped',
        requestInputSha256: requestInputHash(data.form),
        authoritySha256: '1'.repeat(64),
      },
      prepared: { envSha256: '2'.repeat(64) },
      pulledImages: { imageIds: { web: 'sha256:' + '3'.repeat(64) } },
      freshInstall: { phase: 'baselined', imagePinsSha256: '4'.repeat(64) },
    };
    const checkedStage = Object.assign(Object.create(AppUpdateStage.prototype), { verifyFreshInstall: async () => state });
    f.execute.mockImplementation(async () => {
      await retainFreshInstallResult(directory, await freshInstallResultBinding(checkedStage));
      return { success: true, message: 'Unconfirmed reply' };
    });
    f.repository.readFreshInstallCommit.mockResolvedValue(false);
    const reply = vi.fn().mockResolvedValue(undefined);
    await f.deliver(data, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(f.repository.finishInstallReservation).not.toHaveBeenCalled();
    expect(f.current()?.status).toBe('installing');
    expect(await hasInstallRequestHold(directory, appUrn)).toBe(true);
  });
});
