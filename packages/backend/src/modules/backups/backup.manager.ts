import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { pLimit, sanitizeFilename } from '@/common/helpers/file-helpers';
import { ArchiveService, type ArchiveEntry } from '@/core/archive/archive.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { appInfoSchema } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { RestoreTransaction, preserveTreeMetadata } from './restore-transaction';
import { validateArchiveLinks, validateBackupTree } from './backup-links';

@Injectable()
export class BackupManager {
  private readonly restoreTransaction: RestoreTransaction;

  constructor(
    private readonly archiveManager: ArchiveService,
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly appFilesManager: AppFilesManager,
    appsRepository: AppsRepository,
  ) {
    this.restoreTransaction = new RestoreTransaction(
      filesystem,
      logger,
      () => path.join(config.get('directories').dataDir, 'state', 'app-restores'),
      (appUrn) => {
        const { appDataDir, appInstalledDir } = appFilesManager.getAppPaths(appUrn);
        return { 'app-data': appDataDir, app: appInstalledDir, 'user-config': this.getBackupPaths(appUrn).userConfigDir };
      },
      async (appUrn) => {
        const app = await appsRepository.getAppByUrn(appUrn);
        if (!app) return;
        const installed = await appFilesManager.getInstalledAppInfo(appUrn);
        await appsRepository.updateAppById(app.id, {
          status: 'stopped',
          ...(typeof installed?.tipi_version === 'number' ? { version: installed.tipi_version } : {}),
        });
      },
    );
  }

  public getPendingRestores = () => this.restoreTransaction.pendingApps();
  public hasPendingRestore = (appUrn: AppUrn) => this.restoreTransaction.isPending(appUrn);
  public recoverRestore = (appUrn: AppUrn) => this.restoreTransaction.recover(appUrn);

  private getBackupPaths(appUrn: AppUrn) {
    const { dataDir } = this.config.get('directories');
    const { appStoreId, appName } = extractAppUrn(appUrn);

    return {
      appName,
      appStoreId,
      backupDir: path.join(dataDir, 'backups', appStoreId, appName),
      userConfigDir: path.join(dataDir, 'user-config', appStoreId, appName),
    };
  }

  private getValidatedBackupFilename(filename: string) {
    const sanitizedFilename = sanitizeFilename(filename);

    if (sanitizedFilename !== filename || !sanitizedFilename.endsWith('.tar.gz')) {
      throw new Error('Invalid backup filename');
    }

    return sanitizedFilename;
  }

  private getBackupFilePath(appUrn: AppUrn, filename: string) {
    const { backupDir } = this.getBackupPaths(appUrn);
    const sanitizedFilename = this.getValidatedBackupFilename(filename);

    return {
      backupDir,
      sanitizedFilename,
      backupPath: this.filesystem.getSafeFilePath(path.join(backupDir, sanitizedFilename)),
    };
  }

