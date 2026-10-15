import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { type AppEvent, AppEventsQueue } from '@/modules/queue/entities/app-events';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { Test } from '@nestjs/testing';
import type { AppUrn } from '@runtipi/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { StatusManagerService } from '../services/status-manager.service';
import { StartAppHandler } from './start-app.handler';
import { UpdateAppHandler } from './update-app.handler';
import { UpdateConfigHandler } from './update-config.handler';

const appUrn = 'rehearsal-app:orbis-qa' as AppUrn;

const createFixture = async (maxBackups: number | null, status: 'running' | 'stopped' = 'stopped') => {
  const rawConfig = {
    SERVICE_LABEL: 'preserved label',
    maxBackups: 3,
    custom: { nested: ['keep', 7], nullable: null },
  };
  const original = createMockApp({
    id: 12,
    appName: 'rehearsal-app',
    appStoreSlug: 'orbis-qa',
    status,
    config: rawConfig,
    maxBackups,
    port: 18991,
    openPort: false,
    exposed: true,
    exposedLocal: true,
    domain: 'app.example.test',
    localSubdomain: 'preserved',
    enableAuth: true,
    isVisibleOnGuestDashboard: true,
    userConfigEnabled: true,
    pendingRestart: true,
    subnet: '10.10.4.0/24',
    ignoredVersion: 6,
    templateUrn: appUrn,
    templateVersion: 1,
    lastTemplateSyncAt: 123,
  });
  let stored = structuredClone(original);
  const appRepository = mock<AppsRepository>();
  const appEventsQueue = mock<AppEventsQueue>();
  const statusManager = mock<StatusManagerService>();
  const config = mock<ConfigurationService>();
  const marketplaceService = mock<MarketplaceService>();
  const appFilesManager = mock<AppFilesManager>();
  const startAppHandler = mock<StartAppHandler>();
  const updateConfigHandler = mock<UpdateConfigHandler>();
  const logger = mock<LoggerService>();
  appRepository.getAppByUrn.mockResolvedValue(original);
  appRepository.updateAppById.mockImplementation(async (_id, patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  statusManager.transitionTo.mockImplementation(async (id, _urn, nextStatus) => {
    await appRepository.updateAppById(id, { status: nextStatus });
  });
  config.get.calledWith('version').mockReturnValue('4.0.0');
  marketplaceService.getAppUpdateInfo.mockResolvedValue(fromPartial({ minTipiVersion: '3.0.0' }));
  appFilesManager.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ tipi_version: 2 }));
  appEventsQueue.publish.mockResolvedValue({ success: true, message: 'updated' });
  const moduleRef = await Test.createTestingModule({
    providers: [
      UpdateAppHandler,
      { provide: LoggerService, useValue: logger },
      { provide: AppsRepository, useValue: appRepository },
      { provide: AppEventsQueue, useValue: appEventsQueue },
      { provide: StatusManagerService, useValue: statusManager },
      { provide: ConfigurationService, useValue: config },
      { provide: MarketplaceService, useValue: marketplaceService },
      { provide: AppFilesManager, useValue: appFilesManager },
      { provide: StartAppHandler, useValue: startAppHandler },
      { provide: UpdateConfigHandler, useValue: updateConfigHandler },
    ],
  }).compile();
  return {
    handler: moduleRef.get(UpdateAppHandler),
    original,
    rawConfig,
    getStored: () => stored,
    appRepository,
    appEventsQueue,
    statusManager,
    config,
    marketplaceService,
    startAppHandler,
    updateConfigHandler,
  };
};

