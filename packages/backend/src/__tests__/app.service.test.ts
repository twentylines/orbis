import fs from 'node:fs';
import path from 'node:path';
import { AppService } from '@/app.service';
import { APP_DATA_DIR, APP_DIR, DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { FsMock } from '@/tests/__mocks__/fs';
import { GithubService } from '@/utils/github/github.service';
import { faker } from '@faker-js/faker';
import { Test } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { AppStatusSyncService } from '@/modules/app-lifecycle/app-status-sync.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import YAML from 'yaml';
import { DatabaseService } from '@/core/database/database.service';
import { QueueFactory } from '@/modules/queue/queue.factory';

const TRAEFIK_CONFIG = `api:
  dashboard: true
  insecure: true

entryPoints:
  web:
    address: ":80"
    forwardedHeaders:
      insecure: true
      trustedIPs:
        - "127.0.0.1/32"
  websecure:
    address: ":443"
    forwardedHeaders:
      trustedIPs:
        - "127.0.0.1/32"
    http:
      tls:
        certResolver: myresolver
`;

describe('AppService', () => {
  let appService: AppService;
  let configurationService = mock<ConfigurationService>();
  let githubService = mock<GithubService>();
  let appStatusSyncService = mock<AppStatusSyncService>();
  let appLifecycleService = mock<AppLifecycleService>();
  let databaseService = mock<DatabaseService>();
  let queueFactory = mock<QueueFactory>();
  let pruneNetworks = vi.fn();

  afterEach(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    pruneNetworks = vi.fn();
    const docker = { pruneNetworks };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppService,
        FilesystemService,
        {
          provide: DOCKERODE,
          useFactory: () => docker,
          inject: [],
        },
      ],
    })
      .useMocker(() => mock())
      .compile();

    appService = moduleRef.get(AppService);
    configurationService = moduleRef.get(ConfigurationService);
    githubService = moduleRef.get(GithubService);
    appStatusSyncService = moduleRef.get(AppStatusSyncService);
    appStatusSyncService.syncAllAppStatuses.mockResolvedValue({ success: true, message: 'Synced', syncedCount: 0, skippedCount: 0, totalApps: 0 });
    appLifecycleService = moduleRef.get(AppLifecycleService);
    databaseService = moduleRef.get(DatabaseService);
    queueFactory = moduleRef.get(QueueFactory);
  });

  it('reconciles persisted application states before serving the dashboard', async () => {
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: '4.10.1', userSettings: { logLevel: 'info', allowErrorMonitoring: false, localDomain: 'local.test' }, __prod__: false }),
    );
    vi.spyOn(appService, 'copyAssets').mockResolvedValue();
    vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();

    await appService.bootstrap();

    expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledOnce();
    expect(pruneNetworks).toHaveBeenCalledOnce();
    expect(appLifecycleService.recoverInterruptedRestores).toHaveBeenCalledBefore(appStatusSyncService.syncAllAppStatuses);
  });

  it('fails startup before normal app activity if interrupted restore recovery fails', async () => {
    appLifecycleService.recoverInterruptedRestores.mockRejectedValue(new Error('Restore recovery requires available storage'));
    await expect(appService.bootstrap()).rejects.toThrow('Restore recovery requires available storage');
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
  });

  it('prepares the database while holding all app bootstrap work during installation', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    const copy = vi.spyOn(appService, 'copyAssets');
    const tls = vi.spyOn(appService, 'generateTlsCertificates');
    await appService.bootstrap();
    expect(databaseService.migrate).toHaveBeenCalledOnce();
    expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(tls).not.toHaveBeenCalled();
    expect(pruneNetworks).not.toHaveBeenCalled();
    expect(queueFactory.prepareInstallationResume).not.toHaveBeenCalled();
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
  });

  it('resumes with status reconciliation and preserves the containers restored by the installer', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: '4.10.1', userSettings: { logLevel: 'info', allowErrorMonitoring: false, localDomain: 'local.test' }, __prod__: true }),
    );
    vi.spyOn(appService, 'copyAssets').mockResolvedValue();
    vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();
    await appService.bootstrap();
    expect(appLifecycleService.requireNoPendingRestores).toHaveBeenCalledBefore(appStatusSyncService.syncAllAppStatuses);
    expect(appLifecycleService.requireNoPendingRestores).toHaveBeenCalledBefore(queueFactory.prepareInstallationResume);
    expect(queueFactory.prepareInstallationResume).toHaveBeenCalledBefore(appStatusSyncService.syncAllAppStatuses);
    expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledBefore(queueFactory.completeInstallationResume);
    expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledOnce();
    expect(pruneNetworks).not.toHaveBeenCalled();
  });

  it('fails installer resume instead of reporting a healthy partially initialized controller', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: '4.10.1', userSettings: { logLevel: 'info', allowErrorMonitoring: false, localDomain: 'local.test' }, __prod__: true }),
    );
    vi.spyOn(appService, 'copyAssets').mockRejectedValue(new Error('Asset initialization failed'));
    await expect(appService.bootstrap()).rejects.toThrow('Asset initialization failed');
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
  });

  it('refuses installer resume when restore recovery is still pending', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    appLifecycleService.requireNoPendingRestores.mockRejectedValue(new Error('Restore needs review'));
    await expect(appService.bootstrap()).rejects.toThrow('Restore needs review');
    expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
    expect(queueFactory.prepareInstallationResume).not.toHaveBeenCalled();
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
  });

  it('refuses installer resume before app bootstrap if the application queue is not idle', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    queueFactory.prepareInstallationResume.mockRejectedValue(new Error('Pending app commands'));
    await expect(appService.bootstrap()).rejects.toThrow('Pending app commands');
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
  });

  it('keeps app consumption held when status reconciliation reports failure', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: '4.10.1', userSettings: { logLevel: 'info', allowErrorMonitoring: false }, __prod__: true }),
    );
    vi.spyOn(appService, 'copyAssets').mockResolvedValue();
    vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();
    appStatusSyncService.syncAllAppStatuses.mockResolvedValue({
      success: false,
      message: 'Unavailable',
      syncedCount: 0,
      skippedCount: 0,
      totalApps: 0,
    });
    await expect(appService.bootstrap()).rejects.toThrow('App status reconciliation failed');
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
  });

  describe('getVersion', () => {
    it('should return the version', async () => {
      // arrange
      const version = faker.system.semver();
      const latest = faker.system.semver();
      const body = faker.lorem.paragraph();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      githubService.getLatestRelease.mockResolvedValueOnce({ version: latest, body });
      githubService.getReleasesSince.mockResolvedValueOnce([]);

      // act
      const result = await appService.getVersion();

      // assert
      expect(result.current).toBe(version);
      expect(result.latest).toBe(latest);
      expect(result.body).toBe(body);
    });

    it('should return version from cache if set', async () => {
      // arrange
      const version = faker.system.semver();
      const latest = faker.system.semver();
      const body = faker.lorem.paragraph();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      githubService.getLatestRelease.mockResolvedValueOnce({ version: latest, body });
      githubService.getReleasesSince.mockResolvedValueOnce([]);

      // act
      const result = await appService.getVersion();

      // assert
      expect(result.current).toBe(version);
      expect(result.latest).toBe(latest);
      expect(result.body).toBe(body);
    });

    it('should fetch latest version from github if not in cache', async () => {
      // arrange
      const version = faker.system.semver();
      const latest = faker.system.semver();
      const body = faker.lorem.paragraph();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      githubService.getLatestRelease.mockResolvedValueOnce({ version: latest, body });
      githubService.getReleasesSince.mockResolvedValueOnce([]);

      // act
      const result = await appService.getVersion();

      // assert
      expect(result.current).toBe(version);
      expect(result.latest).toBe(latest);
      expect(result.body).toBe(body);
      expect(githubService.getLatestRelease).toHaveBeenCalledWith('runtipi', 'runtipi');
      expect(githubService.getReleasesSince).toHaveBeenCalledWith('runtipi', 'runtipi', version);
    });

    it('should return current version if github service returns empty', async () => {
      // arrange
      const version = faker.system.semver();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      githubService.getLatestRelease.mockResolvedValueOnce({ version: '', body: '' });
      githubService.getReleasesSince.mockResolvedValueOnce([]);

      // act
      const result = await appService.getVersion();

      // assert
      expect(result.current).toBe(version);
      expect(result.latest).toBe(version); // Should fall back to current version when github returns empty string
      expect(result.body).toBe('');
    });

    it('should return current version if github service returns empty', async () => {
      // arrange
      const version = faker.system.semver();
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ version }));
      githubService.getLatestRelease.mockResolvedValueOnce({ version: '', body: '' });
      githubService.getReleasesSince.mockResolvedValueOnce([]);

      // act
      const result = await appService.getVersion();

      // assert
      expect(result.current).toBe(version);
      expect(result.latest).toBe(version); // Should fall back to current version when github returns empty string
      expect(result.body).toBe('');
    });
  });

  describe('copyAssets', () => {
    it('should create base folder structure', async () => {
      // arrange
      const appDir = APP_DIR;
      const dataDir = DATA_DIR;
      const appDataDir = APP_DATA_DIR;
      const directories = { appDir, dataDir, appDataDir };
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));

      // act
      await appService.copyAssets();

      // assert
      expect((fs as unknown as FsMock).tree()).toMatchSnapshot();
    });

    it('should use only configured trusted proxy IPs in traefik config', async () => {
      const appDir = APP_DIR;
      const dataDir = DATA_DIR;
      const appDataDir = APP_DATA_DIR;
      const directories = { appDir, dataDir, appDataDir };
      const fsMock = fs as unknown as FsMock;
      fsMock.__applyMockFiles({
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: TRAEFIK_CONFIG,
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: '',
      });
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));
      configurationService.get.calledWith('traefik').mockReturnValueOnce({
        trustedProxyIps: ['203.0.113.10/32', '2001:db8::/32', '203.0.113.10/32'],
      });

      await appService.copyAssets();

      const output = await fs.promises.readFile(path.join(DATA_DIR, 'traefik', 'traefik.yml'), 'utf8');
      const parsed = YAML.parse(output);
      expect(parsed.entryPoints.web.forwardedHeaders.insecure).toBe(true);
      expect(parsed.entryPoints.web.forwardedHeaders.trustedIPs).toEqual(['203.0.113.10/32', '2001:db8::/32']);
      expect(parsed.entryPoints.websecure.forwardedHeaders.trustedIPs).toEqual(['203.0.113.10/32', '2001:db8::/32']);
    });

    it('should remove default trusted proxy IPs from traefik config when none are configured', async () => {
      const appDir = APP_DIR;
      const dataDir = DATA_DIR;
      const appDataDir = APP_DATA_DIR;
      const directories = { appDir, dataDir, appDataDir };
      const fsMock = fs as unknown as FsMock;
      fsMock.__applyMockFiles({
        [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: TRAEFIK_CONFIG,
        [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: '',
      });
      configurationService.getConfig.mockReturnValueOnce(fromPartial({ directories, userSettings: { persistTraefikConfig: false } }));
      configurationService.get.calledWith('traefik').mockReturnValueOnce({
        trustedProxyIps: [],
      });

      await appService.copyAssets();

      const output = await fs.promises.readFile(path.join(DATA_DIR, 'traefik', 'traefik.yml'), 'utf8');
      const parsed = YAML.parse(output);
      expect(parsed.entryPoints.web.forwardedHeaders.insecure).toBe(true);
      expect(parsed.entryPoints.web.forwardedHeaders.trustedIPs).toBeUndefined();
      expect(parsed.entryPoints.websecure.forwardedHeaders).toBeUndefined();
    });
  });
});
