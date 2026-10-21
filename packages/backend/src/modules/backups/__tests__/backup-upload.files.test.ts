import fs from 'node:fs';
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
  let backups: string;
  let incoming: string;
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
    root = await fs.promises.mkdtemp('/tmp/orbis-upload-files-');
    backups = path.join(root, 'data/backups/store/demo');
    storage = new BackupUploadStorage(path.join(root, 'data/backups'));
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
    const filesystem = new FilesystemService(logger);
    archive = new ArchiveService(logger);
    const appDataDir = path.join(root, 'app-data/store/demo');
    const appInstalledDir = path.join(root, 'apps/store/demo');
    const apps = {
      getAppPaths: () => ({ appDataDir, appInstalledDir }),
      getInstalledAppInfo: async () => JSON.parse(await fs.promises.readFile(path.join(appInstalledDir, 'config.json'), 'utf8')),
    } as unknown as AppFilesManager;
    const repository = { getAppByUrn: vi.fn().mockResolvedValue({ id: 1 }), updateAppById: vi.fn() } as unknown as AppsRepository;
    const configuration = { get: () => ({ dataDir: path.join(root, 'data') }) } as unknown as ConfigurationService;
    manager = new BackupManager(archive, logger, configuration, filesystem, apps, repository);
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
