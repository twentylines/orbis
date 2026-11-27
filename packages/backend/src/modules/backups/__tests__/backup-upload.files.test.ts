import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import type { AppsService } from '@/modules/apps/apps.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupManager } from '../backup.manager';
import { BackupUploadStorage, type BackupUploadFile } from '../backup-upload.storage';

describe('Streamed backup uploads with real files and archives', () => {
  const appUrn = createAppUrn('demo', 'store');
  let root: string;
  let storage: BackupUploadStorage;
  let archive: ArchiveService;
  let manager: BackupManager;
  let filesystem: FilesystemService;
  let backups: string;
  let incoming: string;
  let logger: LoggerService;
  let repository: AppsRepository;
  let newManager: () => BackupManager;
  const config = {
    id: 'demo',
    available: true,
    name: 'Demo',
    tipi_version: 1,
    short_desc: 'Test app',
    author: 'Orbis',
    source: 'https://example.test',
  };

  const request = (urn = appUrn) => Object.assign(new EventEmitter(), { params: { urn }, aborted: false }) as unknown as Request;
  const receive = (stream: Readable, req = request()) =>
    new Promise<BackupUploadFile>((resolve, reject) => {
      storage._handleFile(req, { stream }, (error, info) => {
        if (error) reject(error);
        else resolve({ originalname: 'legacy.tar.gz', mimetype: 'application/gzip', ...info } as BackupUploadFile);
      });
    });
  const uploaded = () => receive(fs.createReadStream(incoming));
  const publish = async (file: BackupUploadFile, name = 'legacy.tar.gz', signal?: AbortSignal) => {
    try {
      await manager.uploadBackup(appUrn, name, file.path, signal);
    } finally {
      await storage.remove(file);
    }
  };

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(tmpdir(), 'orbis-upload-files-'));
    backups = path.join(root, 'data/backups/store/demo');
    storage = new BackupUploadStorage(path.join(root, 'data/backups'));
    logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
    filesystem = new FilesystemService(logger);
    const originalSafePath = filesystem.getSafeFilePath.bind(filesystem);
    vi.spyOn(filesystem, 'getSafeFilePath').mockImplementation((file) => {
      const resolved = path.resolve(file);
      return resolved.startsWith(root + path.sep) ? resolved : originalSafePath(file);
    });
    archive = new ArchiveService(logger);
    const appDataDir = path.join(root, 'app-data/store/demo');
    const appInstalledDir = path.join(root, 'apps/store/demo');
    const apps = {
      getAppPaths: () => ({ appDataDir, appInstalledDir }),
      getInstalledAppInfo: async () => JSON.parse(await fs.promises.readFile(path.join(appInstalledDir, 'config.json'), 'utf8')),
    } as unknown as AppFilesManager;
    repository = {
      getAppByUrn: vi.fn().mockResolvedValue({ id: 1 }),
      updateAppById: vi.fn(),
      getMigrationLedger: vi.fn().mockResolvedValue({ baselined: false, migrationIds: [] }),
      replaceMigrationLedger: vi.fn(),
    } as unknown as AppsRepository;
    const configuration = { get: () => ({ dataDir: path.join(root, 'data') }) } as unknown as ConfigurationService;
    newManager = () => new BackupManager(archive, logger, configuration, filesystem, apps, repository);
    manager = newManager();
    const source = path.join(root, 'source');
    for (const directory of ['app-data', 'app', 'user-config']) await fs.promises.mkdir(path.join(source, directory), { recursive: true });
    await fs.promises.writeFile(path.join(source, 'app/config.json'), JSON.stringify(config));
    await fs.promises.writeFile(path.join(source, 'app/docker-compose.yml'), 'services: {}\n');
    await fs.promises.writeFile(path.join(source, 'app-data/binary.bin'), Buffer.from([0, 255, 128, 0]));
    await fs.promises.writeFile(path.join(source, 'user-config/app.env'), 'SETTING=archived\n');
    incoming = path.join(root, 'incoming.tar.gz');
    const result = await archive.createTarGz(source, incoming);
    expect(result.stderr).toBe('');
    for (const directory of [appDataDir, appInstalledDir]) await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(appDataDir, 'newer-data'), 'newer');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('privately streams, validates and publishes a byte-identical legacy archive that restores successfully', async () => {
    const file = await uploaded();
    expect(file).not.toHaveProperty('buffer');
    expect((await fs.promises.stat(file.path)).mode & 0o777).toBe(0o600);
    expect((await fs.promises.stat(file.destination)).mode & 0o777).toBe(0o700);
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    const sourceStat = await fs.promises.stat(file.path);
    await publish(file);
    const target = path.join(backups, 'legacy.tar.gz');
    expect(await fs.promises.readFile(target)).toEqual(await fs.promises.readFile(incoming));
    expect((await fs.promises.stat(target)).mode & 0o777).toBe(0o600);
    expect((await fs.promises.stat(target)).ino).toBe(sourceStat.ino);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
    await manager.restoreApp(appUrn, 'legacy.tar.gz');
    expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/binary.bin'))).toEqual(Buffer.from([0, 255, 128, 0]));
    expect(await fs.promises.readFile(path.join(root, 'data/user-config/store/demo/app.env'), 'utf8')).toBe('SETTING=archived\n');
    expect(fs.existsSync(path.join(root, 'app-data/store/demo/newer-data'))).toBe(false);
  });

  it.each([
    { initialized: true, migrationIds: ['rename-data-v2', 'repair.index'] },
    { initialized: true, migrationIds: [] },
    { initialized: false, migrationIds: [] },
  ])('restores the exact Runtipi v4.12 migration state with data (%j)', async ({ initialized, migrationIds }) => {
    const source = path.join(root, 'source');
    await fs.promises.writeFile(path.join(source, 'runtipi-migrations.json'), JSON.stringify({ version: 1, initialized, migrationIds }));
    await archive.createTarGz(source, incoming);
    vi.mocked(repository.getMigrationLedger).mockResolvedValue({ baselined: true, migrationIds: ['newer-ledger'] });
    await publish(await uploaded());
    expect(await fs.promises.readFile(path.join(backups, 'legacy.tar.gz'))).toEqual(await fs.promises.readFile(incoming));
    await manager.restoreApp(appUrn, 'legacy.tar.gz');
    expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/binary.bin'))).toEqual(Buffer.from([0, 255, 128, 0]));
    expect(repository.replaceMigrationLedger).toHaveBeenCalledExactlyOnceWith(
      1,
      { baselined: initialized, migrationIds },
      { status: 'stopped', version: 1 },
    );
  });

  it.each([
    ['uninitialized history', { version: 1, initialized: false, migrationIds: ['rename-data-v2'] }],
    ['unknown version', { version: 2, initialized: true, migrationIds: [] }],
    ['duplicate IDs', { version: 1, initialized: true, migrationIds: ['rename-data-v2', 'rename-data-v2'] }],
    ['oversized manifest', { version: 1, initialized: true, migrationIds: ['x'.repeat(48 * 1024)] }],
  ])('rejects invalid Runtipi v4.12 metadata (%s) before upload or restore', async (_problem, ledger) => {
    const source = path.join(root, 'source');
    await fs.promises.writeFile(path.join(source, 'runtipi-migrations.json'), JSON.stringify(ledger));
    await archive.createTarGz(source, incoming);
    await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    await fs.promises.copyFile(incoming, path.join(backups, 'retained.tar.gz'));
    await expect(manager.restoreApp(appUrn, 'retained.tar.gz')).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/newer-data'), 'utf8')).toBe('newer');
    expect(repository.replaceMigrationLedger).not.toHaveBeenCalled();
  });

  it('rejects competing ledger formats and prevents applying Runtipi history to a different app', async () => {
    const source = path.join(root, 'source');
    const orbis = path.join(source, 'orbis-app-migrations.json');
    await fs.promises.writeFile(path.join(source, 'runtipi-migrations.json'), '{"version":1,"initialized":true,"migrationIds":["rename-data-v2"]}');
    await fs.promises.writeFile(orbis, JSON.stringify({ version: 1, appUrn, ledger: { baselined: true, migrationIds: [] } }));
    await archive.createTarGz(source, incoming);
    await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
    await fs.promises.copyFile(incoming, path.join(backups, 'conflicting.tar.gz'));
    await expect(manager.restoreApp(appUrn, 'conflicting.tar.gz')).rejects.toThrow('conflicting application migration ledgers');
    await fs.promises.rm(orbis);
    await fs.promises.writeFile(path.join(source, 'app/config.json'), JSON.stringify({ ...config, id: 'different-app' }));
    await archive.createTarGz(source, incoming);
    await fs.promises.copyFile(incoming, path.join(backups, 'unrelated.tar.gz'));
    await expect(manager.restoreApp(appUrn, 'unrelated.tar.gz')).rejects.toThrow('Invalid app configuration');
    expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/newer-data'), 'utf8')).toBe('newer');
    expect(repository.replaceMigrationLedger).not.toHaveBeenCalled();
  });

  it('validates, publishes and restores inert container links in every archive tree without touching their targets', async () => {
    const outside = path.join(root, 'outside');
    await fs.promises.writeFile(outside, 'external fixture', { mode: 0o600 });
    const links = [];
    for (const group of ['app-data', 'app', 'user-config']) {
      for (const [name, target] of Object.entries({ absolute: '/container/config.yaml', external: outside, dangling: 'not-created', loop: 'loop' })) {
        await fs.promises.symlink(target, path.join(root, 'source', group, name));
        links.push({ group, name, target });
      }
    }
    await archive.createTarGz(path.join(root, 'source'), incoming);
    const before = await fs.promises.lstat(outside, { bigint: true });
    await publish(await uploaded());
    const target = path.join(backups, 'legacy.tar.gz');
    expect(await fs.promises.readFile(target)).toEqual(await fs.promises.readFile(incoming));
    await manager.restoreApp(appUrn, 'legacy.tar.gz');
    const groups = { 'app-data': 'app-data/store/demo', app: 'apps/store/demo', 'user-config': 'data/user-config/store/demo' };
    for (const { group, name, target } of links) {
      expect(await fs.promises.readlink(path.join(root, groups[group as keyof typeof groups], name))).toBe(target);
    }
    const after = await fs.promises.lstat(outside, { bigint: true });
    expect([after.ino, after.mode, after.mtimeNs, after.ctimeNs, after.atimeNs]).toEqual([
      before.ino,
      before.mode,
      before.mtimeNs,
      before.ctimeNs,
      before.atimeNs,
    ]);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('external fixture');
  });

  it.each(['app.env', 'docker-compose.yml'])('refuses to edit a restored %s link without changing its external target', async (name) => {
    const outside = path.join(root, 'external-config');
    await fs.promises.writeFile(outside, 'external fixture', { mode: 0o600 });
    const link = path.join(root, 'source/user-config', name);
    await fs.promises.rm(link, { force: true });
    await fs.promises.symlink(outside, link);
    await archive.createTarGz(path.join(root, 'source'), incoming);
    await publish(await uploaded());
    await manager.restoreApp(appUrn, 'legacy.tar.gz');
    const directory = path.join(root, 'data/user-config/store/demo');
    const installed = path.join(directory, name);
    expect(await fs.promises.readlink(installed)).toBe(outside);
    const files = {
      getUserComposeFile: async () => ({ path: path.join(directory, 'docker-compose.yml'), content: null }),
      getUserEnv: async () => ({ path: path.join(directory, 'app.env'), content: null }),
    } as unknown as AppFilesManager;
    const service = new UserConfigService(files, {} as AppsRepository, {} as AppsService, filesystem);
    const before = await fs.promises.lstat(outside, { bigint: true });
    await expect(service.updateUserConfig(appUrn, { dockerCompose: 'services: {}', appEnv: 'SETTING=updated' })).rejects.toThrow(
      'could not be saved',
    );
    const after = await fs.promises.lstat(outside, { bigint: true });
    expect([after.ino, after.mode, after.mtimeNs, after.ctimeNs, after.atimeNs]).toEqual([
      before.ino,
      before.mode,
      before.mtimeNs,
      before.ctimeNs,
      before.atimeNs,
    ]);
    expect(await fs.promises.readFile(outside, 'utf8')).toBe('external fixture');
    expect(await fs.promises.readlink(installed)).toBe(outside);
  });

  it('still saves ordinary user configuration as private regular files', async () => {
    const directory = path.join(root, 'data/user-config/store/demo');
    const files = {
      getUserComposeFile: async () => ({ path: path.join(directory, 'docker-compose.yml'), content: null }),
      getUserEnv: async () => ({ path: path.join(directory, 'app.env'), content: null }),
    } as unknown as AppFilesManager;
    const service = new UserConfigService(files, {} as AppsRepository, {} as AppsService, filesystem);
    await service.updateUserConfig(appUrn, { dockerCompose: 'services: {}', appEnv: 'SETTING=updated' });
    for (const [name, contents] of [
      ['docker-compose.yml', 'services: {}'],
      ['app.env', 'SETTING=updated'],
    ]) {
      const file = path.join(directory, name ?? '');
      expect(await fs.promises.readFile(file, 'utf8')).toBe(`${contents}\n`);
      expect((await fs.promises.lstat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(['link-first', 'child-first', 'parent-traversal', 'root-link', 'hardlink', 'duplicate'])(
    'rejects a crafted %s archive before any restore extraction',
    async (fault) => {
      const entry = (name: string, kind: string, content = '', target = '') => {
        const bytes = Buffer.from(content);
        const block = Buffer.alloc(512);
        block.write(name, 0, 100);
        block.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12);
        block.fill(32, 148, 156);
        block.write(kind, 156);
        block.write(target, 157, 100);
        block.write('ustar\0', 257);
        const sum = block.reduce((total, byte) => total + byte, 0);
        block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
        return Buffer.concat([block, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
      };
      const link = entry('app-data/redirect', '2', '', '/outside');
      const child = entry('app-data/redirect/overwrite', '0', 'must not be extracted');
      const bad =
        fault === 'link-first'
          ? [link, child]
          : fault === 'child-first'
            ? [child, link]
            : fault === 'parent-traversal'
              ? [link, entry('app-data/redirect/../overwrite', '0', 'must not be extracted')]
              : fault === 'root-link'
                ? [entry('user-config', '2', '', '/outside')]
                : fault === 'hardlink'
                  ? [entry('app-data/hard', '1', '', '/outside')]
                  : [entry('app-data/duplicate', '0', 'first'), entry('./app-data/duplicate', '0', 'second')];
      await fs.promises.writeFile(
        incoming,
        gzipSync(
          Buffer.concat([
            entry('app-data', '5'),
            entry('app', '5'),
            entry('app/config.json', '0', JSON.stringify(config)),
            ...bad,
            Buffer.alloc(1024),
          ]),
        ),
      );
      const extract = vi.spyOn(archive, 'extractTarGz');
      await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
      expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
      await fs.promises.mkdir(backups, { recursive: true });
      await fs.promises.copyFile(incoming, path.join(backups, 'rejected.tar.gz'));
      await expect(manager.restoreApp(appUrn, 'rejected.tar.gz')).rejects.toThrow('unsupported file types');
      expect(extract).not.toHaveBeenCalled();
      expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/newer-data'), 'utf8')).toBe('newer');
    },
  );

  it('rejects the previously accepted corrupt archive before publication and removes its staging', async () => {
    await fs.promises.writeFile(incoming, 'not a gzip archive');
    await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it.each(['missing-config', 'wrong-app', 'oversized-config', 'bad-json', 'data-root-file', 'missing-data'])(
    'rejects structurally invalid %s uploads without changing live data',
    async (problem) => {
      const source = path.join(root, 'source');
      if (problem === 'missing-config') await fs.promises.rm(path.join(source, 'app/config.json'));
      if (problem === 'wrong-app') await fs.promises.writeFile(path.join(source, 'app/config.json'), JSON.stringify({ ...config, id: 'unrelated' }));
      if (problem === 'oversized-config') await fs.promises.writeFile(path.join(source, 'app/config.json'), 'x'.repeat(1024 * 1024 + 1));
      if (problem === 'bad-json') await fs.promises.writeFile(path.join(source, 'app/config.json'), '{not json}');
      if (problem === 'missing-data') await fs.promises.rm(path.join(source, 'app-data'), { recursive: true });
      if (problem === 'data-root-file') {
        await fs.promises.rm(path.join(source, 'app-data'), { recursive: true });
        await fs.promises.writeFile(path.join(source, 'app-data'), 'not a directory');
      }
      await archive.createTarGz(source, incoming);
      await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
      expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
      expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/newer-data'), 'utf8')).toBe('newer');
      expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
    },
  );

  it('accepts legacy uncompressed tar backups using the existing tar.gz filename convention', async () => {
    execFileSync('tar', ['-cf', incoming, '-C', path.join(root, 'source'), '.']);
    await publish(await uploaded());
    await manager.restoreApp(appUrn, 'legacy.tar.gz');
    expect(await fs.promises.readFile(path.join(root, 'app-data/store/demo/binary.bin'))).toEqual(Buffer.from([0, 255, 128, 0]));
  });

  it('rejects duplicate configuration entries, including paths with different dot prefixes', async () => {
    execFileSync('tar', ['-cf', incoming, '-C', path.join(root, 'source'), '.']);
    execFileSync('tar', ['-rf', incoming, '-C', path.join(root, 'source'), 'app/config.json']);
    await expect(publish(await uploaded())).rejects.toThrow('not a valid backup');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('rejects a staged file whose permissions change during validation', async () => {
    const read = archive.readTarConfig.bind(archive);
    vi.spyOn(archive, 'readTarConfig').mockImplementation(async (source, entry, signal) => {
      const value = await read(source, entry, signal);
      await fs.promises.chmod(source, 0o644);
      return value;
    });
    await expect(publish(await uploaded())).rejects.toThrow('changed during validation');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it('publishes only one of two concurrent uploads with the same filename and preserves its bytes', async () => {
    const files = await Promise.all([uploaded(), uploaded()]);
    const results = await Promise.allSettled(files.map((file) => publish(file)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(backups, 'legacy.tar.gz'))).toEqual(await fs.promises.readFile(incoming));
    expect(await manager.listBackupsByAppId(appUrn)).toHaveLength(1);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('reports a publication failure without a visible backup or leftover private file', async () => {
    vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('Storage unavailable'), { code: 'EIO' }));
    await expect(publish(await uploaded())).rejects.toThrow('Storage unavailable');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('rolls back its own new link when directory persistence fails', async () => {
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === backups) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('Directory persistence failed'));
      return handle;
    });
    await expect(publish(await uploaded())).rejects.toThrow('Directory persistence failed');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('copies across a device boundary only when linking cannot cross it', async () => {
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation((source, target) => {
      if (String(source).includes('/.uploads/')) return Promise.reject(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }));
      return link(source, target);
    });
    await publish(await uploaded());
    expect(await fs.promises.readFile(path.join(backups, 'legacy.tar.gz'))).toEqual(await fs.promises.readFile(incoming));
    expect((await fs.promises.stat(path.join(backups, 'legacy.tar.gz'))).mode & 0o777).toBe(0o600);
    expect((await fs.promises.readdir(backups)).sort()).toEqual(['.uploads', 'legacy.tar.gz']);
  });

  it('cleans a partial cross-device copy instead of publishing it', async () => {
    vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }));
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (_source, target) => {
      await fs.promises.writeFile(target, 'partial copy');
      throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
    });
    await expect(publish(await uploaded())).rejects.toThrow('Disk full');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(backups)).toEqual(['.uploads']);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  const crossDevice = () => {
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation((source, target) => {
      if (String(source).includes('/.uploads/')) return Promise.reject(Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }));
      return link(source, target);
    });
  };

  const failClose = (matches: (file: string) => boolean, syncFailure = false) => {
    const open = fs.promises.open.bind(fs.promises);
    const closed = vi.fn();
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (matches(String(args[0]))) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed();
          throw new Error('Read-only close failed');
        });
        if (syncFailure) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('Persistence failed'));
      }
      return handle;
    });
    return closed;
  };

  const failSiblingCleanup = () => {
    const remove = fs.promises.rm.bind(fs.promises);
    return vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
      if (/\.orbis-upload-[A-Za-z0-9]{6}$/.test(String(target))) return Promise.reject(new Error('Sibling cleanup failed'));
      return remove(target, options);
    });
  };

  it.each(['source', 'copy', 'directory'] as const)('keeps a completed upload successful after the read-only %s close fails', async (role) => {
    const file = await uploaded();
    if (role === 'copy') crossDevice();
    const closed = failClose((name) =>
      role === 'source' ? name === file.path : role === 'directory' ? name === backups : /\.orbis-upload-[A-Za-z0-9]{6}\/backup.tar.gz$/.test(name),
    );
    await expect(publish(file)).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
    expect(await fs.promises.readFile(path.join(backups, 'legacy.tar.gz'))).toEqual(await fs.promises.readFile(incoming));
    expect(await archive.listTarGz(path.join(backups, 'legacy.tar.gz'))).not.toHaveLength(0);
  });

  it('preserves the validation error even when source closing and warning both fail', async () => {
    await fs.promises.writeFile(incoming, 'invalid archive');
    const file = await uploaded();
    const closed = failClose((name) => name === file.path);
    vi.spyOn(logger, 'warn').mockImplementation((...args) => {
      if (args[0] === 'A read-only backup handle could not be closed.') throw new Error('Warning failed');
    });
    await expect(publish(file)).rejects.toThrow('not a valid backup');
    expect(closed).toHaveBeenCalledOnce();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
  });

  it.each(['source', 'copy', 'directory'] as const)('does not hide a real %s persistence failure behind its close failure', async (role) => {
    const file = await uploaded();
    if (role === 'copy') crossDevice();
    const closed = failClose(
      (name) =>
        role === 'source' ? name === file.path : role === 'directory' ? name === backups : /\.orbis-upload-[A-Za-z0-9]{6}\/backup.tar.gz$/.test(name),
      true,
    );
    await expect(publish(file)).rejects.toThrow('Persistence failed');
    expect(closed).toHaveBeenCalledOnce();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(backups)).toEqual(['.uploads']);
  });

  it('retains a completed cross-device upload and retries only its failed sibling cleanup in a new manager', async () => {
    crossDevice();
    const remove = failSiblingCleanup();
    await expect(publish(await uploaded())).resolves.toBeUndefined();
    const target = path.join(backups, 'legacy.tar.gz');
    const before = await fs.promises.readFile(target);
    expect(before).toEqual(await fs.promises.readFile(incoming));
    expect(await archive.listTarGz(target)).not.toHaveLength(0);
    const records = path.join(root, 'data/state/backup-staging-cleanup');
    const names = await fs.promises.readdir(records);
    expect(names).toHaveLength(1);
    const record = JSON.parse(await fs.promises.readFile(path.join(records, names[0] ?? 'missing'), 'utf8'));
    expect(record.kind).toBe('upload');
    expect(path.dirname(record.target)).toBe(backups);
    expect(await fs.promises.readFile(path.join(record.target, 'backup.tar.gz'))).toEqual(before);
    remove.mockRestore();
    await newManager().onModuleInit();
    expect(fs.existsSync(record.target)).toBe(false);
    expect(await fs.promises.readdir(records)).toEqual([]);
    expect(await fs.promises.readFile(target)).toEqual(before);
  });

  it('preserves a failed cross-device copy when sibling cleanup also fails without publishing partial bytes', async () => {
    crossDevice();
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (_source, target) => {
      await fs.promises.writeFile(target, 'partial copy', { mode: 0o600 });
      throw new Error('Copy storage full');
    });
    const remove = failSiblingCleanup();
    await expect(publish(await uploaded())).rejects.toThrow('Copy storage full');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    const records = path.join(root, 'data/state/backup-staging-cleanup');
    expect(await fs.promises.readdir(records)).toHaveLength(1);
    remove.mockRestore();
    await newManager().onModuleInit();
    expect(await fs.promises.readdir(records)).toEqual([]);
    expect(await fs.promises.readdir(backups)).toEqual(['.uploads']);
  });

  it('preserves an incomplete-copy validation error when the read-only copy close fails', async () => {
    const file = await uploaded();
    crossDevice();
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (_source, target) => {
      await fs.promises.writeFile(target, 'incomplete copy', { mode: 0o600 });
    });
    const closed = failClose((name) => /\.orbis-upload-[A-Za-z0-9]{6}\/backup.tar.gz$/.test(name));
    await expect(publish(file)).rejects.toThrow('copy is incomplete');
    expect(closed).toHaveBeenCalledOnce();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(backups)).toEqual(['.uploads']);
  });

  it('keeps cancellation and removes only its new publication when sibling cleanup and input close fail', async () => {
    const file = await uploaded();
    const cancelled = new AbortController();
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      if (String(source).includes('/.uploads/')) throw Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
      await link(source, target);
      cancelled.abort(new Error('Cancelled during publication'));
    });
    const closed = failClose((name) => name === file.path);
    const remove = failSiblingCleanup();
    await expect(publish(file, 'cancelled.tar.gz', cancelled.signal)).rejects.toThrow('Cancelled during publication');
    expect(closed).toHaveBeenCalledOnce();
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    const records = path.join(root, 'data/state/backup-staging-cleanup');
    expect(await fs.promises.readdir(records)).toHaveLength(1);
    remove.mockRestore();
    await newManager().onModuleInit();
    expect(await fs.promises.readdir(records)).toEqual([]);
    expect(await fs.promises.readdir(backups)).toEqual(['.uploads']);
  });

  it('removes a partial receive when its client disconnects', async () => {
    const stream = new PassThrough();
    const req = request();
    const received = receive(stream, req);
    const rejected = expect(received).rejects.toThrow('cancelled');
    stream.write('partial backup');
    await vi.waitFor(async () => expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toHaveLength(1));
    Object.assign(req, { aborted: true });
    req.emit('aborted');
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('does not remove another concurrent receive while cleaning an abandoned upload', async () => {
    const stale = await uploaded();
    const stream = new PassThrough();
    const pending = receive(stream);
    await vi.waitFor(async () => expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toHaveLength(2));
    const another = await uploaded();
    expect(fs.existsSync(stale.path)).toBe(true);
    expect(fs.existsSync(another.path)).toBe(true);
    stream.end('ongoing upload');
    const finished = await pending;
    await Promise.all([stale, another, finished].map((file) => storage.remove(file)));
    const old = await uploaded();
    storage = new BackupUploadStorage(path.join(root, 'data/backups'));
    const fresh = await uploaded();
    expect(fs.existsSync(old.path)).toBe(false);
    await storage.remove(fresh);
  });

  it('continues when another cleanup removes an entry between directory listing and inspection', async () => {
    const stale = await uploaded();
    const read = fs.promises.readdir.bind(fs.promises);
    let removeOnce = true;
    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (...args) => {
      const entries = await read(...args);
      if (removeOnce && String(args[0]) === path.join(backups, '.uploads')) {
        removeOnce = false;
        await storage.remove(stale);
      }
      return entries;
    });
    const file = await uploaded();
    expect(fs.existsSync(stale.path)).toBe(false);
    await storage.remove(file);
  });

  it('does not follow a staging-directory symlink', async () => {
    const external = path.join(root, 'external');
    await fs.promises.mkdir(external);
    await fs.promises.mkdir(backups, { recursive: true });
    await fs.promises.symlink(external, path.join(backups, '.uploads'));
    await expect(uploaded()).rejects.toThrow('Invalid backup upload directory');
    expect(await fs.promises.readdir(external)).toEqual([]);
  });

  it('aborts validation without publishing a completed receive', async () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error('Cancelled by client'));
    await expect(publish(await uploaded(), 'cancelled.tar.gz', cancelled.signal)).rejects.toThrow('Cancelled by client');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('rolls back its new link if cancellation arrives while publication is completing', async () => {
    const cancelled = new AbortController();
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await link(source, target);
      cancelled.abort(new Error('Cancelled before upload completed'));
    });
    await expect(publish(await uploaded(), 'cancelled.tar.gz', cancelled.signal)).rejects.toThrow('Cancelled before upload completed');
    expect(await manager.listBackupsByAppId(appUrn)).toEqual([]);
    expect(await fs.promises.readdir(path.join(backups, '.uploads'))).toEqual([]);
  });

  it('streams a 64 MiB receive without returning an in-memory file buffer', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7);
    const file = await receive(
      Readable.from(
        (function* () {
          for (let i = 0; i < 1024; i++) yield chunk;
        })(),
      ),
    );
    expect(file).not.toHaveProperty('buffer');
    expect(file.size).toBe(64 * 1024 * 1024);
    expect((await fs.promises.stat(file.path)).size).toBe(file.size);
    await storage.remove(file);
  });
});