  public backupApp = async (appUrn: AppUrn) => {
    if (await this.hasPendingRestore(appUrn)) throw new Error('Recover the interrupted restore before creating another backup');
    const { appName, appStoreId, backupDir, userConfigDir } = this.getBackupPaths(appUrn);
    const backupName = `${appName}-${appStoreId}-${Date.now()}-${randomUUID()}`;

    const tempDir = await this.filesystem.createTempDirectory(path.join(tmpdir(), `${appUrn}-`));

    if (!tempDir) {
      throw new Error('Failed to create temp directory');
    }

    const contentDir = path.join(tempDir, 'content');
    const archivePath = path.join(tempDir, 'backup.tar.gz');
    let pendingPath: string | undefined;

    try {
      await fs.promises.chmod(tempDir, 0o700);
      this.logger.info('Copying files to backup location...');

      if (!(await this.filesystem.createDirectory(contentDir))) {
        throw new Error('The backup staging directory could not be created');
      }

      const { appDataDir, appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);

      if (!(await this.filesystem.copyDirectory(appDataDir, path.join(contentDir, 'app-data'), { verbatimSymlinks: true, dereference: false }))) {
        throw new Error('App data could not be copied into the backup');
      }

      if (!(await this.filesystem.copyDirectory(appInstalledDir, path.join(contentDir, 'app'), { verbatimSymlinks: true, dereference: false }))) {
        throw new Error('App files could not be copied into the backup');
      }
      await preserveTreeMetadata(appDataDir, path.join(contentDir, 'app-data'));
      await preserveTreeMetadata(appInstalledDir, path.join(contentDir, 'app'));

      const userConfig = await fs.promises.lstat(this.filesystem.getSafeFilePath(userConfigDir)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (userConfig?.isDirectory()) {
        this.logger.info('Including user configuration in backup...');
        if (
          !(await this.filesystem.copyDirectory(userConfigDir, path.join(contentDir, 'user-config'), { verbatimSymlinks: true, dereference: false }))
        ) {
          throw new Error('User configuration could not be copied into the backup');
        }
        await preserveTreeMetadata(userConfigDir, path.join(contentDir, 'user-config'), false);
      } else if (userConfig) {
        throw new Error('User configuration is not a readable directory');
      }

      this.logger.info('Creating archive...');

      const { stdout, stderr } = await this.archiveManager.createTarGz(contentDir, archivePath);
      this.logger.debug('--- archiveManager.createTarGz ---');
      this.logger.debug('stderr:', stderr);
      this.logger.debug('stdout:', stdout);
      if (stderr.trim()) {
        throw new Error('The backup archive could not be created completely');
      }
      await fs.promises.chmod(archivePath, 0o600);

      this.logger.info('Moving archive to backup directory...', backupDir);

      if (!(await this.filesystem.createDirectory(backupDir))) {
        throw new Error('The backup directory could not be created');
      }
      pendingPath = this.filesystem.getSafeFilePath(path.join(backupDir, `.${backupName}.partial`));
      if (!(await this.filesystem.copyFile(archivePath, pendingPath))) {
        throw new Error('The backup archive could not be saved');
      }
      this.validateRestoreArchiveEntries(await this.archiveManager.listTarGz(pendingPath));
      const { backupPath } = this.getBackupFilePath(appUrn, `${backupName}.tar.gz`);
      await fs.promises.rename(pendingPath, backupPath);

      this.logger.info('Backup completed!');
    } finally {
      try {
        if (pendingPath) {
          await fs.promises.rm(pendingPath, { force: true });
        }
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
  };

  public restoreApp = async (appUrn: AppUrn, filename: string) => {
    const { backupDir, backupPath: archive } = this.getBackupFilePath(appUrn, filename);

    if (!archive.startsWith(backupDir)) {
      throw new Error('Invalid backup file path');
    }

    this.logger.info('Restoring app from backup...');

    // Verify the app has a backup
    if (!(await this.filesystem.isFile(archive))) {
      throw new Error('The backup file does not exist');
    }

    this.validateRestoreArchiveEntries(await this.archiveManager.listTarGz(archive));
    await this.restoreTransaction.replace(appUrn, async (restoreDir) => {
      this.logger.info('Extracting archive...');
      const { stderr, stdout } = await this.archiveManager.extractTarGz(archive, restoreDir);
      this.logger.debug('--- archiveManager.extractTarGz ---');
      this.logger.debug('stderr:', stderr);
      this.logger.debug('stdout:', stdout);
      if (stderr.trim()) throw new Error('The backup archive could not be extracted completely');

      const runValidationFsOperation = pLimit(16);

      await this.validateRestoreDirectory(path.join(restoreDir, 'app-data'), { allowSymlinks: true }, undefined, runValidationFsOperation);
      await this.validateRestoreDirectory(
        path.join(restoreDir, 'app'),
        { allowSymlinks: true, rejectHardLinks: true },
        undefined,
        runValidationFsOperation,
      );
      await this.validateRestoreDirectory(
        path.join(restoreDir, 'user-config'),
        {
          allowSymlinks: false,
          optional: true,
          rejectHardLinks: true,
        },
        undefined,
        runValidationFsOperation,
      );

      return {
        'app-data': path.join(restoreDir, 'app-data'),
        app: path.join(restoreDir, 'app'),
        'user-config': (await this.filesystem.isDirectory(path.join(restoreDir, 'user-config'))) ? path.join(restoreDir, 'user-config') : null,
      };
    });
  };

  private validateRestoreArchiveEntries(entries: ArchiveEntry[]) {
    validateArchiveLinks(entries, (entry) => this.normalizeArchiveEntryPath(entry));
    for (const entry of entries) {
      const entryPath = this.normalizeArchiveEntryPath(entry.path);

      if (entryPath === '.') {
        continue;
      }

      const rootName = entryPath.split('/')[0];

      if (!rootName) {
        throw new Error('Backup contains unsupported file types');
      }
    }
  }

  private normalizeArchiveEntryPath(entryPath: string) {
    if (path.posix.isAbsolute(entryPath)) {
      throw new Error('Backup contains unsupported file types');
    }

    const normalizedPath = path.posix.normalize(entryPath.replace(/^(\.\/)+/, ''));

    if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
      throw new Error('Backup contains unsupported file types');
    }

    return normalizedPath;
  }

  private async validateRestoreDirectory(
    directory: string,
    options: { allowSymlinks: boolean; optional?: boolean; rejectHardLinks?: boolean },
    rootDirectory = directory,
    runFsOperation = pLimit(16),
  ) {
    const directoryStats = await runFsOperation(() => fs.promises.lstat(directory)).catch((error: NodeJS.ErrnoException) => {
      if (options.optional && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (!directoryStats) {
      return;
    }

    if (!directoryStats.isDirectory()) {
      throw new Error('Backup contains unsupported file types');
    }
    if (directory === rootDirectory) await validateBackupTree(rootDirectory, options.allowSymlinks);

    const entries = await runFsOperation(() => fs.promises.readdir(directory, { withFileTypes: true }));
    const rootPath = path.resolve(rootDirectory);
    let nextEntryIndex = 0;

    const workers = Array.from({ length: Math.min(16, entries.length) }, async () => {
      while (nextEntryIndex < entries.length) {
        const entry = entries[nextEntryIndex];
        nextEntryIndex += 1;

        if (!entry) {
          continue;
        }

        const entryPath = path.join(directory, entry.name);

        if (entry.isSymbolicLink()) {
          if (!options.allowSymlinks) {
            throw new Error('Backup contains unsupported file types');
          }

          const linkTarget = await runFsOperation(() => fs.promises.readlink(entryPath));
          const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);

          if (path.isAbsolute(linkTarget) || !this.isPathInsideOrEqual(rootPath, resolvedTarget)) {
            throw new Error('Backup contains unsupported file types');
          }
          continue;
        }

        if (entry.isDirectory()) {
          await this.validateRestoreDirectory(entryPath, options, rootDirectory, runFsOperation);
          continue;
        }

        if (entry.isFile()) {
          if (options.rejectHardLinks) {
            const stats = await runFsOperation(() => fs.promises.lstat(entryPath));

            if (stats.nlink > 1) {
              throw new Error('Backup contains unsupported file types');
            }
          }

          continue;
        }

        throw new Error('Backup contains unsupported file types');
      }
    });

    await Promise.all(workers);
  }

  private isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
    const relativePath = path.relative(parentPath, childPath);

    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  /**
   * Delete a backup file
   * @param appUrn - The app id
   * @param filename - The filename of the backup
   */
  public async deleteBackup(appUrn: AppUrn, filename: string) {
    const { backupPath } = this.getBackupFilePath(appUrn, filename);

    if (await this.filesystem.pathExists(backupPath)) {
      await this.filesystem.removeFile(backupPath);
    }
  }

  /**
   * Clean up old backups based on retention policy
   * @param appUrn - The app id
   * @param maxBackups - Maximum number of backups to keep (0 means no limit)
   */
  public async cleanupOldBackups(appUrn: AppUrn, maxBackups: number) {
    if (!maxBackups) {
      return;
    }

    const backups = await this.listBackupsByAppId(appUrn);

    if (backups.length <= maxBackups) {
      return;
    }

    backups.sort((a, b) => b.date - a.date);

    const backupsToDelete = backups.slice(maxBackups);
    this.logger.info(`Cleaning up ${backupsToDelete.length} old backup(s) for ${appUrn}...`);

    await Promise.all(backupsToDelete.map((backup) => this.deleteBackup(appUrn, backup.id)));
    this.logger.info(`Cleanup completed for ${appUrn}`);
  }

  /**
   * Delete all backups for an app
   * @param appUrn - The app id
   */
  public async deleteAppBackupsByUrn(appUrn: AppUrn): Promise<void> {
    const backups = await this.listBackupsByAppId(appUrn);

    await Promise.all(backups.map((backup) => this.deleteBackup(appUrn, backup.id)));
  }

  /**
   * List the backups for an app
   * @param appUrn - The app id
   * @returns The list of backups
   */
  public async listBackupsByAppId(appUrn: AppUrn) {
    const { backupDir: backupsDir } = this.getBackupPaths(appUrn);

    if (!(await this.filesystem.isDirectory(backupsDir))) {
      return [];
    }

    try {
      const list = await this.filesystem.listFiles(backupsDir);

      const backups = await Promise.all(
        list.map(async (backup) => {
          if (backup.startsWith('.') || !backup.endsWith('.tar.gz') || sanitizeFilename(backup) !== backup) {
            return null;
          }
          const backupPath = path.join(backupsDir, backup);

          if (!(await this.filesystem.isFile(backupPath))) {
            return null;
          }

          const stats = await this.filesystem.getStats(backupPath);
          return { id: backup, size: stats.size, date: stats.mtime.getTime() };
        }),
      );

      return backups.filter((backup) => backup !== null);
    } catch (error) {
      this.logger.error(`Error listing backups for app ${appUrn}:`, error);
      return [];
    }
  }

  /**
   * Get the file path for a backup
   * @param appUrn - The app id
   * @param filename - The filename of the backup
   * @returns The backup file path
   */
  public async getBackupPath(appUrn: AppUrn, filename: string): Promise<string> {
    const { backupPath } = this.getBackupFilePath(appUrn, filename);

    if (!(await this.filesystem.isFile(backupPath))) {
      throw new Error('The backup file does not exist');
    }

    return backupPath;
  }

  private async validateUploadedArchive(appUrn: AppUrn, source: string, signal?: AbortSignal) {
    try {
      const entries = await this.archiveManager.listTarGz(source, signal);
      this.validateRestoreArchiveEntries(entries);
      const paths = new Map<string, ArchiveEntry>();
      for (const entry of entries) {
        const name = this.normalizeArchiveEntryPath(entry.path).replace(/\/$/, '');
        if (paths.has(name)) throw new Error('Duplicate archive entry');
        paths.set(name, entry);
      }
      for (const [name] of paths) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') {
          if (paths.get(parent)?.type === '-') throw new Error('An archive parent is not a directory');
          parent = path.posix.dirname(parent);
        }
      }
      for (const root of ['.', 'app', 'app-data', 'user-config']) {
        if (paths.has(root) && paths.get(root)?.type !== 'd') throw new Error('An archive root is not a directory');
      }
      const hasData = [...paths.keys()].some((name) => name === 'app-data' || name.startsWith('app-data/'));
      const configEntry = paths.get('app/config.json');
      if (!hasData || !configEntry || configEntry.type !== '-' || paths.get('app-data')?.type === '-') {
        throw new Error('Missing app data or configuration');
      }
      const config = JSON.parse(await this.archiveManager.readTarConfig(source, configEntry.path, signal));
      const parsed = appInfoSchema({ ...config, urn: appUrn });
      if (parsed instanceof type.errors || parsed.id !== extractAppUrn(appUrn).appName) throw new Error('Invalid app configuration');
    } catch (error) {
      signal?.throwIfAborted();
      this.logger.warn('Rejected an invalid uploaded backup', error instanceof Error ? error.name : 'validation error');
      throw new BadRequestException('The uploaded file is not a valid backup for this app');
    }
  }

  public async uploadBackup(appUrn: AppUrn, filename: string, sourceFile: string, signal?: AbortSignal): Promise<void> {
    const { backupDir, backupPath, sanitizedFilename } = this.getBackupFilePath(appUrn, filename);
    const source = this.filesystem.getSafeFilePath(sourceFile);
    const uploadRoot = path.join(backupDir, '.uploads');
    const directory = path.dirname(source);
    if (path.dirname(directory) !== uploadRoot || !path.basename(directory).startsWith('upload-') || path.basename(source) !== 'backup.tar.gz') {
      throw new Error('Invalid backup upload staging path');
    }
    for (const parent of [uploadRoot, directory]) {
      const stats = await fs.promises.lstat(parent);
      if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700 || stats.uid !== process.getuid?.()) {
        throw new Error('The backup upload staging directory is not private');
      }
    }
    const file = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let sibling: string | undefined;
    let linked = false;
    let publishedSource = source;
    try {
      const before = await file.stat();
      if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.() || before.nlink !== 1) {
        throw new Error('The uploaded backup is not a private regular file');
      }
      signal?.throwIfAborted();
      await this.validateUploadedArchive(appUrn, source, signal);
      const after = await fs.promises.lstat(source);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode ||
        before.uid !== after.uid ||
        before.gid !== after.gid ||
        after.nlink !== 1
      ) {
        throw new Error('The uploaded backup changed during validation');
      }
      await file.sync();
      signal?.throwIfAborted();
      try {
        await fs.promises.link(source, backupPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        sibling = await fs.promises.mkdtemp(path.join(backupDir, '.orbis-upload-'));
        publishedSource = path.join(sibling, 'backup.tar.gz');
        await fs.promises.copyFile(source, publishedSource, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(publishedSource, 0o600);
        const copy = await fs.promises.open(publishedSource, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          if ((await copy.stat()).size !== before.size) throw new Error('The uploaded backup copy is incomplete');
          await copy.sync();
        } finally {
          await copy.close();
        }
        signal?.throwIfAborted();
        await fs.promises.link(publishedSource, backupPath);
      }
      linked = true;
      const parent = await fs.promises.open(backupDir, fs.constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      signal?.throwIfAborted();
      this.logger.info(`Backup uploaded successfully: ${sanitizedFilename}`);
    } catch (error) {
      if (linked) {
        const target = await fs.promises.lstat(backupPath).catch(() => null);
        const staged = await fs.promises.lstat(publishedSource);
        if (target?.ino === staged.ino && target.dev === staged.dev) await fs.promises.unlink(backupPath);
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConflictException('A backup with this filename already exists');
      throw error;
    } finally {
      try {
        await file.close();
      } finally {
        if (sibling) await fs.promises.rm(sibling, { recursive: true, force: true });
      }
    }
  }
}
