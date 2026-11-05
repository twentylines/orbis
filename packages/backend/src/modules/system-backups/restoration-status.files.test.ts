import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { BackupRestoreJournal } from '@/modules/system-backups/backup-restore-journal';
import { createRestorationMiddleware, readClientOperationStatus, readOperationStatus, readRestorationStatus } from '@/common/restoration-status';
import { readRootCoreState, readRootCoreProgress, readRootRestorationState } from '@/common/restoration-root-status';
import { parseCoreUpdateProgress } from '@/common/core-update-progress';
import { ResetState } from '@/modules/system-reset/reset-state';

const directories: string[] = [];
it('projects a completed reset only for negotiated clients and retains active/unreadable holds', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reset-client-status-')));
  directories.push(directory);
  const store = new ResetState(directory);
  const journal = {
    version: 1 as const,
    id: randomUUID(),
    controller: 'private-controller',
    accounts: 'remove' as const,
    users: [7],
    phase: 'complete' as const,
    createdAt: Date.now(),
  };
  await store.save(journal);
  const idle = async () => ({ state: 'idle' as const });
  const read = () => store.active();
  expect(await readClientOperationStatus(idle, read)).toEqual({ version: 1, status: { state: 'idle' }, resetGeneration: journal.id });
  const app = await (await Test.createTestingModule({ imports: [ProbeModule] }).compile()).createNestApplication();
  app.use(createRestorationMiddleware(idle, async () => null, read));
  await app.init();
  try {
    expect((await request(app.getHttpServer()).get('/api/system/operation-status')).body).toEqual({ state: 'idle' });
    expect((await request(app.getHttpServer()).get('/api/system/operation-status?client=1')).body).toEqual({
      version: 1,
      status: { state: 'idle' },
      resetGeneration: journal.id,
    });
    expect((await request(app.getHttpServer()).get('/api/system/restoration-status?client=1')).body).toEqual({ state: 'idle' });
    await store.save({ ...journal, phase: 'accounts' });
    expect(await readClientOperationStatus(idle, read)).toEqual({
      version: 1,
      status: { state: 'resetting', stage: 'resetting' },
      resetGeneration: null,
    });
    expect(
      await readClientOperationStatus(idle, async () => {
        throw new Error('unreadable');
      }),
    ).toEqual({ version: 1, status: { state: 'checking' }, resetGeneration: null });
  } finally {
    await app.close();
  }
});
it('holds reset across reload, exposes no account data, and keeps protected restore/core state dominant', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reset-public-status-')));
  directories.push(directory);
  await fs.mkdir(path.join(directory, 'state'), { mode: 0o700 });
  const reset = new ResetState(directory);
  await reset.save({
    version: 1,
    id: randomUUID(),
    controller: 'private-controller',
    accounts: 'remove',
    users: [7],
    phase: 'accounts',
    createdAt: Date.now(),
  });
  const read = () => new ResetState(directory).active();
  const idle = async () => ({ state: 'idle' as const });
  expect(await readOperationStatus(idle, async () => 'idle', read)).toEqual({ state: 'resetting', stage: 'resetting' });
  expect(
    await readOperationStatus(
      async () => ({ state: 'restoring', stage: 'restoring' }),
      async () => 'idle',
      read,
    ),
  ).toEqual({ state: 'restoring', stage: 'restoring' });
  expect(await readOperationStatus(idle, async () => 'updating', read)).toEqual({ state: 'updating' });
  expect(
    await readOperationStatus(
      idle,
      async () => 'idle',
      async () => {
        throw new Error('corrupt');
      },
    ),
  ).toEqual({ state: 'checking' });
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

it('reads the persisted journal and fails closed on damaged state without exposing its identity', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'restore-status-')));
  directories.push(directory);
  const store = path.join(directory, 'restores');
  expect(await readRestorationStatus(store)).toEqual({ state: 'idle' });
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: 'a'.repeat(64),
    candidateController: 'b'.repeat(64),
    worker: 'c'.repeat(64),
    roots: ['state', 'app-data', 'env'],
  });
  expect(await readRestorationStatus(store)).toEqual({ state: 'restoring', stage: 'preparing' });
  await journal.advance('discarded');
  expect(await readRestorationStatus(store)).toEqual({ state: 'idle' });
  await fs.writeFile(path.join(journal.directory, 'retained-binding.json'), '{}', { mode: 0o600 });
  expect(await readRestorationStatus(store)).toEqual({ state: 'checking' });
  expect(await readRestorationStatus(store, async () => 'idle')).toEqual({ state: 'idle' });
  expect(await readRestorationStatus(store, async () => 'restoring')).toEqual({ state: 'checking' });
  expect(await readRestorationStatus(store, async () => 'idle')).toEqual({ state: 'idle' });
  await fs.rm(path.join(journal.directory, 'retained-binding.json'));
  await fs.writeFile(path.join(journal.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  expect(await readRestorationStatus(store, async () => null)).toEqual({ state: 'checking' });
  expect(await readRestorationStatus(store, async () => 'idle')).toEqual({ state: 'idle' });
  await fs.writeFile(path.join(store, 'active.json'), '{}');
  expect(await readRestorationStatus(store)).toEqual({ state: 'checking' });
});

