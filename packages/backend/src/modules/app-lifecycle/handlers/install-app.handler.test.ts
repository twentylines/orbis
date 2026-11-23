import { AppJobService } from '../services/app-job.service';
import { verifyInstallRequestOwnership } from '../install-request-receipt';
import { TranslatableError } from '@/common/error/translatable-error';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { appStoreLockKey } from '@/modules/app-stores/app-store-lock';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppValidationService } from '../services/app-validation.service';
import { StatusManagerService } from '../services/status-manager.service';
import { InstallAppHandler } from './install-app.handler';
import { StartAppHandler } from './start-app.handler';

const appUrn = 'rehearsal-app:orbis-qa' as AppUrn;
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-install-handler-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

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
  const config = mock<ConfigurationService>();
  config.get.calledWith('directories').mockReturnValue(fromAny({ dataDir: directory }));
  const jobs = mock<AppJobService>();
  jobs.hasUnsettledJob.mockResolvedValue(false);
  const handler = new InstallAppHandler(
    appRepository,
    appEventsQueue,
    statusManager,
    validationService,
    marketplaceService,
    startAppHandler,
    appStoreRepository,
    mutex,
    config,
    mock<LoggerService>(),
    jobs,
  );
  return { jobs, handler, appRepository, appStoreRepository, appEventsQueue, statusManager, validationService, appInfo, mutex, startAppHandler };
};

