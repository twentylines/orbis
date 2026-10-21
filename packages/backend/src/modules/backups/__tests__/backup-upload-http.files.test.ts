import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { type ExecutionContext, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupManager } from '../backup.manager';
import { BackupUploadStorage } from '../backup-upload.storage';
import { BackupsController } from '../backups.controller';
import { BackupsService } from '../backups.service';

describe('Backup multipart HTTP endpoint with real disk staging', () => {
  let root: string;
  let app: INestApplication;
  let archive: ArchiveService;
  let source: string;
  let manager: BackupManager;
  let uploads: string;
  let service: BackupsService;
  let logger: LoggerService;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp('/tmp/orbis-upload-http-');
    uploads = path.join(root, 'backups/store/demo/.uploads');
    source = path.join(root, 'backup.tar.gz');
    const tree = path.join(root, 'tree');
    await fs.promises.mkdir(path.join(tree, 'app-data'), { recursive: true });
    await fs.promises.mkdir(path.join(tree, 'app'));
    await fs.promises.writeFile(
      path.join(tree, 'app/config.json'),
      JSON.stringify({
        id: 'demo',
        available: true,
        name: 'Demo',
        tipi_version: 1,
        short_desc: 'Fixture',
        author: 'Orbis',
        source: 'https://example.test',
      }),
    );
    await fs.promises.writeFile(path.join(tree, 'app-data/binary.bin'), Buffer.from([0, 255, 128, 0]));
    logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
    archive = new ArchiveService(logger);
    expect((await archive.createTarGz(tree, source)).stderr).toBe('');
    const configuration = { get: (key: string) => (key === 'demoMode' ? false : { dataDir: root }) } as unknown as ConfigurationService;
    const repository = { getAppByUrn: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as AppsRepository;
    manager = new BackupManager(archive, logger, configuration, new FilesystemService(logger), {} as AppFilesManager, repository);
    service = new BackupsService(repository, configuration, manager);
    const storage = new BackupUploadStorage(path.join(root, 'backups'));
    const module = await Test.createTestingModule({
      imports: [MulterModule.register({ storage })],
      controllers: [BackupsController],
      providers: [
        { provide: BackupsService, useValue: service },
        { provide: AppLifecycleService, useValue: {} },
        { provide: BackupUploadStorage, useValue: storage },
        { provide: LoggerService, useValue: logger },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          if (context.switchToHttp().getRequest().headers['x-orbis-upload-test'] !== 'fixture') throw new UnauthorizedException();
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const post = () => request(app.getHttpServer()).post('/api/backups/demo%3Astore/upload').set('x-orbis-upload-test', 'fixture');
  const empty = async () => expect(await fs.promises.readdir(uploads)).toEqual([]);

  it('accepts legacy filenames and generic MIME with a private streamed source, without passing a Buffer to the service', async () => {
    const upload = vi.spyOn(service, 'uploadBackup');
    await post().attach('file', source, { filename: 'legacy.tar.gz', contentType: 'application/octet-stream' }).expect(201, { success: true });
    expect(upload).toHaveBeenCalledOnce();
    const params = upload.mock.calls[0]?.[0];
    expect(typeof params?.sourceFile).toBe('string');
    expect(params).not.toHaveProperty('fileBuffer');
    const result = path.join(root, 'backups/store/demo/legacy.tar.gz');
    expect(await fs.promises.readFile(result)).toEqual(await fs.promises.readFile(source));
    expect((await fs.promises.stat(result)).mode & 0o777).toBe(0o600);
    await empty();
  });

  it('rejects a corrupt upload with 400 and no published or staged backup', async () => {
    await post().attach('file', Buffer.from('not a gzip archive'), { filename: 'invalid.tar.gz', contentType: 'application/gzip' }).expect(400);
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toEqual([]);
    await empty();
  });

  it('returns 409 for a duplicate without changing the previous archive', async () => {
    await post().attach('file', source, 'legacy.tar.gz').expect(201);
    const before = await fs.promises.readFile(path.join(root, 'backups/store/demo/legacy.tar.gz'));
    await fs.promises.writeFile(path.join(root, 'tree/app-data/binary.bin'), 'different replacement data');
    await archive.createTarGz(path.join(root, 'tree'), source);
    await post().attach('file', source, 'legacy.tar.gz').expect(409);
    expect(await fs.promises.readFile(path.join(root, 'backups/store/demo/legacy.tar.gz'))).toEqual(before);
    await empty();
  });

  it('keeps a committed upload successful and retries failed private cleanup on the next receive', async () => {
    const remove = fs.promises.rm.bind(fs.promises);
    let failOnce = true;
    vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
      if (failOnce && String(target).startsWith(`${uploads}/upload-`)) {
        failOnce = false;
        return Promise.reject(Object.assign(new Error('Temporary cleanup failure'), { code: 'EIO' }));
      }
      return remove(target, options);
    });
    await post().attach('file', source, 'first.tar.gz').expect(201, { success: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Backup saved'), expect.any(Error));
    expect(await fs.promises.readdir(uploads)).toHaveLength(1);
    await post().attach('file', source, 'second.tar.gz').expect(201, { success: true });
    await empty();
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toHaveLength(2);
  });

  it('preserves the validation error when private cleanup also fails and retries cleanup later', async () => {
    const remove = fs.promises.rm.bind(fs.promises);
    let failOnce = true;
    vi.spyOn(fs.promises, 'rm').mockImplementation((target, options) => {
      if (failOnce && String(target).startsWith(`${uploads}/upload-`)) {
        failOnce = false;
        return Promise.reject(new Error('Temporary cleanup failure'));
      }
      return remove(target, options);
    });
    await post().attach('file', source, 'wrong.zip').expect(400);
    expect(logger.warn).toHaveBeenCalled();
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toEqual([]);
    await post().attach('file', source, 'valid.tar.gz').expect(201);
    await empty();
  });

  it('checks authentication before writing any multipart file', async () => {
    await request(app.getHttpServer()).post('/api/backups/demo%3Astore/upload').attach('file', source, 'unauthorized.tar.gz').expect(401);
    expect(fs.existsSync(uploads)).toBe(false);
  });

  it('rejects a missing file or wrong extension and cleans the received file', async () => {
    await post().expect(400);
    await post().attach('file', source, 'wrong.zip').expect(400);
    await empty();
  });

  it('cleans an accepted first file when an unexpected second file makes multipart parsing fail', async () => {
    await post().attach('file', source, 'one.tar.gz').attach('file', source, 'two.tar.gz').expect(400);
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toEqual([]);
    await empty();
  });

  it('cleans a partially received file when the HTTP client disconnects', async () => {
    const address = app.getHttpServer().address() as AddressInfo;
    const client = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/backups/demo%3Astore/upload',
      method: 'POST',
      headers: { 'x-orbis-upload-test': 'fixture', 'Content-Type': 'multipart/form-data; boundary=orbis-abort' },
    });
    let failure: Error | undefined;
    client.on('error', (error) => {
      failure = error;
    });
    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    client.write('--orbis-abort\r\nContent-Disposition: form-data; name="file"; filename="partial.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n');
    client.write(Buffer.alloc(64 * 1024, 1));
    try {
      await vi.waitFor(async () => expect(await fs.promises.readdir(uploads)).toHaveLength(1));
      expect(failure).toBeUndefined();
    } finally {
      client.destroy();
    }
    await closed;
    await vi.waitFor(empty);
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toEqual([]);
  });

  it('cancels validation and removes a completed receive when the client closes before publication', async () => {
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    vi.spyOn(archive, 'listTarGz').mockImplementationOnce(
      (_source, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          start();
        }),
    );
    const address = app.getHttpServer().address() as AddressInfo;
    const body = Buffer.concat([
      Buffer.from(
        '--orbis-validate\r\nContent-Disposition: form-data; name="file"; filename="cancelled.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n',
      ),
      await fs.promises.readFile(source),
      Buffer.from('\r\n--orbis-validate--\r\n'),
    ]);
    const client = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/backups/demo%3Astore/upload',
      method: 'POST',
      headers: { 'x-orbis-upload-test': 'fixture', 'Content-Type': 'multipart/form-data; boundary=orbis-validate', 'Content-Length': body.length },
    });
    client.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    client.end(body);
    try {
      await started;
    } finally {
      client.destroy();
    }
    await closed;
    await vi.waitFor(empty);
    expect(await manager.listBackupsByAppId(createAppUrn('demo', 'store'))).toEqual([]);
  });
});