@Controller()
class ProbeController {
  @Get('*path') get() {
    return { reached: true };
  }
  @Post('*path') post() {
    return { reached: true };
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

const coreProgress = {
  version: 1 as const,
  job: { id: '11111111-1111-4111-8111-111111111111', state: 'running' as const, targetTag: 'v0.2.0-beta.3', phase: 'verifying' as const },
};

it('serves only read-only sanitized progress independently of ordinary operation/auth status', async () => {
  const download = {
    schema: 'orbis.download-progress.v1',
    phase: 'downloading',
    currentBytes: 5,
    totalBytes: 10,
    totalKnown: true,
    alreadyCached: false,
    layersComplete: 0,
    layersTotal: 1,
    updatedAt: 1700000000,
  };
  expect(parseCoreUpdateProgress({ ...coreProgress, job: { ...coreProgress.job, download } }).job?.download).toEqual(download);
  expect(parseCoreUpdateProgress({ ...coreProgress, job: { ...coreProgress.job, state: 'complete', phase: null } }).job?.phase).toBeNull();
  for (const invalid of [
    { ...download, currentBytes: 11 },
    { ...download, updatedAt: Number.POSITIVE_INFINITY },
    { ...download, private: 'PRIVATE_FIXTURE' },
  ])
    expect(() => parseCoreUpdateProgress({ ...coreProgress, job: { ...coreProgress.job, download: invalid } })).toThrow();
  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = module.createNestApplication();
  let value: unknown = coreProgress;
  app.use(
    createRestorationMiddleware(
      async () => {
        throw new Error('Orbis operation status is down');
      },
      async () => parseCoreUpdateProgress(value),
    ),
  );
  await app.init();
  try {
    const result = await request(app.getHttpServer()).get('/api/system/core-update-progress');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(coreProgress);
    expect(result.headers['cache-control']).toBe('no-store');
    expect((await request(app.getHttpServer()).post('/api/system/core-update-progress')).status).toBe(405);
    for (const invalid of [
      { ...coreProgress, private: 'PRIVATE_FIXTURE' },
      { ...coreProgress, job: { ...coreProgress.job, message: 'PRIVATE_FIXTURE' } },
      { ...coreProgress, job: { ...coreProgress.job, phase: 'staged' } },
      { ...coreProgress, job: { ...coreProgress.job, id: 'invalid' } },
      { ...coreProgress, job: { ...coreProgress.job, download: { private: 'PRIVATE_FIXTURE' } } },
    ]) {
      value = invalid;
      const rejected = await request(app.getHttpServer()).get('/api/system/core-update-progress');
      expect(rejected.status).toBe(503);
      expect(JSON.stringify(rejected.body)).not.toContain('PRIVATE_FIXTURE');
    }
  } finally {
    await app.close();
  }
});

it('bounds progress socket responses and treats missing/bad authority as unavailable', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-progress-')));
  directories.push(directory);
  const socket = path.join(directory, 'host.sock');
  expect(await readRootCoreProgress(socket)).toBeNull();
  let mode = 'valid';
  const server = http.createServer((req, res) => {
    expect(req.url).toBe('/v1/core-operation/progress');
    if (mode === 'oversized') {
      res.end(' '.repeat(16385));
      return;
    }
    if (mode === 'private') {
      res.end(JSON.stringify({ ...coreProgress, secret: 'PRIVATE_FIXTURE' }));
      return;
    }
    if (mode === 'changed') {
      void fs.chmod(socket, 0o644).then(() => res.end(JSON.stringify(coreProgress)));
      return;
    }
    if (mode === 'trickle') {
      res.writeHead(200);
      const timer = setInterval(() => res.write(' '), 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(JSON.stringify(coreProgress));
  });
  server.listen(socket);
  await once(server, 'listening');
  await fs.chmod(socket, 0o600);
  try {
    expect(await readRootCoreProgress(socket)).toEqual(coreProgress);
    for (mode of ['oversized', 'private', 'changed']) expect(await readRootCoreProgress(socket)).toBeNull();
    await fs.chmod(socket, 0o600);
    mode = 'trickle';
    const started = Date.now();
    expect(await readRootCoreProgress(socket)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3500);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

it('publishes only sanitized no-store status and blocks unrelated API handlers', async () => {
  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = module.createNestApplication();
  app.use(createRestorationMiddleware(async () => ({ state: 'restoring', stage: 'restoring' })));
  await app.init();
  const status = await request(app.getHttpServer()).get('/api/system/operation-status');
  expect(status.body).toEqual({ state: 'restoring', stage: 'restoring' });
  expect(status.headers['cache-control']).toBe('no-store');
  expect((await request(app.getHttpServer()).get('/api/apps')).status).toBe(503);
  expect((await request(app.getHttpServer()).post('/api/system-backups/export')).status).toBe(503);
  expect((await request(app.getHttpServer()).post('/api/auth/register')).status).toBe(503);
  expect((await request(app.getHttpServer()).post('/api/auth/login')).status).toBe(201);
  expect((await request(app.getHttpServer()).get('/api/health')).status).toBe(200);
  expect((await request(app.getHttpServer()).get('/api/host-updates/status')).status).toBe(200);
  expect((await request(app.getHttpServer()).get('/api/system/build')).status).toBe(200);
  expect((await request(app.getHttpServer()).get('/api/system-backups/restores')).status).toBe(200);
  await app.close();
});

it('uses protected root status, retains a lock on loss, and rejects extra root fields', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'root-status-')));
  directories.push(directory);
  const socket = path.join(directory, 'host.sock');
  let body = JSON.stringify({ state: 'restoring' });
  const server = http.createServer((req, res) => {
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/retained-restore/maintenance');
    res.end(body);
  });
  server.listen(socket);
  await once(server, 'listening');
  await fs.chmod(socket, 0o600);
  const root = () => readRootRestorationState(socket);
  const store = path.join(directory, 'absent');
  expect(await readRestorationStatus(store, root)).toEqual({ state: 'restoring', stage: 'restoring' });
  body = JSON.stringify({ state: 'idle', transactionId: 'private' });
  expect(await readRestorationStatus(store, root)).toEqual({ state: 'checking' });
  body = JSON.stringify({ state: 'idle' });
  expect(await readRestorationStatus(store, root)).toEqual({ state: 'idle' });
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

it('locks for core updates and downgrades while retaining a lock on lost host status', async () => {
  const idle = async () => ({ state: 'idle' as const });
  expect(await readOperationStatus(idle, async () => 'updating')).toEqual({ state: 'updating' });
  expect(await readOperationStatus(idle, async () => null)).toEqual({ state: 'checking' });
  expect(await readOperationStatus(idle, async () => 'downgrading')).toEqual({ state: 'downgrading' });
  expect(await readOperationStatus(idle, async () => 'idle')).toEqual({ state: 'idle' });
});

it('reads the separate protected core operation without exposing details', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-status-')));
  directories.push(directory);
  const socket = path.join(directory, 'host.sock');
  const server = http.createServer((req, res) => {
    expect(req.url).toBe('/v1/core-operation/maintenance');
    res.end(JSON.stringify({ state: 'downgrading' }));
  });
  server.listen(socket);
  await once(server, 'listening');
  await fs.chmod(socket, 0o600);
  expect(await readRootCoreState(socket)).toBe('downgrading');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

it('treats a configured unavailable host as checking while recognizing an older unsupported route', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-unavailable-')));
  directories.push(directory);
  const socket = path.join(directory, 'host.sock');
  expect(await readRootCoreState(socket)).toBe('checking');
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.listen(socket);
  await once(server, 'listening');
  await fs.chmod(socket, 0o600);
  expect(await readRootCoreState(socket)).toBeNull();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});
