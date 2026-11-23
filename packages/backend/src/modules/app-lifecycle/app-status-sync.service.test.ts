import { beforeEach, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type Dockerode from 'dockerode';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { AppStatusSyncService } from './app-status-sync.service';
import { AppJobService } from './services/app-job.service';

const appUrn = 'fixture:store' as const;
const repository = mock<AppsRepository>();
const docker = mock<Dockerode>();
const config = mock<ConfigurationService>();
const jobs = mock<AppJobService>();
const events = mock<SSEService>();
let app: ReturnType<typeof createMockApp>;
let mutex: AsyncMutex;
let service: AppStatusSyncService;
beforeEach(() => {
  repository.getApps.mockReset();
  repository.getAppByUrn.mockReset();
  repository.updateAppById.mockReset();
  repository.finishInstallReservation.mockReset();
  docker.listContainers.mockReset();
  jobs.hasUnsettledJob.mockReset();
  events.emit.mockReset();
  app = createMockApp({ id: 7, appName: 'fixture', appStoreSlug: 'store', status: 'updating', updatedAt: 0 });
  repository.getApps.mockResolvedValue([app]);
  repository.getAppByUrn.mockImplementation(async () => app);
  repository.updateAppById.mockImplementation(async (_id, update) => ({ ...app, ...update }));
  repository.finishInstallReservation.mockResolvedValue(true);
  docker.listContainers.mockResolvedValue([]);
  config.get.calledWith('userSettings').mockReturnValue({ eventsTimeout: 5 } as never);
  jobs.hasUnsettledJob.mockResolvedValue(false);
  mutex = new AsyncMutex();
  service = new AppStatusSyncService(mock<LoggerService>(), repository, events, mock<SystemEventsQueue>(), config, docker, mutex, jobs);
});

it.each(['updating', 'backing_up', 'restoring', 'installing', 'stopping'] as const)(
  'does not overwrite %s while its lifecycle lock is held',
  async (status) => {
    app.status = status;
    const release = await mutex.acquire(appUrn);
    try {
      expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
      expect(repository.updateAppById).not.toHaveBeenCalled();
      expect(repository.finishInstallReservation).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);

it('keeps a queued or interrupted durable operation unchanged after the live lock is gone', async () => {
  jobs.hasUnsettledJob.mockResolvedValue(true);
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(events.emit).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('holds the lifecycle lock throughout durable-state checking and the status write', async () => {
  jobs.hasUnsettledJob.mockImplementation(async () => {
    expect(mutex.resourceLocks.has(appUrn)).toBe(true);
    return false;
  });
  repository.updateAppById.mockImplementation(async () => {
    expect(mutex.resourceLocks.has(appUrn)).toBe(true);
    return { ...app, status: 'stopped' };
  });
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 1, skippedCount: 0 });
  expect(repository.updateAppById).toHaveBeenCalledWith(7, { status: 'stopped' });
  expect(events.emit).toHaveBeenCalledWith('app', { event: 'status_change', appUrn, appStatus: 'stopped' });
  expect(mutex.resourceLocks.size).toBe(0);
});

it.each(['id', 'createdAt', 'version', 'status', 'updatedAt'] as const)(
  'does not apply an old Docker observation after the app %s changes',
  async (field) => {
    const replacement = { ...app, [field]: field === 'status' ? 'running' : Number(app[field]) + 1 };
    repository.getAppByUrn.mockResolvedValue(replacement as typeof app);
    expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
    expect(repository.updateAppById).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(mutex.resourceLocks.size).toBe(0);
  },
);

it('does not recreate a deleted app from an old Docker observation', async () => {
  repository.getAppByUrn.mockResolvedValue(undefined);
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('preserves status and releases the lock when durable operation evidence cannot be read', async () => {
  jobs.hasUnsettledJob.mockRejectedValue(new Error('Unavailable operation record'));
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: false, syncedCount: 0 });
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(events.emit).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('keeps recent transitions while reconciling an expired transition after its job settles', async () => {
  app.updatedAt = Math.floor(Date.now() / 1000);
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 0, skippedCount: 1 });
  app.updatedAt = 0;
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 1, skippedCount: 0 });
});

it('retains receipt-backed completion for an idle install reservation', async () => {
  app.status = 'installing';
  expect(await service.syncAllAppStatuses()).toMatchObject({ success: true, syncedCount: 1, skippedCount: 0 });
  expect(repository.finishInstallReservation).toHaveBeenCalledWith(app, 'stopped');
  expect(repository.updateAppById).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});