describe('UpdateAppHandler settings preservation', () => {
  it.each([null, 0, 9])('keeps raw config and operational settings when stored retention is %s', async (maxBackups) => {
    const fixture = await createFixture(maxBackups);

    const result = await fixture.handler.execute(appUrn, { performBackup: true });
    await vi.waitFor(() => expect(fixture.getStored().status).toBe('stopped'));

    expect(fixture.appEventsQueue.publish).toHaveBeenCalledExactlyOnceWith({
      command: 'update',
      appUrn,
      requestId: result.requestId,
      form: fixture.rawConfig,
      performBackup: true,
    });
    const event = fixture.appEventsQueue.publish.mock.calls[0]?.[0] as AppEvent | undefined;
    expect(event?.form).toBe(fixture.rawConfig);
    expect(fixture.updateConfigHandler.execute).not.toHaveBeenCalled();
    expect(fixture.appRepository.updateAppById.mock.calls).toEqual([
      [12, { status: 'updating' }],
      [12, { version: 2 }],
      [12, { status: 'stopped' }],
    ]);
    expect(fixture.getStored()).toEqual({ ...fixture.original, version: 2 });
    expect(fixture.getStored().config).toEqual(fixture.rawConfig);
    expect(fixture.statusManager.emitEvent).toHaveBeenCalledExactlyOnceWith({ appUrn, event: 'update_success' });
    expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
  });

  it('restarts a previously running app after recording the version without rewriting its settings', async () => {
    const fixture = await createFixture(null, 'running');
    fixture.startAppHandler.execute.mockImplementation(async () => {
      expect(fixture.getStored().version).toBe(2);
      return { requestId: 'start-request' };
    });

    await fixture.handler.execute(appUrn);
    await vi.waitFor(() => expect(fixture.startAppHandler.execute).toHaveBeenCalledExactlyOnceWith(appUrn));

    expect(fixture.updateConfigHandler.execute).not.toHaveBeenCalled();
    expect(fixture.getStored()).toEqual({ ...fixture.original, version: 2, status: 'updating' });
    expect(fixture.appRepository.updateAppById.mock.calls).toEqual([
      [12, { status: 'updating' }],
      [12, { version: 2 }],
    ]);
    expect(fixture.appEventsQueue.publish.mock.calls[0]?.[0]).toMatchObject({ performBackup: false });
  });

  it('keeps the stored version and settings and reports failure when post-copy environment generation fails', async () => {
    const fixture = await createFixture(9, 'running');
    fixture.appEventsQueue.publish.mockResolvedValue({ success: false, message: 'NEW_REQUIRED must be configured' });

    await fixture.handler.execute(appUrn, { performBackup: true });
    await vi.waitFor(() => expect(fixture.getStored().status).toBe('stopped'));

    expect(fixture.getStored()).toEqual({ ...fixture.original, status: 'stopped' });
    expect(fixture.updateConfigHandler.execute).not.toHaveBeenCalled();
    expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
    expect(fixture.statusManager.emitEvent).toHaveBeenCalledExactlyOnceWith({
      appUrn,
      event: 'update_error',
      error: 'NEW_REQUIRED must be configured',
    });
    expect(fixture.appRepository.updateAppById.mock.calls).toEqual([
      [12, { status: 'updating' }],
      [12, { status: 'stopped' }],
    ]);
  });

  it('rejects an unknown app before queuing or changing any status', async () => {
    const fixture = await createFixture(null);
    fixture.appRepository.getAppByUrn.mockResolvedValue(undefined);

    const error = await fixture.handler.execute(appUrn).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getStatus()).toBe(404);
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(fixture.statusManager.transitionTo).not.toHaveBeenCalled();
  });

  it('preserves the minimum core version gate before queueing the update', async () => {
    const fixture = await createFixture(null);
    fixture.marketplaceService.getAppUpdateInfo.mockResolvedValue(fromPartial({ minTipiVersion: '5.0.0' }));

    const error = await fixture.handler.execute(appUrn).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getResponse()).toEqual({
      message: 'APP_UPDATE_ERROR_MIN_TIPI_VERSION',
      intlParams: { id: appUrn, minVersion: '5.0.0' },
    });
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(fixture.statusManager.transitionTo).not.toHaveBeenCalled();
  });
});
