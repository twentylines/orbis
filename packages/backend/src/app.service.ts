import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { LocalTlsService } from './core/local-tls/local-tls.service';
import { CacheService, ONE_DAY_IN_SECONDS } from './core/cache/cache.service';
import { ConfigurationService } from './core/config/configuration.service';
import { DatabaseService } from './core/database/database.service';
import { FilesystemService } from './core/filesystem/filesystem.service';
import { LoggerService } from './core/logger/logger.service';
import { AppLifecycleService } from './modules/app-lifecycle/app-lifecycle.service';
import { AppStatusSyncService } from './modules/app-lifecycle/app-status-sync.service';
import { AppStoreService } from './modules/app-stores/app-store.service';
import { MarketplaceService } from './modules/marketplace/marketplace.service';
import { RepoEventsQueue } from './modules/queue/entities/repo-events';
import { SystemEventsQueue } from './modules/queue/entities/system-events';
import { DOCKERODE } from './modules/docker/docker.module';
import Dockerode from 'dockerode';
import { GithubService } from './utils/github/github.service';
import YAML from 'yaml';
import { installationMode } from './common/installation-mode';
import { retainedBootstrapStartup, retainedSettledStartup } from './modules/system-backups/backup-restore-startup';
import { QueueFactory } from './modules/queue/queue.factory';
import { backupMaintenanceActive, coreCaptureRecoveryRequired } from './common/backup-maintenance';
import { restoreTerminalStartup, restoreStartupRole } from './modules/system-backups/backup-restore-startup';
import { ResetService } from './modules/system-reset/reset.service';
import { controllerOverlayStartup } from './common/controller-overlay-startup';

@Injectable()
export class AppService {
  private retainedPreparation?: Promise<void>;
  private retainedTimersInstalled = false;
  private coreCapturePreparation?: Promise<void>;
  private coreCapturePrepared = false;
  private coreCaptureTimersAttempted = false;
  private coreCaptureTimersError?: unknown;
  private coreCaptureTimersFailed = false;
  constructor(
    private readonly cache: CacheService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly repoQueue: RepoEventsQueue,
    private readonly systemEventsQueue: SystemEventsQueue,
    private readonly filesystem: FilesystemService,
    private readonly appStoreService: AppStoreService,
    private readonly marketplaceService: MarketplaceService,
    private readonly databaseService: DatabaseService,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly appStatusSyncService: AppStatusSyncService,
    private readonly githubService: GithubService,
    private readonly queueFactory: QueueFactory,
    private readonly reset: ResetService,
    private readonly localTls: LocalTlsService,
    @Inject(DOCKERODE) private docker: Dockerode,
  ) {}

  public async bootstrap(prepareRecovery: () => Promise<void> = async () => undefined) {
    if (coreCaptureRecoveryRequired()) {
      this.logger.warn('Core capture recovery requires review. App startup remains held.');
      return;
    }
    const installation = installationMode();
    const preserveControllerNetwork = controllerOverlayStartup();
    if (!retainedBootstrapStartup() && !retainedSettledStartup()) await this.databaseService.migrate();
    await prepareRecovery();
    if (installation.phase === 'normal' && restoreStartupRole() === 'ordinary') await this.reset.resumePending();
    if (installation.phase === 'hold') {
      this.logger.info('Installation mode: database prepared; app services remain held.');
      return;
    }
    if (backupMaintenanceActive()) {
      this.logger.warn('Full backup recovery needs review. App startup changes remain held.');
      return;
    }
    if (retainedSettledStartup()) {
      await this.prepareRetainedNormalContinuation();
      this.activateRetainedNormalContinuation();
      return;
    }
    if (installation.phase === 'resume') {
      await this.appLifecycleService.requireNoPendingRestores();
      await this.queueFactory.prepareInstallationResume();
    } else await this.appLifecycleService.recoverInterruptedRestores();
    try {
      if (installation.phase === 'normal' && !preserveControllerNetwork)
        await this.docker.pruneNetworks({ filters: { label: ['orbis.managed=true'] } });

      const { version, userSettings, __prod__, architecture } = this.configuration.getConfig();
      this.logger.info('Log level', userSettings.logLevel);
      this.logger.debug('Starting server', { version, architecture, logLevel: userSettings.logLevel });

      this.configuration.initSentry({ release: version, allowSentry: userSettings.allowErrorMonitoring });

      await this.logger.flush();

      this.logger.info(`Running version: ${process.env.TIPI_VERSION}`);

      const buster = this.cache.get('buster');
      if (buster !== version) {
        this.logger.info('Clearing cache...');
        this.cache.clear();
        this.cache.set('buster', version, ONE_DAY_IN_SECONDS * 365);
      }

      await this.appStoreService.migrateLegacyRepo();

      this.repoQueue.publish({ command: 'clone_all' });

      await this.marketplaceService.initialize();

      // Every 15 minutes, check for updates to the apps repo
      if (__prod__) {
        this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
      }
      this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');

      if ((installation.phase === 'resume' && restoreStartupRole() === 'candidate') || preserveControllerNetwork) {
        await this.initializeAssets(true);
      } else {
        await this.copyAssets();
        await this.generateTlsCertificates({ localDomain: userSettings.localDomain });
      }

      if (
        !preserveControllerNetwork &&
        !restoreTerminalStartup() &&
        installation.phase !== 'resume' &&
        __prod__ &&
        (buster !== version || version === 'nightly')
      ) {
        this.appLifecycleService.restartRunningApps();
      }

      // Reconcile persisted app states before the dashboard serves its first status list.
      const statuses = await this.appStatusSyncService.syncAllAppStatuses();
      if ((installation.phase === 'resume' || preserveControllerNetwork) && !statuses.success)
        throw new Error('App status reconciliation failed during installation resume.');
      if (restoreStartupRole() !== 'candidate') await this.queueFactory.completeInstallationResume();
    } catch (e) {
      this.logger.error(e);
      Sentry.captureException(e, { tags: { source: 'bootstrap' } });
      if (installation.phase === 'resume' || preserveControllerNetwork) throw e;
    }
  }

