import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMaintenanceServer, maintenanceState, permittedDuringMaintenance } from './orbis-host-maintenance-responder.mjs';

const cleanups: (() => Promise<void>)[] = [];
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
