import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupManager } from '../backup.manager';
import * as stableCopy from '../stable-backup-copy';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { BackupAppCommand } from '@/modules/app-lifecycle/commands/backup-app-command';
import { DockerService } from '@/modules/docker/docker.service';
import { ConfigurationService as ConfigurationToken } from '@/core/config/configuration.service';
import { LoggerService as LoggerToken } from '@/core/logger/logger.service';
import { AppsRepository as RepositoryToken } from '@/modules/apps/apps.repository';

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
  let apps: AppFilesManager;
  let repository: AppsRepository;

  const write = async (file: string, content: string | Buffer) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content);
  };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(tmpdir(), 'orbis-backups-recovery-'));
    appDataDir = path.join(root, 'app-data', 'store', 'demo');
    appInstalledDir = path.join(root, 'apps', 'store', 'demo');
    userConfigDir = path.join(root, 'data', 'user-config', 'store', 'demo');
    backupDir = path.join(root, 'data', 'backups', 'store', 'demo');
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
    filesystem = new FilesystemService(logger);
    const originalSafePath = filesystem.getSafeFilePath.bind(filesystem);
    vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((file) => {
      const resolved = path.resolve(file);
      return resolved.startsWith(root + path.sep) ? resolved : originalSafePath(file);
    });
    archive = new ArchiveService(logger);
    const config = { get: () => ({ dataDir: path.join(root, 'data') }) } as unknown as ConfigurationService;
    apps = {
      getAppPaths: () => ({ appDataDir, appInstalledDir }),
      getInstalledAppInfo: vi.fn(async () => {
        const version = await fs.promises.readFile(path.join(appInstalledDir, 'version'), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        return version === null ? null : { tipi_version: Number(version) };
      }),
    } as unknown as AppFilesManager;
    repository = {
      getAppByUrn: vi.fn().mockResolvedValue(null),
      updateAppById: vi.fn(),
      getMigrationLedger: vi.fn().mockResolvedValue({ baselined: false, migrationIds: [] }),
      replaceMigrationLedger: vi.fn(),
    } as unknown as AppsRepository;
    manager = new BackupManager(archive, logger, config, filesystem, apps, repository);
    vi.spyOn(filesystem, 'createTempDirectory').mockImplementation((prefix) => fs.promises.mkdtemp(path.join(root, path.basename(prefix))));
    await write(path.join(appDataDir, 'data', 'record'), 'original data\n');
    await write(path.join(appInstalledDir, 'docker-compose.yml'), 'services: {}\n');
    await write(path.join(userConfigDir, 'app.env'), 'SETTING=original\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('the actual manual backup command resumes before compression and archives only its consistent snapshot', async () => {
    const ledger = { baselined: true, migrationIds: ['001-schema'] };
    vi.mocked(repository.getAppByUrn).mockResolvedValue(createMockApp({ id: 42 }));
    vi.mocked(repository.getMigrationLedger).mockResolvedValue(ledger);
    const state = { Running: true, Paused: false, Restarting: false };
    const start = vi.fn(async () => {
      state.Running = true;
      await write(path.join(appDataDir, 'data/record'), 'new live writes');
      await write(path.join(userConfigDir, 'app.env'), 'SETTING=new');
    });
    const container = { id: 'original', inspect: async () => ({ State: { ...state } }), start };
    const docker = { listContainers: async () => [{ Id: 'original' }], getContainer: () => container } as unknown as Dockerode;
    const composeApp = vi.fn(async () => {
      state.Running = false;
    });
    const providers = new Map<unknown, unknown>([
      [DockerService, { composeApp }],
      [BackupManager, manager],
      [RepositoryToken, repository],
      [ConfigurationToken, { get: () => ({ maxBackups: 20 }) }],
      [LoggerToken, { info: vi.fn() }],
    ]);
    const ref = { get: (token: unknown) => providers.get(token) } as unknown as ModuleRef;
    const compress = archive.createTarGz;
    vi.spyOn(archive, 'createTarGz').mockImplementation(async (source, destination) => {
      expect(state.Running).toBe(true);
      expect(await fs.promises.readFile(path.join(source, 'app-data/data/record'), 'utf8')).toBe('original data\n');
      expect(await fs.promises.readFile(path.join(source, 'user-config/app.env'), 'utf8')).toBe('SETTING=original\n');
      const savedLedger = JSON.parse(await fs.promises.readFile(path.join(source, 'orbis-app-migrations.json'), 'utf8'));
      expect(savedLedger).toMatchObject({ ledger });
      return compress(source, destination);
    });
    expect(await new BackupAppCommand(ref, docker).execute(appUrn)).toMatchObject({ success: true, statePreserved: true });
    expect(composeApp).toHaveBeenCalledExactlyOnceWith(appUrn, 'stop');
    expect(start).toHaveBeenCalledOnce();
    expect(await fs.promises.readFile(path.join(appDataDir, 'data/record'), 'utf8')).toBe('new live writes');
    const [backup] = await manager.listBackupsByAppId(appUrn);
    expect(backup).toBeDefined();
    if (!backup) throw new Error('The completed backup was not listed.');
    await manager.restoreApp(appUrn, backup.id);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data/record'), 'utf8')).toBe('original data\n');
    expect(await fs.promises.readFile(path.join(userConfigDir, 'app.env'), 'utf8')).toBe('SETTING=original\n');
  });

  it('does not acknowledge an incomplete snapshot or compress after a failed resume callback', async () => {
    const ready = vi.fn(async () => {
      throw new Error('Original app could not resume');
    });
    const compress = vi.spyOn(archive, 'createTarGz');
    await expect(manager.backupApp(appUrn, ready)).rejects.toThrow('Original app could not resume');
    expect(compress).not.toHaveBeenCalled();
    expect(await manager.listBackupsByAppId(appUrn)).toHaveLength(0);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data/record'), 'utf8')).toBe('original data\n');
    vi.spyOn(stableCopy, 'copyStableBackupTree').mockRejectedValue(new Error('Source could not be copied'));
    ready.mockClear();
    await expect(manager.backupApp(appUrn, ready)).rejects.toThrow('Source could not be copied');
    expect(ready).not.toHaveBeenCalled();
  });

  it('replays a committed restore with its exact ledger if the first database write fails', async () => {
    const ledger = { baselined: true, migrationIds: ['001-schema'] };
    vi.mocked(repository.getAppByUrn).mockResolvedValue(createMockApp({ id: 42 }));
    vi.mocked(repository.getMigrationLedger).mockResolvedValue(ledger);
    await manager.backupApp(appUrn);
    const [backup] = await manager.listBackupsByAppId(appUrn);
    if (!backup) throw new Error('Expected a saved backup');
    await write(path.join(appDataDir, 'data', 'record'), 'changed data');
    vi.mocked(repository.replaceMigrationLedger).mockRejectedValueOnce(new Error('Database unavailable'));

    await expect(manager.restoreApp(appUrn, backup.id)).rejects.toThrow('Database unavailable');
    expect(await manager.hasPendingRestore(appUrn)).toBe(true);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');

    vi.mocked(repository.getMigrationLedger).mockResolvedValue({ baselined: true, migrationIds: ['001-schema', '002-fields'] });
    await manager.recoverRestore(appUrn);
    expect(repository.replaceMigrationLedger).toHaveBeenNthCalledWith(2, 42, ledger, { status: 'stopped' });
    expect(await manager.hasPendingRestore(appUrn)).toBe(false);
  });

  it('replays an unverified baseline with restored legacy data after a database failure', async () => {
    await write(path.join(appInstalledDir, 'migrations', '001-schema.yml'), 'services: {}\n');
    await manager.backupApp(appUrn);
    const [backup] = await manager.listBackupsByAppId(appUrn);
    if (!backup) throw new Error('Expected a saved backup');
    vi.mocked(repository.getAppByUrn).mockResolvedValue(createMockApp({ id: 42 }));
    vi.mocked(repository.getMigrationLedger).mockResolvedValue({ baselined: true, migrationIds: [] });
    vi.mocked(repository.replaceMigrationLedger).mockRejectedValueOnce(new Error('Database unavailable'));
    await write(path.join(appDataDir, 'data', 'record'), 'new data');

    await expect(manager.restoreApp(appUrn, backup.id)).rejects.toThrow('Database unavailable');
    expect(await manager.hasPendingRestore(appUrn)).toBe(true);
    expect(await fs.promises.readFile(path.join(appInstalledDir, 'migrations', '001-schema.yml'), 'utf8')).toBe('services: {}\n');
    await manager.recoverRestore(appUrn);
    expect(repository.replaceMigrationLedger).toHaveBeenNthCalledWith(2, 42, { baselined: false, migrationIds: [] }, { status: 'stopped' });
    expect(await manager.hasPendingRestore(appUrn)).toBe(false);
  });

  it('preserves live files if a legacy backup cannot establish the destination migration history', async () => {
    await manager.backupApp(appUrn);
    const [backup] = await manager.listBackupsByAppId(appUrn);
    if (!backup) throw new Error('Expected a saved backup');

    vi.mocked(repository.getAppByUrn).mockResolvedValue(createMockApp({ id: 42 }));
    vi.mocked(repository.getMigrationLedger).mockResolvedValue({ baselined: true, migrationIds: ['001-schema'] });
    await write(path.join(appDataDir, 'data', 'record'), 'live data');
    await expect(manager.restoreApp(appUrn, backup.id)).rejects.toThrow('predates the application migration history');
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('live data');
    expect(repository.replaceMigrationLedger).not.toHaveBeenCalled();
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

  it('round-trips application log symlinks, their targets and metadata without following them', async () => {
    const logs = path.join(appDataDir, 'data', 'logs');
    await write(path.join(logs, 'dated log.log'), 'original log\n');
    const latest = path.join(logs, 'latest.log');
    await fs.promises.symlink('dated log.log', latest);
    const before = await fs.promises.lstat(latest, { bigint: true });
    await manager.backupApp(appUrn);
    const [saved] = await manager.listBackupsByAppId(appUrn);
    if (!saved) throw new Error('Expected a complete backup');
    const entries = await archive.listTarGz(await manager.getBackupPath(appUrn, saved.id));
    expect(entries).toContainEqual({ path: './app-data/data/logs/latest.log', type: 'l', linkTarget: 'dated log.log' });
    await fs.promises.unlink(latest);
    await write(path.join(logs, 'dated log.log'), 'changed log\n');
    await manager.restoreApp(appUrn, saved.id);
    expect(await fs.promises.readlink(latest)).toBe('dated log.log');
    expect(await fs.promises.readFile(latest, 'utf8')).toBe('original log\n');
    const after = await fs.promises.lstat(latest, { bigint: true });
    expect({ uid: after.uid, gid: after.gid, mode: after.mode, mtime: after.mtimeNs }).toEqual({
      uid: before.uid,
      gid: before.gid,
      mode: before.mode,
      mtime: before.mtimeNs,
    });
  });

  it.each([false, true])('round-trips container links in all app trees without touching external targets, cross-device=%s', async (crossDevice) => {
    const outside = path.join(root, 'outside');
    await write(outside, 'untouched external data');
    const before = await fs.promises.lstat(outside, { bigint: true });
    const metadata = async (file: string) => {
      const value = await fs.promises.lstat(file, { bigint: true });
      return { uid: value.uid, gid: value.gid, mode: value.mode, modified: value.mtimeNs };
    };
    const links = [];
    for (const directory of [appDataDir, appInstalledDir, userConfigDir]) {
      for (const [name, target] of Object.entries({
        absolute: '/container/config.yaml',
        external: outside,
        relative: path.relative(directory, outside),
        dangling: 'not-created',
        cycleA: 'cycleB',
        cycleB: 'cycleA',
      })) {
        const file = path.join(directory, name);
        await fs.promises.symlink(target, file);
        links.push({ file, target, attributes: await metadata(file) });
      }
    }
    await manager.backupApp(appUrn);
    const [saved] = await manager.listBackupsByAppId(appUrn);
    if (!saved) throw new Error('Expected a complete backup');
    const entries = await archive.listTarGz(await manager.getBackupPath(appUrn, saved.id));
    expect(entries.filter((entry) => entry.type === 'l')).toHaveLength(links.length);
    for (const { file } of links) {
      await fs.promises.unlink(file);
      await write(file, 'later app data');
    }
    let crossed = 0;
    if (crossDevice) {
      const rename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        if (String(from).includes('/extracted/') && String(to).endsWith('/incoming')) {
          crossed++;
          throw Object.assign(new Error('Cross-device staging'), { code: 'EXDEV' });
        }
        return rename(from, to);
      });
    }
    await manager.restoreApp(appUrn, saved.id);
    expect(crossed).toBe(crossDevice ? 3 : 0);
    for (const { file, target, attributes } of links) {
      expect(await fs.promises.readlink(file)).toBe(target);
      expect(await metadata(file)).toEqual(attributes);
    }
    const after = await fs.promises.lstat(outside, { bigint: true });
    expect([after.ino, after.mode, after.mtimeNs, after.ctimeNs, after.atimeNs]).toEqual([
      before.ino,
      before.mode,
      before.mtimeNs,
      before.ctimeNs,
      before.atimeNs,
    ]);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('untouched external data');
  });

  it('preserves subsecond file and directory timestamps through backup and restore', async () => {
    const file = path.join(appDataDir, 'data', 'record');
    const directory = path.dirname(file);
    await fs.promises.chmod(file, 0o640);
    await fs.promises.utimes(file, 1700000000.123456, 1700000000.654321);
    await fs.promises.chmod(directory, 0o750);
    await fs.promises.utimes(directory, 1700000010.123456, 1700000010.654321);
    const metadata = async (target: string) => {
      const value = await fs.promises.stat(target, { bigint: true });
      return { uid: value.uid, gid: value.gid, mode: value.mode & 0o7777n, mtime: value.mtimeNs };
    };
    const before = [await metadata(file), await metadata(directory)] as const;
    expect(before[0].mtime % 1000000n).not.toBe(0n);
    await manager.backupApp(appUrn);
    const [saved] = await manager.listBackupsByAppId(appUrn);
    if (!saved) throw new Error('Expected a saved backup');
    await write(file, 'newer live data');
    await fs.promises.chmod(file, 0o600);
    await fs.promises.utimes(directory, 1800000000, 1800000000);
    await manager.restoreApp(appUrn, saved.id);
    expect([await metadata(file), await metadata(directory)]).toEqual(before);
    expect(await fs.promises.readFile(file, 'utf8')).toBe('original data\n');
  });

  const savedBackupWithNewerLiveFiles = async () => {
    await manager.backupApp(appUrn);
    const [saved] = await manager.listBackupsByAppId(appUrn);
    if (!saved) throw new Error('Expected a saved backup');
    await write(path.join(appDataDir, 'data', 'record'), 'newer live data\n');
    await write(path.join(appInstalledDir, 'docker-compose.yml'), 'newer live app\n');
    await write(path.join(userConfigDir, 'app.env'), 'SETTING=newer\n');
    return saved;
  };

  const expectNewerLiveFiles = async () => {
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('newer live data\n');
    expect(await fs.promises.readFile(path.join(appInstalledDir, 'docker-compose.yml'), 'utf8')).toBe('newer live app\n');
    expect(await fs.promises.readFile(path.join(userConfigDir, 'app.env'), 'utf8')).toBe('SETTING=newer\n');
  };

  it('keeps a completed backup successful and retries failed snapshot cleanup on startup', async () => {
    const remove = fs.promises.rm.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (!failed && path.basename(String(file)).startsWith(`${appUrn}-`)) {
        failed = true;
        throw new Error('Cleanup storage unavailable');
      }
      await remove(file, options);
    });
    await manager.backupApp(appUrn);
    expect(failed).toBe(true);
    const [saved] = await manager.listBackupsByAppId(appUrn);
    expect(saved).toBeDefined();
    const records = path.join(root, 'data/state/backup-staging-cleanup');
    expect(await fs.promises.readdir(records)).toHaveLength(1);
    await manager.onModuleInit();
    expect(await fs.promises.readdir(records)).toEqual([]);
    expect((await manager.listBackupsByAppId(appUrn)).map((entry) => entry.id)).toEqual([saved?.id]);
  });

  it('preserves the capture error when disposing the incomplete snapshot also fails', async () => {
    vi.spyOn(archive, 'createTarGz').mockRejectedValue(new Error('Original archive failure'));
    const remove = fs.promises.rm.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (!failed && path.basename(String(file)).startsWith(`${appUrn}-`)) {
        failed = true;
        throw new Error('Secondary cleanup failure');
      }
      await remove(file, options);
    });
    await expect(manager.backupApp(appUrn)).rejects.toThrow('Original archive failure');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    await manager.onModuleInit();
    expect(await fs.promises.readdir(path.join(root, 'data/state/backup-staging-cleanup'))).toEqual([]);
  });

  it.each([false, true])('preserves the restore outcome while retrying private archive cleanup, extraction failure=%s', async (failExtract) => {
    const saved = await savedBackupWithNewerLiveFiles();
    if (failExtract) vi.spyOn(archive, 'extractTarGz').mockResolvedValue({ stdout: '', stderr: 'Fixture extraction failure' });
    const remove = fs.promises.rm.bind(fs.promises);
    let retained: string | undefined;
    const failure = vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (!retained && path.basename(String(file)).startsWith(`${appUrn}-restore-`)) {
        retained = await fs.promises.realpath(file);
        throw new Error('Secondary archive cleanup failure');
      }
      await remove(file, options);
    });
    try {
      if (failExtract) {
        await expect(manager.restoreApp(appUrn, saved.id)).rejects.toThrow('could not be extracted completely');
        await expectNewerLiveFiles();
      } else {
        await manager.restoreApp(appUrn, saved.id);
        expect(await fs.promises.readFile(path.join(appDataDir, 'data/record'), 'utf8')).toBe('original data\n');
      }
      expect(retained).toBeDefined();
      expect(await manager.hasPendingRestore(appUrn)).toBe(false);
      await manager.onModuleInit();
      expect(retained && fs.existsSync(retained)).toBe(false);
    } finally {
      failure.mockRestore();
      if (retained) await remove(retained, { recursive: true, force: true });
    }
  });

  it('keeps a prior archive and the original save error when failed partial cleanup needs startup retry', async () => {
    await manager.backupApp(appUrn);
    const before = await manager.listBackupsByAppId(appUrn);
    vi.spyOn(filesystem, 'copyFile').mockImplementation(async (_source, destination) => {
      await fs.promises.writeFile(destination, 'incomplete fixture', { mode: 0o600 });
      return false;
    });
    const remove = fs.promises.rm.bind(fs.promises);
    let failed = false;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (!failed && String(file).endsWith('.partial')) {
        failed = true;
        throw new Error('Partial cleanup failure');
      }
      await remove(file, options);
    });
    await expect(manager.backupApp(appUrn)).rejects.toThrow('could not be saved');
    expect((await manager.listBackupsByAppId(appUrn)).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
    await manager.onModuleInit();
    expect(await fs.promises.readdir(backupDir)).toEqual(before.map((entry) => entry.id));
  });

  it('lists and extracts the same private archive even if the public archive is replaced after listing', async () => {
    const saved = await savedBackupWithNewerLiveFiles();
    const publicArchive = await manager.getBackupPath(appUrn, saved.id);
    const list = archive.listTarGz.bind(archive);
    let checkedArchive: string | undefined;
    let stagingMode: number | undefined;
    vi.spyOn(archive, 'listTarGz').mockImplementation(async (file, signal) => {
      checkedArchive = file;
      stagingMode = (await fs.promises.stat(path.dirname(file))).mode & 0o777;
      const result = await list(file, signal);
      await fs.promises.rename(publicArchive, `${publicArchive}.retained`);
      await fs.promises.writeFile(publicArchive, 'replacement, not the checked archive');
      return result;
    });
    const extract = vi.spyOn(archive, 'extractTarGz');
    await manager.restoreApp(appUrn, saved.id);
    expect(checkedArchive).not.toBe(publicArchive);
    expect(stagingMode).toBe(0o700);
    expect(extract.mock.calls[0]?.[0]).toBe(checkedArchive);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data/record'), 'utf8')).toBe('original data\n');
    expect(checkedArchive && fs.existsSync(path.dirname(checkedArchive))).toBe(false);
    expect(await fs.promises.readFile(publicArchive, 'utf8')).toBe('replacement, not the checked archive');
  });

  it('does not acknowledge or publish a snapshot when a source file changes during the actual copy', async () => {
    const open = fs.promises.open.bind(fs.promises);
    const watched = path.join(appDataDir, 'data/record');
    const original = await fs.promises.lstat(watched, { bigint: true });
    let replaced = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const entry = await handle.stat({ bigint: true });
      if (!replaced && entry.isFile() && entry.dev === original.dev && entry.ino === original.ino) {
        replaced = true;
        await fs.promises.writeFile(watched, 'changed during snapshot');
      }
      return handle;
    });
    const ready = vi.fn();
    const compress = vi.spyOn(archive, 'createTarGz');
    await expect(manager.backupApp(appUrn, ready)).rejects.toThrow('changed');
    expect(replaced).toBe(true);
    expect(ready).not.toHaveBeenCalled();
    expect(compress).not.toHaveBeenCalled();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it.each(['app-data', 'app', 'user-config'])('preserves all live directories when the restored %s copy fails', async (group) => {
    const saved = await savedBackupWithNewerLiveFiles();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).endsWith(`/extracted/${group}`) && String(destination).endsWith('/incoming'))
        throw Object.assign(new Error('Cross-device restore staging'), { code: 'EXDEV' });
      await rename(source, destination);
    });
    const copy = filesystem.copyDirectory.bind(filesystem);
    vi.spyOn(filesystem, 'copyDirectory').mockImplementation((source, destination, options) =>
      source.endsWith(`/${group}`) ? Promise.resolve(false) : copy(source, destination, options),
    );
    await expect(manager.restoreApp(appUrn, saved.id)).rejects.toThrow();
    await expectNewerLiveFiles();
    expect((await manager.listBackupsByAppId(appUrn)).map((backup) => backup.id)).toEqual([saved.id]);
  });

  it('moves extracted files into same-filesystem staging without copying the app data a second time', async () => {
    const saved = await savedBackupWithNewerLiveFiles();
    const copy = vi.spyOn(filesystem, 'copyDirectory');
    await manager.restoreApp(appUrn, saved.id);
    expect(copy).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
    expect(await manager.getPendingRestores()).toEqual([]);
  });

  it('copies and commits the full restored directories when staging crosses a filesystem boundary', async () => {
    const saved = await savedBackupWithNewerLiveFiles();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (String(source).includes('/extracted/') && String(destination).endsWith('/incoming'))
        throw Object.assign(new Error('Cross-device restore staging'), { code: 'EXDEV' });
      await rename(source, destination);
    });
    const copy = vi.spyOn(filesystem, 'copyDirectory');
    await manager.restoreApp(appUrn, saved.id);
    expect(copy).toHaveBeenCalledTimes(3);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
    expect(await fs.promises.readFile(path.join(appInstalledDir, 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
    expect(await fs.promises.readFile(path.join(userConfigDir, 'app.env'), 'utf8')).toBe('SETTING=original\n');
    expect(await manager.getPendingRestores()).toEqual([]);
  });

  it('rejects extraction errors even when the extracted directories look complete', async () => {
    const saved = await savedBackupWithNewerLiveFiles();
    const extract = archive.extractTarGz.bind(archive);
    vi.spyOn(archive, 'extractTarGz').mockImplementation(async (source, destination) => {
      await extract(source, destination);
      return { stdout: '', stderr: 'No space left on device' };
    });
    await expect(manager.restoreApp(appUrn, saved.id)).rejects.toThrow();
    await expectNewerLiveFiles();
  });

  it('reconciles restored version and stopped status before removing the committed recovery journal', async () => {
    await write(path.join(appInstalledDir, 'version'), '7');
    const saved = await savedBackupWithNewerLiveFiles();
    await write(path.join(appInstalledDir, 'version'), '8');
    vi.mocked(repository.getAppByUrn).mockResolvedValue({ id: 42 } as never);
    vi.mocked(repository.replaceMigrationLedger).mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(manager.restoreApp(appUrn, saved.id)).rejects.toThrow('Database unavailable');
    expect(await manager.getPendingRestores()).toEqual([appUrn]);
    expect(await fs.promises.readFile(path.join(appInstalledDir, 'version'), 'utf8')).toBe('7');
    expect(repository.replaceMigrationLedger).toHaveBeenCalledExactlyOnceWith(
      42,
      { baselined: false, migrationIds: [] },
      { status: 'stopped', version: 7 },
    );
    await manager.recoverRestore(appUrn);
    expect(repository.replaceMigrationLedger).toHaveBeenNthCalledWith(
      2,
      42,
      { baselined: false, migrationIds: [] },
      { status: 'stopped', version: 7 },
    );
    expect(await manager.getPendingRestores()).toEqual([]);
    expect(await fs.promises.readFile(path.join(appDataDir, 'data', 'record'), 'utf8')).toBe('original data\n');
  });

  it.each(['missing.tar.gz', '../outside.tar.gz'])('does not leak extraction staging for unavailable backup %s', async (filename) => {
    const before = (await fs.promises.readdir(root)).sort();
    await expect(manager.restoreApp(appUrn, filename)).rejects.toThrow();
    expect((await fs.promises.readdir(root)).sort()).toEqual(before);
  });

  it.each(['data', 'app', 'user-config'])('does not publish a backup after a failed %s copy', async (group) => {
    const failedSource = { data: appDataDir, app: appInstalledDir, 'user-config': userConfigDir }[group];
    const copy = stableCopy.copyStableBackupTree;
    vi.spyOn(stableCopy, 'copyStableBackupTree').mockImplementation((source, destination, options) =>
      source === failedSource ? Promise.reject(new Error('Source copy failed')) : copy(source, destination, options),
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
      await fs.promises.writeFile(destination, 'partial copy', { mode: 0o600 });
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