  private requireCoreCaptureHold() {
    if (installationMode().phase !== 'normal' || coreCaptureRecoveryRequired() !== false || backupMaintenanceActive() !== true)
      throw new Error('Core capture presentation requires normal mode and the maintenance hold.');
  }

  public prepareCoreCapturePresentation(): Promise<void> {
    this.coreCapturePreparation ??= Promise.resolve().then(async () => {
      this.requireCoreCaptureHold();
      const { version, userSettings } = this.configuration.getConfig();
      this.configuration.initSentry({ release: version, allowSentry: userSettings.allowErrorMonitoring });
      this.requireCoreCaptureHold();
      await this.marketplaceService.initialize({ refreshRepositories: false });
      this.requireCoreCaptureHold();
      const statuses = await this.appStatusSyncService.syncAllAppStatuses();
      this.requireCoreCaptureHold();
      if (!statuses.success) throw new Error('App status reconciliation failed during core capture startup.');
      this.coreCapturePrepared = true;
    });
    return this.coreCapturePreparation;
  }

  public activateCoreCaptureTimers(): void {
    this.requireCoreCaptureHold();
    if (!this.coreCapturePrepared) throw new Error('Core capture presentation is not prepared.');
    if (this.coreCaptureTimersAttempted) {
      if (this.coreCaptureTimersFailed) throw this.coreCaptureTimersError;
      return;
    }
    this.coreCaptureTimersAttempted = true;
    try {
      if (this.configuration.getConfig().__prod__) this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
      this.requireCoreCaptureHold();
      this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');
      this.requireCoreCaptureHold();
    } catch (error) {
      this.coreCaptureTimersFailed = true;
      this.coreCaptureTimersError = error;
      throw error;
    }
  }

  public async prepareRetainedNormalContinuation() {
    if (!retainedBootstrapStartup() && !retainedSettledStartup()) throw new Error('Retained continuation is unavailable.');
    if (retainedBootstrapStartup() && !backupMaintenanceActive()) throw new Error('Retained continuation is not held.');
    this.retainedPreparation ??= this.marketplaceService.initialize({ refreshRepositories: false }).catch((error: unknown) => {
      this.retainedPreparation = undefined;
      throw error;
    });
    await this.retainedPreparation;
  }

  public activateRetainedNormalContinuation() {
    if (!this.retainedPreparation || (!retainedBootstrapStartup() && !retainedSettledStartup()))
      throw new Error('Retained continuation is not prepared.');
    if (this.retainedTimersInstalled) return;
    if (this.configuration.getConfig().__prod__) this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
    this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');
    this.retainedTimersInstalled = true;
  }

  public async getVersion() {
    const { version: currentVersion } = this.configuration.getConfig();

    const [githubRelease, releasesSince] = await Promise.all([
      this.githubService.getLatestRelease('runtipi', 'runtipi'),
      this.githubService.getReleasesSince('runtipi', 'runtipi', currentVersion),
    ]);

    return {
      current: currentVersion,
      latest: githubRelease?.version || currentVersion,
      body: githubRelease?.body ?? '',
      releases: releasesSince,
    };
  }

  public async copyAssets() {
    await this.initializeAssets(false);
  }