describe('InstallAppHandler backup retention', () => {
  it('rejects a new-only install without changing or starting the existing app', async () => {
    const fixture = createFixture();
    const existing = createMockApp({ id: 19, config: { SECRET: 'saved' }, port: 18992 });
    fixture.appRepository.getAppByUrn.mockResolvedValue(existing);

    await expect(fixture.handler.execute(appUrn, { form: { port: 18993 }, requireNew: true })).rejects.toThrow('already installed');

    expect(fixture.appRepository.updateAppById).not.toHaveBeenCalled();
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(existing.config).toEqual({ SECRET: 'saved' });
  });

  it('serializes competing new-only installs so only one can reserve the app', async () => {
    const fixture = createFixture();
    let installed: ReturnType<typeof createMockApp> | undefined;
    fixture.appRepository.getAppByUrn.mockImplementation(async () => installed);
    fixture.appRepository.createApp.mockImplementation(async (row) => {
      installed = createMockApp({ ...row, id: 19 });
      return installed;
    });
    const results = await Promise.allSettled([
      fixture.handler.execute(appUrn, { form: { port: 18993 }, requireNew: true }),
      fixture.handler.execute(appUrn, { form: { port: 18994 }, requireNew: true }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(fixture.appRepository.createApp).toHaveBeenCalledOnce();
    expect(fixture.appEventsQueue.publish).toHaveBeenCalledOnce();
    expect(fixture.appRepository.updateAppById).not.toHaveBeenCalled();
    expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
    expect(installed?.port).toBe(18993);
  });

  it.each([
    { label: 'global default', input: {}, expected: null },
    { label: 'disabled retention', input: { maxBackups: 0 }, expected: 0 },
    { label: 'per-app override', input: { maxBackups: 9 }, expected: 9 },
  ])('persists $label in the operational row as well as the form config', async ({ input, expected }) => {
    const fixture = createFixture();
    const form = { SERVICE_LABEL: 'preserved label', custom: { nested: ['keep', 7] }, ...input };

    const result = await fixture.handler.execute(appUrn, { form, skipRun: true });
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
    expect(fixture.statusManager.emitSuccess).not.toHaveBeenCalled();
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
      expect(fixture.mutex.resourceLocks.has(appStoreLockKey('orbis-qa'))).toBe(false);
      return { requestId: 'existing-app' };
    });

    expect(await fixture.handler.execute(appUrn, { form: {} })).toEqual({ requestId: 'existing-app' });
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
  });

  it('does not apply custom form values to the installed app identity, status, or migration history', async () => {
    const fixture = createFixture();
    fixture.appRepository.getAppByUrn.mockResolvedValue(createMockApp({ id: 19 }));
    const form = { id: 12, status: 'installing', migrationsBaselined: true, port: 18992 };

    await fixture.handler.execute(appUrn, { form });

    const change = fixture.appRepository.updateAppById.mock.calls[0]?.[1];
    expect(change).toMatchObject({ config: form, port: 18992 });
    expect(change).not.toHaveProperty('id');
    expect(change).not.toHaveProperty('status');
    expect(change).not.toHaveProperty('migrationsBaselined');
  });

  it('does not change or start an in-progress reservation as an existing app', async () => {
    const fixture = createFixture();
    fixture.appRepository.getAppByUrn.mockResolvedValue(createMockApp({ id: 19, status: 'installing' }));

    await expect(fixture.handler.execute(appUrn, { form: {} })).rejects.toThrow('current app install');

    expect(fixture.appRepository.updateAppById).not.toHaveBeenCalled();
    expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
  });
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

it('carries the exact row/version claim through worker ownership and expires it after settlement', async () => {
  const fixture = createFixture();
  fixture.appRepository.finishInstallReservation.mockResolvedValue(true);
  const accepted = await fixture.handler.execute(appUrn, { form: { port: 18993 } });
  if (!accepted.requestId) throw new Error('Missing request');
  const app = await fixture.appRepository.createApp.mock.results[0]?.value;
  if (!app) throw new Error('Missing reservation');
  fixture.appRepository.getAppByUrn.mockResolvedValue(app);
  const claimed = await fixture.handler.claim(appUrn, accepted.requestId, false);
  if (!claimed) throw new Error('Missing owned install');
  expect(await verifyInstallRequestOwnership(claimed.ownership, appUrn, accepted.requestId)).toEqual({
    id: app.id,
    createdAt: app.createdAt,
    appName: app.appName,
    appStoreSlug: app.appStoreSlug,
    version: app.version,
  });
  await claimed.settle({ success: true, message: 'Installed' });
  await expect(verifyInstallRequestOwnership(claimed.ownership, appUrn, accepted.requestId)).rejects.toThrow();
});
it('refuses to claim a reserved install if its version changed before worker admission', async () => {
  const fixture = createFixture();
  const accepted = await fixture.handler.execute(appUrn, { form: { port: 18993 } });
  if (!accepted.requestId) throw new Error('Missing request');
  const app = await fixture.appRepository.createApp.mock.results[0]?.value;
  if (!app) throw new Error('Missing reservation');
  fixture.appRepository.getAppByUrn.mockResolvedValue({ ...app, version: app.version + 1 });
  expect(await fixture.handler.claim(appUrn, accepted.requestId, false)).toBeUndefined();
  expect(fixture.appRepository.finishInstallReservation).not.toHaveBeenCalled();
});

it.each(['pending', 'admitted-while-waiting'] as const)('preserves existing app settings when another operation is %s', async (state) => {
  const f = createFixture();
  f.appRepository.getAppByUrn.mockResolvedValue(createMockApp({ id: 19, status: 'updating', config: { VALUE: 'saved' } }));
  if (state === 'pending') f.jobs.hasUnsettledJob.mockResolvedValue(true);
  else f.jobs.hasUnsettledJob.mockResolvedValueOnce(false).mockResolvedValue(true);
  await expect(f.handler.execute(appUrn, { form: { VALUE: 'must-not-save' } })).rejects.toThrow('unfinished app operation');
  expect(f.appRepository.updateAppById).not.toHaveBeenCalled();
  expect(f.appRepository.createApp).not.toHaveBeenCalled();
  expect(f.appEventsQueue.publish).not.toHaveBeenCalled();
  expect(f.startAppHandler.execute).not.toHaveBeenCalled();
  expect(f.mutex.resourceLocks.size).toBe(0);
});

it('installs a saved custom draft through the queue without creating another row or starting it', async () => {
  const fixture = createFixture();
  const customUrn = 'draft:_user' as AppUrn;
  const draft = createMockApp({ id: 19, createdAt: 1000, appName: 'draft', appStoreSlug: '_user', status: 'missing' });
  fixture.appRepository.getAppByUrn.mockResolvedValue(draft);
  fixture.appRepository.reserveCustomDraft.mockResolvedValue({ ...draft, status: 'installing' });
  await fixture.handler.execute(customUrn, { form: { maxBackups: 9 } });
  expect(fixture.startAppHandler.execute).not.toHaveBeenCalled();
  expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
  expect(fixture.appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ appUrn: customUrn, command: 'install' }));
});

const savedDraftFixture = () => {
  const f = createFixture();
  const urn = 'draft:_user' as AppUrn;
  let row = createMockApp({ id: 19, createdAt: 1000, appName: 'draft', appStoreSlug: '_user', status: 'missing' });
  f.appRepository.getAppByUrn.mockImplementation(async () => row);
  f.appRepository.reserveCustomDraft.mockImplementation(async (_reservation, data) => {
    row = { ...row, ...data, status: 'installing' };
    return row;
  });
  f.appRepository.deleteInstallReservation.mockImplementation(async (reservation) => {
    expect(reservation).toMatchObject({ id: 19, createdAt: 1000, preserveExisting: true });
    row = { ...row, status: 'missing' };
    return true;
  });
  return { ...f, urn, row: () => row };
};

it('retains draft identity and accepted settings when the queue refuses delivery', async () => {
  const f = savedDraftFixture();
  f.appEventsQueue.publish.mockRejectedValue(new Error('Queue unavailable'));
  await f.handler.execute(f.urn, { form: { maxBackups: 9 } });
  await vi.waitFor(() => expect(f.appRepository.deleteInstallReservation).toHaveBeenCalledOnce());
  expect(f.row()).toMatchObject({ id: 19, createdAt: 1000, status: 'missing', config: { maxBackups: 9 } });
  await expect(f.handler.requireNoInstallHold(f.urn)).resolves.toBeUndefined();
  expect(f.startAppHandler.execute).not.toHaveBeenCalled();
});

it.each([true, false])('preserves the draft origin through worker ownership and settlement: statePreserved %s', async (statePreserved) => {
  const f = savedDraftFixture();
  f.appRepository.finishInstallReservation.mockResolvedValue(true);
  const accepted = await f.handler.execute(f.urn, { form: { maxBackups: 9 }, skipRun: true });
  const claimed = await f.handler.claim(f.urn, accepted.requestId, true);
  expect(claimed).toBeDefined();
  if (!claimed) throw new Error('Missing draft ownership');
  expect(await verifyInstallRequestOwnership(claimed.ownership, f.urn, accepted.requestId)).toMatchObject({ id: 19, preserveExisting: true });
  await claimed.settle({ success: false, statePreserved, message: 'Installation refused' });
  if (statePreserved) {
    expect(f.appRepository.deleteInstallReservation).toHaveBeenCalledOnce();
    expect(f.row().status).toBe('missing');
    await expect(f.handler.requireNoInstallHold(f.urn)).resolves.toBeUndefined();
  } else {
    expect(f.appRepository.deleteInstallReservation).not.toHaveBeenCalled();
    expect(f.appRepository.finishInstallReservation).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true }), 'stopped');
    await expect(f.handler.requireNoInstallHold(f.urn)).rejects.toThrow('needs review');
  }
});

