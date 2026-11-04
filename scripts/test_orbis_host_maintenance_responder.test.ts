import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  createMaintenanceServer,
  maintenanceState,
  permittedDuringMaintenance,
  readRootCoreProgress,
  coreProgressSocketIdentity,
  validateCoreUpdateProgress,
} from './orbis-host-maintenance-responder.mjs';

const cleanups: (() => Promise<void>)[] = [];
const progress = {
  version: 1,
  job: { id: '11111111-1111-4111-8111-111111111111', state: 'running', targetTag: 'v0.2.0-beta.3', phase: 'verifying' },
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test('root active state wins; unavailable authority remains checking', async () => {
  expect(await maintenanceState(async (route: string) => (route.includes('retained') ? 'restoring' : 'updating'))).toEqual({ state: 'restoring' });
  expect(await maintenanceState(async (route: string) => (route.includes('retained') ? 'idle' : 'downgrading'))).toEqual({ state: 'downgrading' });
  expect(
    await maintenanceState(async () => {
      throw new Error('private fixture');
    }),
  ).toEqual({ state: 'checking' });
});

test('only authentication, recovery, health and sanitized status bypass active maintenance', () => {
  for (const [method, pathname] of [
    ['GET', '/api/user-context'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/system/build'],
    ['POST', '/api/host-updates/recover'],
    ['POST', '/api/system-backups/restores/11111111-1111-4111-8111-111111111111/recover'],
    ['POST', '/api/system-backups/time-machine/points/11111111-1111-4111-8111-111111111111/recover'],
  ]) {
    expect(permittedDuringMaintenance(method, pathname)).toBeTrue();
  }
  for (const [method, pathname] of [
    ['POST', '/api/auth/register'],
    ['POST', '/api/apps/start'],
    ['GET', '/api/app-context'],
    ['DELETE', '/api/host-updates/recover'],
  ]) {
    expect(permittedDuringMaintenance(method, pathname)).toBeFalse();
  }
});

test('actual HTTP serves SPA on direct navigation, locks API, and follows authoritative terminal', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-maintenance-test-')));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Fixture restore UI</title>');
  await fs.mkdir(path.join(directory, 'assets'));
  await fs.writeFile(path.join(directory, 'assets/app.js'), 'fixture();');
  await fs.symlink(path.join(directory, 'index.html'), path.join(directory, 'linked.html'));
  let state = 'restoring';
  let proxied = 0;
  const server = createMaintenanceServer({
    assets: directory,
    readState: async () => ({ state }),
    proxy: (_request: unknown, response: { writeHead: (status: number) => void; end: (body: string) => void }) => {
      proxied++;
      response.writeHead(201);
      response.end('fixture authenticated upstream');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const direct = await fetch(`${base}/dashboard/settings`, { headers: { accept: 'text/html' } });
  expect(direct.status).toBe(200);
  expect(await direct.text()).toContain('Fixture restore UI');
  expect(await (await fetch(`${base}/api/system/operation-status`)).json()).toEqual({ state: 'restoring' });
  expect((await fetch(`${base}/api/apps/start`, { method: 'POST' })).status).toBe(503);
  expect(proxied).toBe(0);
  expect((await fetch(`${base}/api/auth/login`, { method: 'POST' })).status).toBe(201);
  expect((await fetch(`${base}/linked.html`)).status).toBe(503);
  state = 'checking';
  expect((await fetch(`${base}/api/app-context`)).status).toBe(503);
  state = 'idle';
  expect((await fetch(`${base}/api/app-context`)).status).toBe(201);
});

test('progress remains readable while Orbis is unavailable and never forwards actions or exposes private fields', async () => {
  let value: unknown = progress;
  let forwarded = 0;
  const server = createMaintenanceServer({
    readState: async () => {
      throw new Error('Orbis is down');
    },
    readProgress: async () => value,
    proxy: () => {
      forwarded++;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const url = `http://127.0.0.1:${address.port}/api/system/core-update-progress`;
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(progress);
  expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  for (const invalid of [
    { ...progress, private: 'PRIVATE_FIXTURE' },
    { ...progress, job: { ...progress.job, message: 'PRIVATE_FIXTURE' } },
    { ...progress, job: { ...progress.job, phase: 'staged' } },
    { ...progress, job: { ...progress.job, state: 'healthy' } },
  ]) {
    value = invalid;
    const rejected = await fetch(url);
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).not.toContain('PRIVATE_FIXTURE');
  }
  expect(forwarded).toBe(0);
  expect(() => validateCoreUpdateProgress({ ...progress, job: { ...progress.job, download: { secret: 'PRIVATE_FIXTURE' } } })).toThrow();
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
  expect(validateCoreUpdateProgress({ ...progress, job: { ...progress.job, download } }).job.download).toEqual(download);
  expect(validateCoreUpdateProgress({ ...progress, job: { ...progress.job, state: 'complete', phase: null } }).job.phase).toBeNull();
  for (const invalid of [
    { ...download, currentBytes: 11 },
    { ...download, updatedAt: Number.POSITIVE_INFINITY },
    { ...download, private: 'PRIVATE_FIXTURE' },
  ])
    expect(() => validateCoreUpdateProgress({ ...progress, job: { ...progress.job, download: invalid } })).toThrow();
});

test('progress socket transport enforces a body cap, absolute deadline and stable socket seal', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-progress-socket-')));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const socket = path.join(directory, 'host.sock');
  let mode = 'valid';
  const server = http.createServer((request, response) => {
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/v1/core-operation/progress');
    if (mode === 'oversized') {
      response.end(' '.repeat(16385));
      return;
    }
    if (mode === 'trickle') {
      response.writeHead(200);
      const timer = setInterval(() => response.write(' '), 5);
      response.on('close', () => clearInterval(timer));
      return;
    }
    response.end(JSON.stringify(progress));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const identity = async () => 'fixture-protected-socket';
  await fs.chmod(socket, 0o644);
  await expect(coreProgressSocketIdentity(socket)).rejects.toThrow();
  await fs.chmod(socket, 0o600);
  expect(await readRootCoreProgress({ socket, identity })).toEqual(progress);
  let reads = 0;
  await expect(readRootCoreProgress({ socket, identity: async () => String(reads++) })).rejects.toThrow();
  mode = 'oversized';
  await expect(readRootCoreProgress({ socket, identity })).rejects.toThrow();
  mode = 'trickle';
  const started = Date.now();
  await expect(readRootCoreProgress({ socket, identity, deadlineMs: 40 })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1000);
});
