import fs from 'node:fs';
import path from 'node:path';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { AppStore } from '@/core/database/drizzle/types';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { MarketplaceController } from '@/modules/marketplace/marketplace.controller';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { fromAny } from '@total-typescript/shoehorn';

describe('AppStoreService', () => {
  let appStoreService: AppStoreService;
  let appStoreRepository: MockProxy<AppStoreRepository>;
  let repoHelpers: MockProxy<ReposHelpers>;
  let repoQueue: MockProxy<RepoEventsQueue>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [AppStoreService],
    })
      .useMocker(mock)
      .compile();

    appStoreService = moduleRef.get(AppStoreService);
    appStoreRepository = moduleRef.get(AppStoreRepository);
    repoHelpers = moduleRef.get(ReposHelpers);
    moduleRef.get(LoggerService);
    repoQueue = moduleRef.get(RepoEventsQueue);
    moduleRef.get(ConfigurationService);
  });

  it('rejects deleting an unknown app store slug before removing any repo', async () => {
    appStoreRepository.getAllAppStores.mockResolvedValue([
      fromAny({ slug: 'primary', url: 'https://example.com/primary.git', hash: 'primary', name: 'Primary', enabled: true }),
      fromAny({ slug: 'secondary', url: 'https://example.com/secondary.git', hash: 'secondary', name: 'Secondary', enabled: true }),
    ]);

    await expect(appStoreService.deleteAppStore('..')).rejects.toBeInstanceOf(NotFoundException);

    expect(appStoreRepository.removeAppStoreEntity).not.toHaveBeenCalled();
    expect(repoHelpers.deleteRepo).not.toHaveBeenCalled();
  });

  it('rejects creating an app store when slugify produces an unsafe slug', async () => {
    repoHelpers.getRepoHash.mockReturnValue('hash');
    appStoreRepository.getAppStoreByHash.mockResolvedValue(undefined);

    await expect(appStoreService.createAppStore({ name: '..', url: 'https://example.com/store.git' })).rejects.toBeInstanceOf(BadRequestException);

    expect(appStoreRepository.getAppStoreBySlug).not.toHaveBeenCalled();
    expect(appStoreRepository.createAppStore).not.toHaveBeenCalled();
    expect(repoHelpers.cloneRepo).not.toHaveBeenCalled();
  });

  const stores: AppStore[] = [
    fromAny({ slug: 'primary', name: 'Primary', url: 'https://example.com/primary.git', enabled: true }),
    fromAny({ slug: 'offline', name: 'Offline', url: 'https://example.com/offline.git', enabled: true }),
    fromAny({ slug: 'backup', name: 'Backup', url: 'https://example.com/backup.git', enabled: true }),
  ];

  it('refreshes only the re-enabled store once before changing its database row', async () => {
    const current = { ...stores[0], enabled: false } as AppStore;
    const body = { name: 'Renamed', enabled: true };
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(current);
    appStoreRepository.updateAppStore.mockResolvedValue({ ...current, ...body });
    repoHelpers.pullRepo.mockImplementation(async () => {
      expect(appStoreRepository.updateAppStore).not.toHaveBeenCalled();
      return { success: true, message: '' };
    });

    expect(await appStoreService.updateAppStore(current.slug, body)).toMatchObject({ name: 'Renamed', enabled: true });

    expect(repoHelpers.pullRepo).toHaveBeenCalledExactlyOnceWith(current.url, current.slug);
    expect(appStoreRepository.updateAppStore).toHaveBeenCalledExactlyOnceWith(current.slug, body);
    expect(appStoreRepository.getEnabledAppStores).not.toHaveBeenCalled();
    expect(repoHelpers.cloneRepo).not.toHaveBeenCalled();
  });

  it('leaves a store disabled when its selective refresh fails', async () => {
    const current = { ...stores[0], enabled: false } as AppStore;
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(current);
    repoHelpers.pullRepo.mockResolvedValue({ success: false, message: 'private Git transport error' });

    const failure = await appStoreService.updateAppStore(current.slug, { name: 'Renamed', enabled: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getStatus()).toBe(502);
    expect((failure as TranslatableError).getResponse()).toEqual({ message: 'APP_STORE_REFRESH_ERROR', intlParams: { stores: current.name } });
    expect(repoHelpers.pullRepo).toHaveBeenCalledExactlyOnceWith(current.url, current.slug);
    expect(appStoreRepository.updateAppStore).not.toHaveBeenCalled();
    expect(current.enabled).toBe(false);
  });

  it.each([true, false])('renames an enabled=%s store without refreshing its repository', async (enabled) => {
    const current = { ...stores[0], enabled } as AppStore;
    const body = { name: 'Renamed', enabled };
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(current);
    appStoreRepository.updateAppStore.mockResolvedValue({ ...current, ...body });

    await appStoreService.updateAppStore(current.slug, body);

    expect(appStoreRepository.updateAppStore).toHaveBeenCalledExactlyOnceWith(current.slug, body);
    expect(repoHelpers.pullRepo).not.toHaveBeenCalled();
    expect(repoHelpers.cloneRepo).not.toHaveBeenCalled();
  });

  it('disables an enabled store without requiring its Git server', async () => {
    const current = stores[0] as AppStore;
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(current);

    await appStoreService.updateAppStore(current.slug, { name: current.name, enabled: false });

    expect(appStoreRepository.updateAppStore).toHaveBeenCalledExactlyOnceWith(current.slug, { name: current.name, enabled: false });
    expect(repoHelpers.pullRepo).not.toHaveBeenCalled();
  });

  it('rejects editing an unknown slug before refreshing or changing any store', async () => {
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(undefined);

    const failure = await appStoreService.updateAppStore('missing', { name: 'Renamed', enabled: true }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundException);
    expect((failure as NotFoundException).getStatus()).toBe(404);
    expect(appStoreRepository.updateAppStore).not.toHaveBeenCalled();
    expect(repoHelpers.pullRepo).not.toHaveBeenCalled();
    expect(repoHelpers.cloneRepo).not.toHaveBeenCalled();
  });

  it('pulls each enabled store exactly once when refresh succeeds', async () => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue(stores);
    repoHelpers.pullRepo.mockResolvedValue({ success: true, message: '' });

    expect(await appStoreService.pullRepositories()).toMatchObject({ success: true });

    expect(repoHelpers.pullRepo.mock.calls).toEqual(stores.map((store) => [store.url, store.slug]));
  });

  it('continues after failed stores and identifies every failed store without leaking Git errors', async () => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue(stores);
    repoHelpers.pullRepo.mockImplementation(async (_url, id) => ({ success: id === 'primary', message: 'private Git transport error' }));

    const result = await appStoreService.pullRepositories();

    expect(result.success).toBe(false);
    expect(result.message).toContain('Offline');
    expect(result.message).toContain('Backup');
    expect(result.message).not.toContain('Primary');
    expect(result.message).not.toContain('private Git transport error');
    expect(result.message).not.toContain('https://');
    expect(repoHelpers.pullRepo.mock.calls).toEqual(stores.map((store) => [store.url, store.slug]));
  });

  it('treats an empty enabled-store set as a successful no-op', async () => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue([]);

    expect(await appStoreService.pullRepositories()).toMatchObject({ success: true });

    expect(repoHelpers.pullRepo).not.toHaveBeenCalled();
  });

  it.each(['update_all', 'clone_all'] as const)('aggregates %s queue failures and still attempts all enabled stores', async (command) => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue(stores);
    const operation = command === 'update_all' ? repoHelpers.pullRepo : repoHelpers.cloneRepo;
    operation.mockImplementation(async (_url, id) => ({ success: id === 'primary', message: 'private Git transport error' }));
    const handler = repoQueue.onEvent.mock.calls[0]?.[0];
    expect(handler).toBeDefined();
    const reply = vi.fn(async (_result: { success: boolean; message: string }) => undefined);

    await handler?.({ command, eventId: 'fixture-event' }, reply);

    expect(operation.mock.calls).toEqual(stores.map((store) => [store.url, store.slug]));
    expect(reply).toHaveBeenCalledOnce();
    const result = reply.mock.calls[0]?.[0];
    expect(result?.success).toBe(false);
    expect(result?.message).toContain('Offline');
    expect(result?.message).toContain('Backup');
    expect(result?.message).not.toContain('private Git transport error');
  });

  it.each(['update_all', 'clone_all'] as const)('replies with success after every %s operation succeeds', async (command) => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue(stores);
    const operation = command === 'update_all' ? repoHelpers.pullRepo : repoHelpers.cloneRepo;
    operation.mockResolvedValue({ success: true, message: '' });
    const handler = repoQueue.onEvent.mock.calls[0]?.[0];
    const reply = vi.fn(async (_result: { success: boolean; message: string }) => undefined);

    await handler?.({ command, eventId: 'fixture-event' }, reply);

    expect(operation).toHaveBeenCalledTimes(stores.length);
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe('Marketplace refresh orchestration with the local catalogue', () => {
  const store: AppStore = fromAny({ slug: 'fixture', name: 'Fixture', url: 'https://example.com/fixture.git', enabled: true });
  const configuration = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  const appStoreService = mock<AppStoreService>();
  let marketplace: MarketplaceService;
  let controller: MarketplaceController;

  beforeEach(async () => {
    vi.clearAllMocks();
    appStoreService.pullRepositories.mockReset();
    appStoreService.pullRepositories.mockResolvedValue({ success: true, message: '' });
    appStoreService.getAllAppStores.mockResolvedValue([store]);
    appStoreService.createAppStore.mockResolvedValue(store);
    configuration.getConfig.mockReturnValue(
      fromAny({ directories: { dataDir: DATA_DIR, appDataDir: APP_DATA_DIR, appDir: APP_DIR }, architecture: 'amd64' }),
    );

    const appDirectory = path.join(DATA_DIR, 'repos', 'fixture', 'apps', 'demo');
    await fs.promises.mkdir(appDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(appDirectory, 'config.json'),
      JSON.stringify({
        id: 'demo',
        available: true,
        name: 'Local v1',
        tipi_version: 1,
        short_desc: 'Last good catalogue',
        author: 'Orbis',
        source: store.url,
      }),
    );

    marketplace = new MarketplaceService(configuration, new FilesystemService(logger), logger, appStoreService);
    controller = new MarketplaceController(marketplace, appStoreService);
  });

  it('initializes offline using the last good local catalogue', async () => {
    appStoreService.pullRepositories.mockResolvedValue({ success: false, message: 'Fixture' });

    await expect(marketplace.initialize()).resolves.toBeUndefined();

    expect(appStoreService.pullRepositories).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Fixture'));
    expect(await marketplace.getAvailableApps()).toEqual([expect.objectContaining({ urn: 'demo:fixture', name: 'Local v1', tipi_version: 1 })]);
  });

  it('can rebuild store mappings without any repository refresh', async () => {
    await marketplace.initialize({ refreshRepositories: false });

    expect(appStoreService.pullRepositories).not.toHaveBeenCalled();
    expect(await marketplace.getAvailableApps()).toHaveLength(1);
  });

  it('performs a manual refresh once and rebuilds mappings without a second pull', async () => {
    await marketplace.initialize({ refreshRepositories: false });
    expect((await marketplace.getAvailableApps())[0]?.tipi_version).toBe(1);
    appStoreService.pullRepositories.mockImplementation(async () => {
      const configPath = path.join(DATA_DIR, 'repos', 'fixture', 'apps', 'demo', 'config.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      await fs.promises.writeFile(configPath, JSON.stringify({ ...config, tipi_version: 2 }));
      return { success: true, message: '' };
    });
    const initialize = vi.spyOn(marketplace, 'initialize');

    expect(await controller.pullAppStores()).toEqual({ success: true });

    expect(appStoreService.pullRepositories).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
    expect((await marketplace.getAvailableApps())[0]?.tipi_version).toBe(2);
  });

  it('rebuilds mappings once on failed manual refresh, keeps the catalogue and propagates a translatable failure', async () => {
    await marketplace.initialize({ refreshRepositories: false });
    expect((await marketplace.getAvailableApps())[0]?.tipi_version).toBe(1);
    appStoreService.pullRepositories.mockResolvedValue({ success: false, message: 'Fixture' });
    const initialize = vi.spyOn(marketplace, 'initialize');

    const failure = await controller.pullAppStores().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranslatableError);
    expect((failure as TranslatableError).getResponse()).toEqual({ message: 'APP_STORE_REFRESH_ERROR', intlParams: { stores: 'Fixture' } });
    expect((failure as TranslatableError).getStatus()).toBeGreaterThanOrEqual(400);
    expect(appStoreService.pullRepositories).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
    expect(await marketplace.getAvailableApps()).toEqual([expect.objectContaining({ urn: 'demo:fixture', tipi_version: 1 })]);
  });

  it.each(['create', 'edit', 'delete'] as const)('rebuilds mappings after %s without refreshing all repositories', async (operation) => {
    const initialize = vi.spyOn(marketplace, 'initialize');

    if (operation === 'create') await controller.createAppStore({ name: store.name, url: store.url });
    if (operation === 'edit') await controller.updateAppStore(store.slug, { name: store.name, enabled: true });
    if (operation === 'delete') await controller.deleteAppStore(store.slug);

    expect(initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
    expect(appStoreService.pullRepositories).not.toHaveBeenCalled();
  });
});