it('validates a custom draft before reserving it and excludes only its own operational row', async () => {
  const f = savedDraftFixture();
  f.validationService.validateInstallSettings.mockRejectedValue(new Error('Another app uses this port'));
  await expect(f.handler.execute(f.urn, { form: { openPort: true, port: 18993 } })).rejects.toThrow('Another app');
  expect(f.validationService.validateInstallSettings).toHaveBeenCalledWith(
    f.urn,
    f.appInfo,
    expect.objectContaining({ openPort: true, port: 18993 }),
    19,
  );
  expect(f.appRepository.reserveCustomDraft).not.toHaveBeenCalled();
  expect(f.appEventsQueue.publish).not.toHaveBeenCalled();
  expect(f.row().status).toBe('missing');
  await expect(f.handler.requireNoInstallHold(f.urn)).resolves.toBeUndefined();
});

it('preserves a provisional hold if the draft reservation reply is lost', async () => {
  const f = savedDraftFixture();
  f.appRepository.reserveCustomDraft.mockResolvedValue(undefined);
  await expect(f.handler.execute(f.urn, { form: {} })).rejects.toThrow('custom app changed');
  expect(f.appEventsQueue.publish).not.toHaveBeenCalled();
  expect(f.startAppHandler.execute).not.toHaveBeenCalled();
  await expect(f.handler.requireNoInstallHold(f.urn)).rejects.toThrow('needs review');
});

it('does not reinstall an existing migrated custom app as an uninstalled draft', async () => {
  const f = savedDraftFixture();
  f.appRepository.getAppByUrn.mockResolvedValue({ ...f.row(), migrationsBaselined: true });
  await expect(f.handler.execute(f.urn, { form: {} })).rejects.toThrow('existing app storage');
  expect(f.appRepository.reserveCustomDraft).not.toHaveBeenCalled();
  expect(f.appEventsQueue.publish).not.toHaveBeenCalled();
  expect(f.startAppHandler.execute).not.toHaveBeenCalled();
});

it('checks other apps for conflicts while allowing a draft to retain its own port and domain', async () => {
  const f = savedDraftFixture();
  const config = mock<ConfigurationService>();
  config.getConfig.mockReturnValue(fromAny({ architecture: 'arm64', version: '4.12.0', demoMode: false }));
  f.appRepository.getApps.mockResolvedValue([f.row()]);
  f.appRepository.getAppsByDomain.mockResolvedValue([]);
  f.appRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
  f.appRepository.getAppsByPort.mockResolvedValue([]);
  const validation = new AppValidationService(f.appRepository, config, mock<LoggerService>());
  const info = createMockAppInfo({ supported_architectures: ['arm64'], exposable: true, force_expose: false, min_tipi_version: undefined });
  const form = {
    exposed: true,
    domain: 'draft.example.com',
    exposedLocal: true,
    localSubdomain: 'draft',
    openPort: true,
    port: 18993,
    skipRun: false,
    skipPull: false,
    skipEnv: false,
  };
  await validation.validateInstallSettings(f.urn, info, form, 19);
  expect(f.appRepository.getAppsByDomain).toHaveBeenCalledWith(form.domain, 19);
  expect(f.appRepository.getAppsByLocalSubdomain).toHaveBeenCalledWith('draft', 19);
  expect(f.appRepository.getAppsByPort).toHaveBeenCalledWith(18993, 19);
  f.appRepository.getAppsByPort.mockResolvedValue([createMockApp({ id: 20 })]);
  await expect(validation.validateInstallSettings(f.urn, info, form, 19)).rejects.toBeInstanceOf(TranslatableError);
});
