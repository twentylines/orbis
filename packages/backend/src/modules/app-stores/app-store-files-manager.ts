import { appUpdateStorage } from '@/modules/docker/app-image-pins';
import { copyAppPackage } from '@/modules/app-stores/app-package-copy';
import { readAppPackageAsset } from '@/modules/app-stores/app-package-links';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadUmbrelPackage, materializeUmbrelPackage } from '@/modules/app-stores/umbrel-package';
import { withAppRepositoryCustody } from '@/modules/app-stores/app-store-lock';
import { APP_REL_COMPOSE_FILENAME } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { execFileAsync } from '@/common/helpers/exec-helpers';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStore } from '@/core/database/drizzle/types';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { appInfoSchema, convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';

export class AppStoreFilesManager {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
    public readonly storeConfig: AppStore,
  ) {}

  private getInstalledAppsFolder() {
    const { directories } = this.configuration.getConfig();

    return path.join(directories.dataDir, 'apps');
  }

  private getRepoRoot() {
    const { directories } = this.configuration.getConfig();
    return path.join(directories.dataDir, 'repos', this.storeConfig.slug);
  }

  private async getAppRepoDirectory(appUrn: AppUrn) {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    if (this.storeConfig.slug === '_user') {
      if (appStoreId !== '_user') throw new Error('The custom app package namespace changed.');
      const directory = path.join(this.getInstalledAppsFolder(), '_user', appName);
      try {
        await appUpdateStorage.noSymlinkParents(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return directory;
    }
    const native = path.join(this.getAppStoreFolder(), appName);
    if (await this.filesystem.isDirectory(native)) return native;
    return path.join(this.getRepoRoot(), appName);
  }

  private async readUmbrelPackage(appUrn: AppUrn, directory: string) {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    const previousPath = path.join(appInstalledDir, 'config.json');
    const previous = (await this.filesystem.isFile(previousPath))
      ? await this.filesystem.readJsonFile<{ catalog_revision?: string; tipi_version?: number }>(previousPath)
      : null;
    const official = /^https:\/\/github\.com\/getumbrel\/umbrel-apps(?:\.git)?(?:\/tree\/[^?#]+)?\/?$/.test(this.storeConfig.url ?? '');
    return loadUmbrelPackage(directory, appUrn, previous ?? undefined, official);
  }

  private getUmbrelPackage(appUrn: AppUrn, directory: string) {
    return withAppRepositoryCustody(path.resolve(this.getRepoRoot()), () => this.readUmbrelPackage(appUrn, directory));
  }

  private getAppStoreFolder() {
    const { directories } = this.configuration.getConfig();
    return path.join(directories.dataDir, 'repos', this.storeConfig.slug, 'apps');
  }

  public getAppPaths(appUrn: AppUrn) {
    const { appStoreId, appName } = extractAppUrn(appUrn);

    const { directories } = this.configuration.getConfig();

    return {
      appDataDir: path.join(directories.appDataDir, appStoreId, appName),
      appRepoDir: path.join(this.getAppStoreFolder(), appName),
      appInstalledDir: path.join(this.getInstalledAppsFolder(), appStoreId, appName),
    };
  }

  private async getAppInfoFromDirectory(appUrn: AppUrn, appDirectory: string) {
    const configPath = path.join(appDirectory, 'config.json');

    if (!(await this.filesystem.isFile(configPath)) && (await this.filesystem.isFile(path.join(appDirectory, 'umbrel-app.yml')))) {
      return (await this.getUmbrelPackage(appUrn, appDirectory)).info;
    }

    if (!(await this.filesystem.isFile(configPath))) {
      return;
    }

    const configFile = await this.filesystem.readTextFile(configPath);

    const config = JSON.parse(configFile ?? '{}');
    const parsedConfig = appInfoSchema({ ...config, urn: appUrn });

    if (parsedConfig instanceof type.errors) {
      this.logger.error(`App ${appUrn} installed config error:`);
      this.logger.error(parsedConfig.summary);

      return null;
    }

    if (!parsedConfig.available) {
      return null;
    }

    const description = (await readAppPackageAsset(appDirectory, 'metadata/description.md').catch(() => undefined))?.bytes.toString('utf8') ?? '';

    return { ...parsedConfig, description };
  }

  /**
   * Get the app info from the app store
   * @param appUrn - The app id
   */
  public async getAppInfoFromAppStore(appUrn: AppUrn) {
    try {
      const appRepoDir = await this.getAppRepoDirectory(appUrn);

      return await this.getAppInfoFromDirectory(appUrn, appRepoDir);
    } catch (error) {
      this.logger.error(`Error getting app info from app store for ${appUrn}:`, error);
    }
  }

  public async getAppInfoFromAppStoreOrInstalled(appUrn: AppUrn) {
    const appInfo = await this.getAppInfoFromAppStore(appUrn);
    if (appInfo) {
      return appInfo;
    }

    const { appInstalledDir } = this.getAppPaths(appUrn);

    return await this.getAppInfoFromDirectory(appUrn, appInstalledDir);
  }

  public async getSourceDockerComposeYaml(appUrn: AppUrn) {
    const appRepoDir = await this.getAppRepoDirectory(appUrn);
    if (
      !(await this.filesystem.isFile(path.join(appRepoDir, 'config.json'))) &&
      (await this.filesystem.isFile(path.join(appRepoDir, 'umbrel-app.yml')))
    ) {
      const app = await this.getUmbrelPackage(appUrn, appRepoDir);
      if (!app.compose) throw new Error(app.info.compatibility?.reasons.join(' ') || 'Unsupported Umbrel application.');
      return { path: path.join(appRepoDir, APP_REL_COMPOSE_FILENAME), content: app.compose };
    }

    const appYamlPath = path.join(appRepoDir, APP_REL_COMPOSE_FILENAME);

    let content = null;

    try {
      if (await this.filesystem.isFile(appYamlPath)) {
        content = await this.filesystem.readYamlFile(appYamlPath);
      }
    } catch (error) {
      this.logger.error(`Error getting ${APP_REL_COMPOSE_FILENAME} for app ${appUrn} from repo ${this.storeConfig.slug}:`, error);
    }

    if (content && typeof content === 'object' && 'x-runtipi' in content) {
      return { path: appYamlPath, content };
    }

    // Fallback to legacy docker-compose.json
    const dockerComposePath = path.join(appRepoDir, 'docker-compose.json');

    try {
      if (await this.filesystem.isFile(dockerComposePath)) {
        content = await this.filesystem.readJsonFile(dockerComposePath);
      }
    } catch (error) {
      this.logger.error(`Error getting docker-compose.json for app ${appUrn} from repo ${this.storeConfig.slug}:`, error);
    }

    return { path: dockerComposePath, content: convertLegacyToYaml(content) };
  }

  /**
   * Copy the app from the repo to the installed apps folder
   * @param appUrn - The app id
   */
  public async copyAppFromRepoToInstalled(appUrn: AppUrn) {
    return withAppRepositoryCustody(path.resolve(this.getRepoRoot()), async () => {
      const { appDataDir, appInstalledDir } = this.getAppPaths(appUrn);
      const appRepoDir = await this.getAppRepoDirectory(appUrn);
      if (!(await this.filesystem.isDirectory(appRepoDir))) {
        if (await this.filesystem.isDirectory(appInstalledDir)) return;
        throw new Error('The app package is not available in its catalogue.');
      }
      // Custom definitions already live in this directory; never replace it with itself.
      if (appRepoDir === appInstalledDir) return;
      if (!(await this.filesystem.createDirectory(path.dirname(appInstalledDir))))
        throw new Error('The installed app directory could not be created.');
      const staging = `${appInstalledDir}.package-stage-${crypto.randomUUID()}`;
      const backup = `${appInstalledDir}.package-backup-${crypto.randomUUID()}`;
      let backedUp = false;
      try {
        if (
          !(await this.filesystem.isFile(path.join(appRepoDir, 'config.json'))) &&
          (await this.filesystem.isFile(path.join(appRepoDir, 'umbrel-app.yml')))
        ) {
          const app = await this.readUmbrelPackage(appUrn, appRepoDir);
          if (!app.info.available || !app.compose) throw new Error(app.info.compatibility?.reasons.join(' ') || 'Unsupported Umbrel application.');
          await materializeUmbrelPackage(staging, app);
        } else {
          await copyAppPackage(this.filesystem.getSafeFilePath(appRepoDir), this.filesystem.getSafeFilePath(staging));
        }
        if (!(await this.filesystem.createDirectory(appDataDir))) throw new Error('The app data directory could not be created.');
        if (await this.filesystem.pathExists(appInstalledDir)) {
          await fs.promises.rename(appInstalledDir, backup);
          backedUp = true;
        }
        try {
          await fs.promises.rename(staging, appInstalledDir);
        } catch (error) {
          if (backedUp) {
            await fs.promises.rename(backup, appInstalledDir);
            backedUp = false;
          }
          throw error;
        }
        if (backedUp) {
          await fs.promises.rm(backup, { recursive: true });
          backedUp = false;
        }
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    });
  }

  public async stageAppUpdate(appUrn: AppUrn, destination: string) {
    return withAppRepositoryCustody(path.resolve(this.getRepoRoot()), async () => {
      const appRepoDir = await this.getAppRepoDirectory(appUrn);
      if (
        !(await this.filesystem.isFile(path.join(appRepoDir, 'config.json'))) &&
        (await this.filesystem.isFile(path.join(appRepoDir, 'umbrel-app.yml')))
      ) {
        const app = await this.readUmbrelPackage(appUrn, appRepoDir);
        if (!app.info.available || !app.compose) throw new Error('The target Umbrel application is unavailable.');
        await materializeUmbrelPackage(destination, app);
        return;
      }
      if (!(await this.filesystem.isDirectory(appRepoDir))) throw new Error('The target app package is unavailable.');
      await copyAppPackage(this.filesystem.getSafeFilePath(appRepoDir), this.filesystem.getSafeFilePath(destination));
    });
  }

  /**
   *  This function returns an object containing information about the updates available for the app with the provided id.
   *  It checks if the app is installed or not and looks for the config.json file in the appropriate directory.
   *  If the config.json file is invalid, it returns null.
   *  If the app is not found, it returns null.
   *
   *  @param {string} appUrn - The app id.
   */
  public async getAppUpdateInfo(appUrn: AppUrn) {
    const config = await this.getAppInfoFromAppStore(appUrn);
    const paths = { ...this.getAppPaths(appUrn), appRepoDir: await this.getAppRepoDirectory(appUrn) };

    if (config) {
      return {
        ...paths,
        latestVersion: config.tipi_version,
        minTipiVersion: config.min_tipi_version ?? null,
        latestDockerVersion: config.version,
      };
    }

    return {
      latestVersion: 0,
      latestDockerVersion: '0.0.0',
      minTipiVersion: null,
      ...paths,
    };
  }

  /**
   * Get the list of available app ids
   * @returns The list of app ids
   */
  public async getAvailableAppUrns() {
    const nativeFolder = this.getAppStoreFolder();
    const appsRepoFolder = (await this.filesystem.isDirectory(nativeFolder)) ? nativeFolder : this.getRepoRoot();

    if (!(await this.filesystem.isDirectory(appsRepoFolder))) {
      this.logger.error(`Apps repo ${this.storeConfig.slug} not found. Make sure your repo is configured correctly.`);
      return [];
    }

    const appsDir = await this.filesystem.listFiles(appsRepoFolder);
    const skippedDirs = ['__tests__'];

    const validApps = await Promise.all(
      appsDir
        .filter((app) => !skippedDirs.includes(app))
        .map(async (app) => {
          const appPath = path.join(appsRepoFolder, app);
          const isDir = await this.filesystem.isDirectory(appPath);
          if (!isDir) return null;
          if (appsRepoFolder !== nativeFolder && !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(app)) return null;
          if (appsRepoFolder !== nativeFolder && !(await this.filesystem.isFile(path.join(appPath, 'umbrel-app.yml')))) return null;
          return app;
        }),
    );

    return validApps.filter((app): app is string => app !== null).map((app) => `${app}:${this.storeConfig.slug}` as AppUrn);
  }

  /**
   * Given a template and a map of variables, this function replaces all instances of the variables in the template with their values.
   *
   * @param {string} template - The template to be rendered.
   * @param {Map<string, string>} envMap - The map of variables and their values.
   */
  private renderTemplate(template: string, envMap: Map<string, string>) {
    let renderedTemplate = template;

    envMap.forEach((value, key) => {
      const safeKey = key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      renderedTemplate = renderedTemplate.replace(new RegExp(`{{${safeKey}}}`, 'g'), value);
    });

    return renderedTemplate;
  }

  public async copyDataDir(appUrn: AppUrn, envMap: Map<string, string>) {
    const { appInstalledDir, appDataDir } = this.getAppPaths(appUrn);

    // return if app does not have a data directory
    if (!(await this.filesystem.isDirectory(path.join(appInstalledDir, 'data')))) {
      return;
    }

    // Return if app has already a data directory
    if (await this.filesystem.pathExists(path.join(appDataDir, 'data'))) {
      return;
    }

    // Create app-data folder
    await this.filesystem.createDirectory(path.join(appDataDir, 'data'));

    const dataDir = await this.filesystem.listFiles(path.join(appInstalledDir, 'data'));

    const processFile = async (file: string) => {
      const sourcePath = path.join(appInstalledDir, 'data', file);

      if (!(await this.filesystem.isFile(sourcePath))) {
        return;
      }

      if (file.endsWith('.template')) {
        const template = await this.filesystem.readTextFile(sourcePath);
        if (template) {
          const renderedTemplate = this.renderTemplate(template, envMap);

          await this.filesystem.writeTextFile(path.join(appDataDir, 'data', file.replace('.template', '')), renderedTemplate);
        }
      } else {
        await this.filesystem.copyFile(sourcePath, path.join(appDataDir, 'data', file));
      }
    };

    const processDir = async (p: string) => {
      await this.filesystem.createDirectory(path.join(appDataDir, 'data', p));

      const files = await this.filesystem.listFiles(path.join(appInstalledDir, 'data', p));

      await Promise.all(
        files.map(async (file) => {
          const fullPath = path.join(appInstalledDir, 'data', p, file);

          if (await this.filesystem.isDirectory(fullPath)) {
            await processDir(path.join(p, file));
          } else {
            await processFile(path.join(p, file));
          }
        }),
      );
    };

    await Promise.all(
      dataDir.map(async (file) => {
        const fullPath = path.join(appInstalledDir, 'data', file);

        if (await this.filesystem.isDirectory(fullPath)) {
          await processDir(file);
        } else {
          await processFile(file);
        }
      }),
    );

    // Remove any .gitkeep files from the app-data folder at any level
    if (await this.filesystem.isDirectory(path.join(appDataDir, 'data'))) {
      await execFileAsync('find', [`${appDataDir}/data`, '-name', '.gitkeep', '-delete']).catch(() => {
        this.logger.error(`Error removing .gitkeep files from ${appDataDir}/data`);
      });
    }
  }

  public async getAppImage(appUrn: AppUrn) {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    const appRepoDir = await this.getAppRepoDirectory(appUrn);
    const { appDir } = this.configuration.get('directories');
    for (const name of ['metadata/logo.jpg', 'metadata/icon.png', 'metadata/icon.jpg', 'metadata/icon.svg']) {
      for (const directory of [appInstalledDir, appRepoDir]) {
        const exists = await fs.promises.lstat(path.join(directory, name)).then(
          (info) => info.isFile() || info.isSymbolicLink(),
          () => false,
        );
        const selected = exists ? await readAppPackageAsset(directory, name).catch(() => undefined) : undefined;
        if (selected) return { image: selected.bytes, etag: selected.etag, contentType: selected.contentType, remoteUrl: undefined };
      }
    }
    for (const name of ['icon.png', 'icon.jpg', 'icon.svg']) {
      const exists = await fs.promises.lstat(path.join(appRepoDir, name)).then(
        (info) => info.isFile() || info.isSymbolicLink(),
        () => false,
      );
      const selected = exists ? await readAppPackageAsset(appRepoDir, name, 1024 * 1024).catch(() => undefined) : undefined;
      if (selected) return { image: selected.bytes, etag: selected.etag, contentType: selected.contentType, remoteUrl: undefined };
    }
    if (
      /^https:\/\/github\.com\/getumbrel\/umbrel-apps(?:\.git)?(?:\/tree\/[^?#]+)?\/?$/.test(this.storeConfig.url ?? '') &&
      (await this.filesystem.isFile(path.join(appRepoDir, 'umbrel-app.yml')))
    ) {
      const { appName } = extractAppUrn(appUrn);
      return {
        image: null,
        etag: undefined,
        contentType: 'image/svg+xml',
        remoteUrl: `https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/master/${appName}/icon.svg`,
      };
    }
    const fallback = path.join(appDir, 'assets', 'default-app-logo.jpg');
    return {
      image: await this.filesystem.readBinaryFile(fallback),
      etag: await this.filesystem.getFileEtag(fallback),
      contentType: 'image/jpeg',
      remoteUrl: undefined,
    };
  }

  public async getConfigJson(appUrn: AppUrn) {
    const appRepoDir = await this.getAppRepoDirectory(appUrn);
    if (
      !(await this.filesystem.isFile(path.join(appRepoDir, 'config.json'))) &&
      (await this.filesystem.isFile(path.join(appRepoDir, 'umbrel-app.yml')))
    ) {
      return { path: path.join(appRepoDir, 'umbrel-app.yml'), content: (await this.getUmbrelPackage(appUrn, appRepoDir)).info };
    }

    const configPath = path.join(appRepoDir, 'config.json');

    let content = null;
    try {
      if (await this.filesystem.isFile(configPath)) {
        content = await this.filesystem.readJsonFile(configPath);
      }
    } catch (error) {
      this.logger.error(`Error getting config.json for app ${appUrn} from repo ${this.storeConfig.slug}:`, error);
    }

    return { path: configPath, content };
  }
}