  private async initializeAssets(preserveNetworkAccess: boolean) {
    const { directories, userSettings } = this.configuration.getConfig();
    const { appDir, dataDir, appDataDir } = directories;

    const assetsFolder = path.join(appDir, 'assets');

    if (!preserveNetworkAccess) {
      this.logger.info('Creating traefik folders');

      await this.filesystem.createDirectories([
        path.join(dataDir, 'traefik', 'dynamic'),
        path.join(dataDir, 'traefik', 'shared'),
        path.join(dataDir, 'traefik', 'tls'),
      ]);

      if (userSettings.persistTraefikConfig) {
        this.logger.warn('Skipping the copy of traefik files because persistTraefikConfig is set to true');
      } else {
        this.logger.info('Copying traefik files');
        await this.writeTraefikConfig(path.join(assetsFolder, 'traefik', 'traefik.yml'), path.join(dataDir, 'traefik', 'traefik.yml'));
        await this.filesystem.copyFile(
          path.join(assetsFolder, 'traefik', 'dynamic', 'dynamic.yml'),
          path.join(dataDir, 'traefik', 'dynamic', 'dynamic.yml'),
        );
      }
    }

    // Create base folders
    this.logger.info('Creating base folders');
    await this.filesystem.createDirectories([
      path.join(dataDir, 'apps'),
      path.join(dataDir, 'state'),
      path.join(dataDir, 'repos'),
      path.join(dataDir, 'backups'),
      path.join(appDataDir),
    ]);

    // Create media folders
    this.logger.info('Creating media folders');
    await this.filesystem.createDirectories([
      path.join(dataDir, 'media', 'torrents', 'watch'),
      path.join(dataDir, 'media', 'torrents', 'complete'),
      path.join(dataDir, 'media', 'torrents', 'incomplete'),
      path.join(dataDir, 'media', 'usenet', 'watch'),
      path.join(dataDir, 'media', 'usenet', 'complete'),
      path.join(dataDir, 'media', 'usenet', 'incomplete'),
      path.join(dataDir, 'media', 'downloads', 'watch'),
      path.join(dataDir, 'media', 'downloads', 'complete'),
      path.join(dataDir, 'media', 'downloads', 'incomplete'),
      path.join(dataDir, 'media', 'data', 'books'),
      path.join(dataDir, 'media', 'data', 'comics'),
      path.join(dataDir, 'media', 'data', 'movies'),
      path.join(dataDir, 'media', 'data', 'music'),
      path.join(dataDir, 'media', 'data', 'tv'),
      path.join(dataDir, 'media', 'data', 'podcasts'),
      path.join(dataDir, 'media', 'data', 'images'),
      path.join(dataDir, 'media', 'data', 'roms'),
    ]);
  }

  private async writeTraefikConfig(src: string, dest: string) {
    const config = await this.filesystem.readTextFile(src);
    if (!config) {
      await this.filesystem.copyFile(src, dest);
      return;
    }

    const parsed = YAML.parse(config) as {
      entryPoints?: Record<string, { forwardedHeaders?: unknown }>;
    };
    const { trustedProxyIps } = this.configuration.get('traefik');

    for (const entrypoint of ['web', 'websecure']) {
      parsed.entryPoints ??= {};
      parsed.entryPoints[entrypoint] ??= {};
      const entryPoint = parsed.entryPoints[entrypoint];

      const currentForwardedHeaders = entryPoint.forwardedHeaders;
      if (!trustedProxyIps.length) {
        if (currentForwardedHeaders && typeof currentForwardedHeaders === 'object' && !Array.isArray(currentForwardedHeaders)) {
          delete (currentForwardedHeaders as { trustedIPs?: string[] }).trustedIPs;
          if (Object.keys(currentForwardedHeaders).length === 0) {
            delete entryPoint.forwardedHeaders;
          }
        }
        continue;
      }

      if (!currentForwardedHeaders || typeof currentForwardedHeaders !== 'object' || Array.isArray(currentForwardedHeaders)) {
        entryPoint.forwardedHeaders = {};
      }

      const forwardedHeaders = entryPoint.forwardedHeaders as { trustedIPs?: string[] } & Record<string, unknown>;
      forwardedHeaders.trustedIPs = [...new Set(trustedProxyIps)];
    }

    await this.filesystem.writeTextFile(dest, YAML.stringify(parsed));
  }

  /**
   * Given a domain, generates the TLS certificates for it to be used with Traefik
   *
   * @param {string} data.domain The domain to generate the certificates for
   */
  public generateTlsCertificates = async (data: { localDomain?: string }) => {
    try {
      await this.localTls.ensure(data.localDomain);
    } catch (error) {
      this.logger.error(error);
    }
  };
}
