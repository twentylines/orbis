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
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { setBackupRecoveryRequired } from '@/common/backup-maintenance';
import { mock } from 'vitest-mock-extended';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { AppStatusSyncService } from '@/modules/app-lifecycle/app-status-sync.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import YAML from 'yaml';
import { DatabaseService } from '@/core/database/database.service';
import { QueueFactory } from '@/modules/queue/queue.factory';
import { LoggerService } from '@/core/logger/logger.service';
import * as restoreStartup from '@/modules/system-backups/backup-restore-startup';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import * as controllerStartup from '@/common/controller-overlay-startup';
import * as maintenance from '@/common/backup-maintenance';
import * as installation from '@/common/installation-mode';

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
  let loggerService = mock<LoggerService>();
  let marketplace = mock<MarketplaceService>();
  let repoQueue = mock<RepoEventsQueue>();
  let systemQueue = mock<SystemEventsQueue>();
  let controllerPolicy: MockInstance<() => boolean>;

  afterEach(() => {
    vi.unstubAllEnvs();
    controllerPolicy.mockRestore();
    setBackupRecoveryRequired(false);
  });

  beforeEach(async () => {
    controllerPolicy = vi.spyOn(controllerStartup, 'controllerOverlayStartup').mockReturnValue(false);
    pruneNetworks = vi.fn();
    loggerService = mock<LoggerService>();
    const docker = { pruneNetworks };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppService,
        FilesystemService,
        { provide: LoggerService, useValue: loggerService },
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
    loggerService = moduleRef.get(LoggerService);
    marketplace = moduleRef.get(MarketplaceService);
    marketplace.initialize.mockResolvedValue(undefined);
    repoQueue = moduleRef.get(RepoEventsQueue);
    systemQueue = moduleRef.get(SystemEventsQueue);
  });

  describe('core capture presentation', () => {
    beforeEach(() => {
      vi.spyOn(maintenance, 'backupMaintenanceActive').mockReturnValue(true);
      vi.spyOn(maintenance, 'coreCaptureRecoveryRequired').mockReturnValue(false);
      vi.spyOn(installation, 'installationMode').mockReturnValue({ phase: 'normal' } as ReturnType<typeof installation.installationMode>);
      configurationService.getConfig.mockReturnValue(fromPartial({ version: '5.0.0', userSettings: { allowErrorMonitoring: true }, __prod__: true }));
    });
    afterEach(() => vi.restoreAllMocks());

    it('performs only capture presentation work and installs timers once', async () => {
      const copy = vi.spyOn(appService, 'copyAssets');
      const tls = vi.spyOn(appService, 'generateTlsCertificates');
      const first = appService.prepareCoreCapturePresentation();
      expect(appService.prepareCoreCapturePresentation()).toBe(first);
      await first;
      appService.activateCoreCaptureTimers();
      appService.activateCoreCaptureTimers();
      expect(configurationService.initSentry).toHaveBeenCalledExactlyOnceWith({ release: '5.0.0', allowSentry: true });
      expect(marketplace.initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
      expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledOnce();
      expect(repoQueue.publishRepeatable).toHaveBeenCalledExactlyOnceWith({ command: 'update_all' }, '*/15 * * * *');
      expect(systemQueue.publishRepeatable).toHaveBeenCalledExactlyOnceWith({ command: 'sync_app_statuses' }, '*/5 * * * *');
      expect(databaseService.migrate).not.toHaveBeenCalled();
      expect(repoQueue.publish).not.toHaveBeenCalled();
      expect(pruneNetworks).not.toHaveBeenCalled();
      expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
      expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(tls).not.toHaveBeenCalled();
    });

    it.each(['mode', 'hold', 'capture'] as const)('rejects preparation and activation with invalid %s', async (fault) => {
      if (fault === 'mode')
        vi.mocked(installation.installationMode).mockReturnValue({ phase: 'resume' } as ReturnType<typeof installation.installationMode>);
      if (fault === 'hold') vi.mocked(maintenance.backupMaintenanceActive).mockReturnValue(false);
      if (fault === 'capture') vi.mocked(maintenance.coreCaptureRecoveryRequired).mockReturnValue(true);
      await expect(appService.prepareCoreCapturePresentation()).rejects.toThrow();
      expect(() => appService.activateCoreCaptureTimers()).toThrow();
      expect(marketplace.initialize).not.toHaveBeenCalled();
      expect(systemQueue.publishRepeatable).not.toHaveBeenCalled();
    });

    it('retains failed preparation and does not activate timers', async () => {
      marketplace.initialize.mockRejectedValueOnce(new Error('marketplace unavailable'));
      await expect(appService.prepareCoreCapturePresentation()).rejects.toThrow('marketplace unavailable');
      await expect(appService.prepareCoreCapturePresentation()).rejects.toThrow('marketplace unavailable');
      expect(marketplace.initialize).toHaveBeenCalledOnce();
      expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
      expect(() => appService.activateCoreCaptureTimers()).toThrow();
      expect(systemQueue.publishRepeatable).not.toHaveBeenCalled();
    });

    it('rejects unsuccessful status reconciliation and does not activate timers', async () => {
      appStatusSyncService.syncAllAppStatuses.mockResolvedValue({ success: false, message: 'failed', syncedCount: 0, skippedCount: 0, totalApps: 0 });
      await expect(appService.prepareCoreCapturePresentation()).rejects.toThrow('App status reconciliation failed');
      expect(() => appService.activateCoreCaptureTimers()).toThrow();
      expect(systemQueue.publishRepeatable).not.toHaveBeenCalled();
    });

    it('rechecks the hold before activating and does not register production repo timers outside production', async () => {
      configurationService.getConfig.mockReturnValue(
        fromPartial({ version: '5.0.0', userSettings: { allowErrorMonitoring: false }, __prod__: false }),
      );
      await appService.prepareCoreCapturePresentation();
      vi.mocked(maintenance.backupMaintenanceActive).mockReturnValue(false);
      expect(() => appService.activateCoreCaptureTimers()).toThrow();
      vi.mocked(maintenance.backupMaintenanceActive).mockReturnValue(true);
      appService.activateCoreCaptureTimers();
      expect(repoQueue.publishRepeatable).not.toHaveBeenCalled();
      expect(systemQueue.publishRepeatable).toHaveBeenCalledOnce();
    });

    it('does not retry a partially failed timer installation', async () => {
      await appService.prepareCoreCapturePresentation();
      systemQueue.publishRepeatable.mockImplementationOnce(() => {
        throw new Error('timer failure');
      });
      expect(() => appService.activateCoreCaptureTimers()).toThrow('timer failure');
      expect(() => appService.activateCoreCaptureTimers()).toThrow('timer failure');
      expect(repoQueue.publishRepeatable).toHaveBeenCalledOnce();
      expect(systemQueue.publishRepeatable).toHaveBeenCalledOnce();
    });
  });

  it('keeps account secrets and private configuration out of startup diagnostics', async () => {
    const privateValue = 'do-not-log';
    configurationService.getConfig.mockReturnValue(
      fromPartial({
        version: '4.10.1',
        architecture: 'arm64',
        userSettings: { logLevel: 'debug', allowErrorMonitoring: false, localDomain: 'local.test' },
        database: { password: privateValue },
        jwtSecret: privateValue,
        rootFolderHost: privateValue,
        __prod__: false,
      }),
    );
    vi.spyOn(appService, 'copyAssets').mockResolvedValue();
    vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();
    await appService.bootstrap();
    expect(loggerService.debug).toHaveBeenCalled();
    expect(JSON.stringify(loggerService.debug.mock.calls)).not.toContain(privateValue);
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
    expect(pruneNetworks).toHaveBeenCalledWith({ filters: { label: ['orbis.managed=true'] } });
    expect(appLifecycleService.recoverInterruptedRestores).toHaveBeenCalledBefore(appStatusSyncService.syncAllAppStatuses);
  });

  it('fails startup before normal app activity if interrupted restore recovery fails', async () => {
    appLifecycleService.recoverInterruptedRestores.mockRejectedValue(new Error('Restore recovery requires available storage'));
    await expect(appService.bootstrap()).rejects.toThrow('Restore recovery requires available storage');
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
  });

  it('validates backup recovery after database preparation and holds direct startup mutations when needed', async () => {
    const prepareRecovery = vi.fn(async () => {
      expect(databaseService.migrate).toHaveBeenCalledOnce();
      setBackupRecoveryRequired(true);
    });
    const copy = vi.spyOn(appService, 'copyAssets');
    await appService.bootstrap(prepareRecovery);
    expect(prepareRecovery).toHaveBeenCalledOnce();
    expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(pruneNetworks).not.toHaveBeenCalled();
  });

  it('uses ordinary startup without requiring empty retained queues after settlement', async () => {
    const retained = vi.spyOn(restoreStartup, 'retainedBootstrapStartup').mockReturnValue(false);
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: '5.0.0', userSettings: { logLevel: 'info', allowErrorMonitoring: false, localDomain: 'local.test' }, __prod__: false }),
    );
    vi.spyOn(appService, 'copyAssets').mockResolvedValue();
    vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();
    try {
      await appService.bootstrap();
      expect(queueFactory.prepareRetainedConsumers).not.toHaveBeenCalled();
      expect(databaseService.migrate).toHaveBeenCalledOnce();
      expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledOnce();
    } finally {
      retained.mockRestore();
    }
  });

  it('prepares retained continuation without refreshing repositories, then registers timers once while held', async () => {
    const retained = vi.spyOn(restoreStartup, 'retainedBootstrapStartup').mockReturnValue(true);
    const settled = vi.spyOn(restoreStartup, 'retainedSettledStartup').mockReturnValue(false);
    setBackupRecoveryRequired(true);
    configurationService.getConfig.mockReturnValue(fromPartial({ __prod__: true }));
    try {
      await appService.prepareRetainedNormalContinuation();
      await appService.prepareRetainedNormalContinuation();
      appService.activateRetainedNormalContinuation();
      appService.activateRetainedNormalContinuation();
      expect(marketplace.initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
      expect(repoQueue.publishRepeatable).toHaveBeenCalledExactlyOnceWith({ command: 'update_all' }, '*/15 * * * *');
      expect(systemQueue.publishRepeatable).toHaveBeenCalledExactlyOnceWith({ command: 'sync_app_statuses' }, '*/5 * * * *');
      expect(repoQueue.publish).not.toHaveBeenCalled();
      expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    } finally {
      retained.mockRestore();
      settled.mockRestore();
    }
  });

  it('restarts a settled restored controller without reapplying saved app configuration', async () => {
    const retained = vi.spyOn(restoreStartup, 'retainedBootstrapStartup').mockReturnValue(false);
    const settled = vi.spyOn(restoreStartup, 'retainedSettledStartup').mockReturnValue(true);
    configurationService.getConfig.mockReturnValue(fromPartial({ version: 'later-cache-miss', __prod__: true }));
    try {
      await appService.bootstrap();
      expect(databaseService.migrate).not.toHaveBeenCalled();
      expect(marketplace.initialize).toHaveBeenCalledExactlyOnceWith({ refreshRepositories: false });
      expect(repoQueue.publish).not.toHaveBeenCalled();
      expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
      expect(pruneNetworks).not.toHaveBeenCalled();
      expect(systemQueue.publishRepeatable).toHaveBeenCalledOnce();
    } finally {
      retained.mockRestore();
      settled.mockRestore();
    }
  });

  it('holds startup work and skips migration during protected retained bootstrap', async () => {
    const retained = vi.spyOn(restoreStartup, 'retainedBootstrapStartup').mockReturnValue(true);
    const prepareRecovery = vi.fn(async () => setBackupRecoveryRequired(true));
    try {
      await appService.bootstrap(prepareRecovery);
      expect(prepareRecovery).toHaveBeenCalledOnce();
      expect(databaseService.migrate).not.toHaveBeenCalled();
      expect(appLifecycleService.recoverInterruptedRestores).not.toHaveBeenCalled();
      expect(appStatusSyncService.syncAllAppStatuses).not.toHaveBeenCalled();
      expect(pruneNetworks).not.toHaveBeenCalled();
    } finally {
      retained.mockRestore();
    }
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

  it.each([
    ['resume', 'candidate', '', true],
    ['resume', 'ordinary', '', false],
    ['normal', 'ordinary', '', false],
    ['normal', 'ordinary', '1', true],
    ['normal', 'ordinary', 'true', false],
    ['normal', 'ordinary', '0', false],
  ] as const)('preserves proxy identity for restore activation or controller update (%s/%s/%s)', async (phase, role, flag, preserved) => {
    vi.stubEnv('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS', flag);
    controllerPolicy.mockReturnValue(flag === '1');
    if (phase === 'resume') {
      vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
      vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    }
    const selectedRole = vi.spyOn(restoreStartup, 'restoreStartupRole').mockReturnValue(role);
    const filesystem = new FilesystemService(loggerService);
    const directoryWrites = vi.spyOn(FilesystemService.prototype, 'createDirectories');
    const textWrites = vi.spyOn(FilesystemService.prototype, 'writeTextFile');
    const copies = vi.spyOn(FilesystemService.prototype, 'copyFile');
    const tls = vi.spyOn(appService, 'generateTlsCertificates').mockResolvedValue();
    const files = fs as unknown as FsMock;
    const protectedFiles = {
      [path.join(DATA_DIR, 'traefik', 'traefik.yml')]: 'destination static configuration',
      [path.join(DATA_DIR, 'traefik', 'dynamic', 'dynamic.yml')]: 'destination routes and certificate reference',
      [path.join(DATA_DIR, 'traefik', 'tls', 'cert.pem')]: 'destination public certificate fixture',
      [path.join(DATA_DIR, 'traefik', 'tls', 'key.pem')]: 'destination private identity fixture',
    };
    files.__applyMockFiles({
      ...protectedFiles,
      [path.join(APP_DIR, 'assets', 'traefik', 'traefik.yml')]: TRAEFIK_CONFIG,
      [path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml')]: 'ordinary generated dynamic configuration',
    });
    configurationService.getConfig.mockReturnValue(
      fromPartial({
        version: '4.10.1',
        __prod__: false,
        directories: { appDir: APP_DIR, dataDir: DATA_DIR, appDataDir: APP_DATA_DIR },
        userSettings: { logLevel: 'info', allowErrorMonitoring: false, localDomain: 'target.lan', persistTraefikConfig: false },
      }),
    );
    configurationService.get.calledWith('traefik').mockReturnValue({ trustedProxyIps: [] });
    try {
      await appService.bootstrap();
      expect(appStatusSyncService.syncAllAppStatuses).toHaveBeenCalledOnce();
      expect(queueFactory.completeInstallationResume).toHaveBeenCalledOnce();
      expect(await filesystem.pathExists(path.join(DATA_DIR, 'apps'))).toBe(true);
      expect(await filesystem.pathExists(path.join(APP_DATA_DIR))).toBe(true);
      expect(await filesystem.pathExists(path.join(DATA_DIR, 'media', 'downloads', 'complete'))).toBe(true);
      const created = directoryWrites.mock.calls.flatMap(([directories]) => directories);
      if (preserved) {
        expect(created.some((directory) => directory.startsWith(path.join(DATA_DIR, 'traefik')))).toBe(false);
        expect(textWrites).not.toHaveBeenCalled();
        expect(copies).not.toHaveBeenCalled();
        expect(tls).not.toHaveBeenCalled();
        for (const [file, contents] of Object.entries(protectedFiles)) expect(await fs.promises.readFile(file, 'utf8')).toBe(contents);
        expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
        expect(pruneNetworks).not.toHaveBeenCalled();
      } else {
        expect(created).toContain(path.join(DATA_DIR, 'traefik', 'tls'));
        expect(textWrites).toHaveBeenCalledWith(path.join(DATA_DIR, 'traefik', 'traefik.yml'), expect.any(String));
        expect(copies).toHaveBeenCalledWith(
          path.join(APP_DIR, 'assets', 'traefik', 'dynamic', 'dynamic.yml'),
          path.join(DATA_DIR, 'traefik', 'dynamic', 'dynamic.yml'),
        );
        expect(tls).toHaveBeenCalledWith({ localDomain: 'target.lan' });
      }
    } finally {
      selectedRole.mockRestore();
      directoryWrites.mockRestore();
      textWrites.mockRestore();
      copies.mockRestore();
    }
  });

  it('does not advertise a healthy controller update when app status reconciliation fails', async () => {
    vi.stubEnv('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS', '1');
    controllerPolicy.mockReturnValue(true);
    configurationService.getConfig.mockReturnValue(
      fromPartial({ version: 'nightly', userSettings: { logLevel: 'info', allowErrorMonitoring: false }, __prod__: true }),
    );
    vi.spyOn(appService as unknown as { initializeAssets: () => Promise<void> }, 'initializeAssets').mockResolvedValue();
    appStatusSyncService.syncAllAppStatuses.mockResolvedValue({
      success: false,
      message: 'Unavailable',
      syncedCount: 0,
      skippedCount: 0,
      totalApps: 0,
    });
    await expect(appService.bootstrap()).rejects.toThrow('App status reconciliation failed');
    expect(appLifecycleService.restartRunningApps).not.toHaveBeenCalled();
    expect(pruneNetworks).not.toHaveBeenCalled();
    expect(queueFactory.completeInstallationResume).not.toHaveBeenCalled();
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
