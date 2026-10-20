import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupManager } from '../backup.manager';

describe('BackupManager real files and archives', () => {
  const appUrn = createAppUrn('demo', 'store');
  let root: string;
  let appDataDir: string;
  let appInstalledDir: string;
  let userConfigDir: string;
  let backupDir: string;
  let filesystem: FilesystemService;
  let archive: ArchiveService;
  let manager: BackupManager;

  const write = async (file: string, content: string | Buffer) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp('/tmp/orbis-backups-recovery-');
    appDataDir = path.join(root, 'app-data', 'store', 'demo');
    appInstalledDir = path.join(root, 'apps', 'store', 'demo');
    userConfigDir = path.join(root, 'data', 'user-config', 'store', 'demo');
    backupDir = path.join(root, 'data', 'backups', 'store', 'demo');
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
    filesystem = new FilesystemService(logger);
    archive = new ArchiveService(logger);
    const config = { get: () => ({ dataDir: path.join(root, 'data') }) } as unknown as ConfigurationService;
    const apps = { getAppPaths: () => ({ appDataDir, appInstalledDir }) } as unknown as AppFilesManager;
    manager = new BackupManager(archive, logger, config, filesystem, apps);
    vi.spyOn(filesystem, 'createTempDirectory').mockImplementation((prefix) => fs.promises.mkdtemp(path.join(root, path.basename(prefix))));
    await write(path.join(appDataDir, 'data', 'record'), 'original data\n');
    await write(path.join(appInstalledDir, 'docker-compose.yml'), 'services: {}\n');
    await write(path.join(userConfigDir, 'app.env'), 'SETTING=original\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('round-trips all app data, including backup-named paths, binary files and user overrides', async () => {
    const binary = Buffer.from([0, 255, 128, 10, 13, 0]);
    await write(path.join(appDataDir, 'database-backups', 'snapshot.bin'), binary);
    await write(path.join(appDataDir, 'backups', 'kept.txt'), 'application-owned backup\n');
    await write(path.join(appDataDir, '.hidden', 'space name.txt'), 'hidden file\n');
    await manager.backupApp(appUrn);
    const backups = await manager.listBackupsByAppId(appUrn);
    expect(backups).toHaveLength(1);
    const backup = backups[0];
    if (!backup) throw new Error('Expected a published backup');
    const backupPath = await manager.getBackupPath(appUrn, backup.id);
    expect((await fs.promises.stat(backupPath)).mode & 0o777).toBe(0o600);
    const entries = await archive.listTarGz(backupPath);
    expect(entries.some((entry) => entry.path.endsWith('app-data/database-backups/snapshot.bin'))).toBe(true);
    await write(path.join(appDataDir, 'data', 'record'), 'changed data\n');
    await write(path.join(userConfigDir, 'app.env'), 'SETTING=changed\n');
    await manager.restoreApp(appUrn, backup.id);
    expect(await fs.promises.readFile(path.join(appDataDir, 'database-backups', 'snapshot.bin'))).toEqual(binary);
    expect(await fs.promises.readFile(path.join(appDataDir, 'backups', 'kept.txt'), 'utf8')).toBe('application-owned backup\n');
    expect(await fs.promises.readFile(path.join(appDataDir, '.hidden', 'space name.txt'), 'utf8')).toBe('hidden file\n');
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
    expect(await fs.promises.readFile(path.join(appInstalledDir, 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
    expect(await fs.promises.readFile(path.join(userConfigDir, 'app.env'), 'utf8')).toBe('SETTING=original\n');
  });

  it.each(['data', 'app', 'user-config'])('does not publish a backup after a failed %s copy', async (group) => {
    const failedSource = { data: appDataDir, app: appInstalledDir, 'user-config': userConfigDir }[group];
    const copy = filesystem.copyDirectory.bind(filesystem);
    vi.spyOn(filesystem, 'copyDirectory').mockImplementation((source, destination, options) =>
      source === failedSource ? Promise.resolve(false) : copy(source, destination, options),
    );
    await expect(manager.backupApp(appUrn)).rejects.toThrow();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
  });

  it('does not publish an archive after tar reports a failure', async () => {
    vi.spyOn(archive, 'createTarGz').mockImplementation(async (_source, destination) => {
      await fs.promises.writeFile(destination, 'incomplete archive');
      return { stdout: '', stderr: 'No space left on device' };
    });
    await expect(manager.backupApp(appUrn)).rejects.toThrow();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('reports a failed archive publication instead of succeeding', async () => {
    vi.spyOn(filesystem, 'copyFile').mockResolvedValue(false);
    await expect(manager.backupApp(appUrn)).rejects.toThrow();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('does not list unfinished files or non-archives as backups', async () => {
    await write(path.join(backupDir, '.unfinished.partial'), 'partial data');
    await write(path.join(backupDir, 'notes.txt'), 'not a backup');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('removes a partial copy after a write failure and preserves a previous complete backup', async () => {
    await manager.backupApp(appUrn);
    const previous = await manager.listBackupsByAppId(appUrn);
    const saved = previous[0];
    if (!saved) throw new Error('Expected a previous backup');
    const original = await fs.promises.readFile(await manager.getBackupPath(appUrn, saved.id));
    vi.spyOn(filesystem, 'copyFile').mockImplementation(async (_source, destination) => {
      await fs.promises.writeFile(destination, 'partial copy');
      return false;
    });
    await expect(manager.backupApp(appUrn)).rejects.toThrow('could not be saved');
    expect((await manager.listBackupsByAppId(appUrn)).map((backup) => backup.id)).toEqual([saved.id]);
    expect(await fs.promises.readdir(backupDir)).toEqual([saved.id]);
    expect(await fs.promises.readFile(await manager.getBackupPath(appUrn, saved.id))).toEqual(original);
  });

  it('rejects an unreadable archive even when the archiver reports no error', async () => {
    vi.spyOn(archive, 'createTarGz').mockImplementation(async (_source, destination) => {
      await fs.promises.writeFile(destination, 'not a tar archive');
      return { stdout: '', stderr: '' };
    });
    await expect(manager.backupApp(appUrn)).rejects.toThrow();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(backupDir)).toEqual([]);
  });

  it('cleans staging after a successful backup and supports absent optional user overrides', async () => {
    await fs.promises.rm(userConfigDir, { recursive: true });
    const before = (await fs.promises.readdir(root)).sort();
    await manager.backupApp(appUrn);
    expect((await fs.promises.readdir(root)).sort()).toEqual(before);
    const backups = await manager.listBackupsByAppId(appUrn);
    expect(backups).toHaveLength(1);
    const saved = backups[0];
    if (!saved) throw new Error('Expected a published backup');
    await manager.restoreApp(appUrn, saved.id);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
  });

  it('rejects a broken user-configuration symlink instead of silently omitting it', async () => {
    await fs.promises.rm(userConfigDir, { recursive: true });
    await fs.promises.symlink(path.join(root, 'missing-overrides'), userConfigDir);
    await expect(manager.backupApp(appUrn)).rejects.toThrow('not a readable directory');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('keeps an in-progress copy out of the downloadable backup list', async () => {
    let copyStarted: () => void = () => {};
    let releaseCopy: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    vi.spyOn(filesystem, 'copyFile').mockImplementation(async (source, destination) => {
      await fs.promises.copyFile(source, destination);
      copyStarted();
      await released;
      return true;
    });
    const backup = manager.backupApp(appUrn);
    try {
      await started;
      expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    } finally {
      releaseCopy();
      await backup;
    }
    expect(await manager.listBackupsByAppId(appUrn)).toHaveLength(1);
  });

  it('keeps both backups when two complete in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
    await Promise.all([manager.backupApp(appUrn), manager.backupApp(appUrn)]);
    const backups = await manager.listBackupsByAppId(appUrn);
    expect(backups).toHaveLength(2);
    expect(new Set(backups.map((backup) => backup.id)).size).toBe(2);
  });
});
