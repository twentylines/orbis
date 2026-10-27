import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { BackupImportsController } from './backup-imports.controller';
import { BackupImportsService } from './backup-imports.service';
import { fullBackupFixture, fixturePassphrase } from './backup-import.fixture';

let root: string;
let app: INestApplication;
let service: BackupImportsService;
let origin: string;
const credentials = { password: 'disposable-http-operator-password' };
const auth = { verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }) };
const logger = { warn: vi.fn(), debug: vi.fn() };
const database = { review: vi.fn().mockResolvedValue({ counts: { user: 1, app_store: 0, app: 0, link: 0 }, bytes: 1, sha256: '0'.repeat(64) }) };
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-import-http-')));
  const config = { get: (key: string) => ({ directories: { dataDir: path.join(root, 'live') }, version: '4.10.1', architecture: 'arm64' })[key] };
  // The HTTP fixture checks admission and streaming; PostgreSQL execution is covered independently.
  service = new BackupImportsService(...([config, auth, logger, database] as unknown as ConstructorParameters<typeof BackupImportsService>));
  const module = await Test.createTestingModule({
    controllers: [BackupImportsController],
    providers: [AuthGuard, { provide: BackupImportsService, useValue: service }, { provide: LoggerService, useValue: logger }],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  // This isolated test supplies identities; the real AuthGuard still checks sessions and request origin.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers['x-fixture-role'];
    if (typeof role === 'string') {
      req.user = { id: role === 'foreign' ? 2 : 1, operator: role !== 'viewer' } as Request['user'];
      req.authMethod = 'session';
    }
    next();
  });
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
});
afterEach(async () => {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
});
const api = () => request(app.getHttpServer());
const base = '/api/system-backups/imports';
const directory = (id: string) => path.join(root, 'live', 'backups', 'imports', id);
async function create() {
  const result = await api().post(base).set('x-fixture-role', 'operator').set('Origin', origin).send(credentials).expect(201);
  return String(result.body.id);
}

it('protects creation and raw uploads with session, operator, origin and ownership checks', async () => {
  await api().get(base).expect(401);
  await api().post(base).set('x-fixture-role', 'viewer').set('Origin', origin).send(credentials).expect(403);
  await api().post(base).set('x-fixture-role', 'operator').send(credentials).expect(403);
  const id = await create();
  await api()
    .put(`${base}/${id}/file`)
    .set('x-fixture-role', 'foreign')
    .set('Origin', origin)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(100))
    .expect(404);
  expect(await fs.readdir(directory(id))).toEqual(['job.json']);
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
});

it('receives the raw file as a stream and completes asynchronous archive review over HTTP', async () => {
  const fixture = await fullBackupFixture(root);
  const id = await create();
  const bytes = await fs.readFile(fixture.encrypted);
  const uploaded = await api()
    .put(`${base}/${id}/file`)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes)
    .expect(200);
  expect(uploaded.body.status).toBe('uploaded');
  expect(uploaded.body.uploadedBytes).toBe(bytes.length);
  await api()
    .post(`${base}/${id}/review`)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .send({ ...credentials, passphrase: fixturePassphrase })
    .expect(202);
  await vi.waitFor(
    async () => {
      const result = await api().get(base).set('x-fixture-role', 'operator').expect(200);
      expect(result.body.jobs[0].status).toBe('reviewed');
      expect(result.body.jobs[0].review.fileCount).toBe(fixture.manifest.files.length + 3);
    },
    { timeout: 10_000 },
  );
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'content', 'job.json', 'review-seal.json']);
  expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(fixturePassphrase);
});

it('returns a useful upload error for an invalid encrypted header without retaining its payload', async () => {
  const id = await create();
  await api()
    .put(`${base}/${id}/file`)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .set('Content-Type', 'text/plain')
    .send('invalid')
    .expect(400);
  const result = await api()
    .put(`${base}/${id}/file`)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(100, 7))
    .expect(400);
  expect(result.body.message).toContain('encrypted Orbis backup');
  expect(await fs.readdir(directory(id))).toEqual(['job.json']);
});

it('aborts a disconnected raw upload and cleans its partial file while the server remains responsive', async () => {
  const id = await create();
  const client = http.request(`${origin}${base}/${id}/file`, {
    method: 'PUT',
    headers: { Origin: origin, 'x-fixture-role': 'operator', 'Content-Type': 'application/octet-stream' },
  });
  client.on('error', () => undefined);
  client.write(Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(100)]));
  await vi.waitFor(async () => expect((await service.list(1)).jobs[0]?.completedBytes).toBe(108));
  client.destroy();
  await vi.waitFor(async () => {
    expect((await service.list(1)).jobs[0]?.status).toBe('cancelled');
    expect(await fs.readdir(directory(id))).toEqual(['job.json']);
  });
  await api().get(base).set('x-fixture-role', 'operator').expect(200);
});

it('rejects arbitrary identifiers and extra credential fields without crashing its close listener', async () => {
  await api()
    .post(base)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .send({ ...credentials, directory: '/outside' })
    .expect(400);
  await api()
    .put(`${base}/not-a-uuid/file`)
    .set('x-fixture-role', 'operator')
    .set('Origin', origin)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.alloc(100))
    .expect(404);
  await api().get(base).set('x-fixture-role', 'operator').expect(200);
});
