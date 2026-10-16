import { TranslatableError } from '@/common/error/translatable-error';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { fromAny } from '@total-typescript/shoehorn';
import type { AppStore } from '@/core/database/drizzle/types';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import type { AppUrn } from '@runtipi/common/types';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppValidationService } from '../services/app-validation.service';
import { StatusManagerService } from '../services/status-manager.service';
import { InstallAppHandler } from './install-app.handler';
import { StartAppHandler } from './start-app.handler';

const appUrn = 'rehearsal-app:orbis-qa' as AppUrn;

const createFixture = () => {
  const appRepository = mock<AppsRepository>();
  const appEventsQueue = mock<AppEventsQueue>();
  const statusManager = mock<StatusManagerService>();
  const validationService = mock<AppValidationService>();
  const marketplaceService = mock<MarketplaceService>();
  const startAppHandler = mock<StartAppHandler>();
  const appInfo = createMockAppInfo({ tipi_version: 1, port: 18991 });
  appRepository.getAppByUrn.mockResolvedValue(undefined);
  marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfo);
  appRepository.createApp.mockImplementation(async (row) => createMockApp({ ...row, id: 12 }));
  appEventsQueue.publish.mockResolvedValue({ success: true, message: 'installed' });
  const appStoreRepository = mock<AppStoreRepository>();
  appStoreRepository.getAppStoreBySlug.mockResolvedValue(fromAny({ slug: 'orbis-qa', enabled: true }));
  const mutex = new AsyncMutex();
  const handler = new InstallAppHandler(
    appRepository,
    appEventsQueue,
    statusManager,
    validationService,
    marketplaceService,
    startAppHandler,
    appStoreRepository,
    mutex,
  );
  return { handler, appRepository, appStoreRepository, appEventsQueue, statusManager, validationService, appInfo, mutex, startAppHandler };
};

describe('InstallAppHandler backup retention', () => {
  it.each([
    { label: 'global default', input: {}, expected: null },
    { label: 'disabled retention', input: { maxBackups: 0 }, expected: 0 },
    { label: 'per-app override', input: { maxBackups: 9 }, expected: 9 },
  ])('persists $label in the operational row as well as the form config', async ({ input, expected }) => {
    const fixture = createFixture();
    const form = { SERVICE_LABEL: 'preserved label', custom: { nested: ['keep', 7] }, ...input };

    const result = await fixture.handler.execute(appUrn, { form, skipRun: true });
    await vi.waitFor(() => expect(fixture.statusManager.emitSuccess).toHaveBeenCalledOnce());

    expect(fixture.appRepository.createApp).toHaveBeenCalledOnce();
    const row = fixture.appRepository.createApp.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      appName: 'rehearsal-app',
      appStoreSlug: 'orbis-qa',
      maxBackups: expected,
      config: form,
      status: 'installing',
    });
    expect(fixture.validationService.validateInstallSettings).toHaveBeenCalledExactlyOnceWith(appUrn, fixture.appInfo, row?.config);
    expect(fixture.validationService.validateInstallSettings.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.appRepository.createApp.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.appEventsQueue.publish).toHaveBeenCalledExactlyOnceWith({
      appUrn,
      command: 'install',
      requestId: result.requestId,
      form: { ...row?.config, skipRun: true },
    });
    expect(fixture.statusManager.emitSuccess).toHaveBeenCalledExactlyOnceWith({
      appId: 12,
      appUrn,
      event: 'install_success',
      status: 'stopped',
    });
  });

  it.each([null, -1, 101])('rejects invalid retention %s before creating or queuing an app', async (maxBackups) => {
    const fixture = createFixture();

    const error = await fixture.handler.execute(appUrn, { form: { maxBackups } }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getStatus()).toBe(400);
    expect((error as TranslatableError).getResponse()).toEqual({ message: 'SYSTEM_ERROR_INVALID_BODY', intlParams: undefined });
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(fixture.validationService.validateInstallSettings).not.toHaveBeenCalled();
  });

  it('preserves install-settings validation before storing a valid retention override', async () => {
    const fixture = createFixture();
    const failure = new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, 400);
    fixture.validationService.validateInstallSettings.mockRejectedValue(failure);

    await expect(fixture.handler.execute(appUrn, { form: { maxBackups: 9 } })).rejects.toBe(failure);

    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
  });

  const createStoreFixture = () => {
    const fixture = createFixture();
    const repos = mock<ReposHelpers>();
    let stores: AppStore[] = [fromAny({ slug: 'orbis-qa', enabled: true }), fromAny({ slug: 'other', enabled: true })];
    fixture.appStoreRepository.getAllAppStores.mockImplementation(async () => [...stores]);
    fixture.appStoreRepository.getAppStoreBySlug.mockImplementation(async (slug) => stores.find((store) => store.slug === slug));
    fixture.appStoreRepository.removeAppStoreEntity.mockImplementation(async (slug) => {
      stores = stores.filter((store) => store.slug !== slug);
      return fromAny(undefined);
    });
    fixture.appStoreRepository.getAppCountForStore.mockResolvedValue({ count: 0 });
    repos.deleteRepo.mockResolvedValue({ success: true, message: '' });
    const storeService = new AppStoreService(
      mock<LoggerService>(),
      mock<RepoEventsQueue>(),
      repos,
      mock<ConfigurationService>(),
      fixture.appStoreRepository,
      fixture.mutex,
    );
    return { ...fixture, storeService, repos };
  };

  it('finishes reserving an app before a concurrent store deletion can inspect it', async () => {
    const fixture = createStoreFixture();
    let releaseValidation: () => void = () => undefined;
    const validating = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    fixture.validationService.validateInstallSettings.mockImplementation(async () => validating);
    fixture.appRepository.createApp.mockImplementation(async (row) => {
      fixture.appStoreRepository.getAppCountForStore.mockResolvedValue({ count: 1 });
      return createMockApp({ ...row, id: 12 });
    });
    const installation = fixture.handler.execute(appUrn, { form: {}, skipRun: true });
    await vi.waitFor(() => expect(fixture.validationService.validateInstallSettings).toHaveBeenCalledOnce());
    const deletion = fixture.storeService.deleteAppStore('orbis-qa').catch((error: unknown) => error);
    expect(fixture.appStoreRepository.getAppCountForStore).not.toHaveBeenCalled();
    releaseValidation();
    await installation;
    const failure = await deletion;

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getResponse()).toEqual({ message: 'APP_STORE_DELETE_ERROR_APPS_EXIST', intlParams: {} });
    expect(fixture.repos.deleteRepo).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).toHaveBeenCalledOnce();
    expect(fixture.mutex.resourceLocks.size).toBe(0);
  });

  it('rejects an install whose store was removed while it waited, without creating an orphan app', async () => {
    const fixture = createStoreFixture();
    let releaseRemoval: () => void = () => undefined;
    const removing = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    fixture.repos.deleteRepo.mockImplementation(async () => {
      await removing;
      return { success: true, message: '' };
    });
    const deletion = fixture.storeService.deleteAppStore('orbis-qa');
    await vi.waitFor(() => expect(fixture.repos.deleteRepo).toHaveBeenCalledOnce());
    const installation = fixture.handler.execute(appUrn, { form: {}, skipRun: true }).catch((error: unknown) => error);
    releaseRemoval();
    await deletion;
    const failure = await installation;

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getStatus()).toBe(404);
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(fixture.mutex.resourceLocks.size).toBe(0);
  });

  it('releases the store lock before restarting an existing installed app', async () => {
    const fixture = createFixture();
    fixture.appRepository.getAppByUrn.mockResolvedValue(createMockApp());
    fixture.startAppHandler.execute.mockImplementation(async () => {
      expect(fixture.mutex.resourceLocks.size).toBe(0);
      return { requestId: 'existing-app' };
    });

    expect(await fixture.handler.execute(appUrn, { form: {} })).toEqual({ requestId: 'existing-app' });
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
  });
});
