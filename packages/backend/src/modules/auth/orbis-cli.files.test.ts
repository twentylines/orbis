import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getCliSecret } from '@/common/helpers/permissions-helpers';
import { resetOperatorPassword, runAppJob } from '@/orbis-cli';
import type { AppJob } from '@runtipi/common/schemas/app-job';

let directory: string;
let server: ReturnType<typeof createServer> | undefined;
const password = 'Disposable fixture password';
const stateDirectory = () => join(directory, 'state');
const marker = () => join(stateDirectory(), 'password-change-request');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbis-cli-'));
  await mkdir(stateDirectory(), { mode: 0o700 });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const local = createServer((request, response) => {
    void Promise.resolve(handle(request, response)).catch(() => {
      response.destroy();
    });
  });
  server = local;
  await new Promise<void>((resolve, reject) => {
    local.once('error', reject);
    local.listen(0, '127.0.0.1', resolve);
  });
  return (local.address() as AddressInfo).port;
}

it('authorizes the existing reset endpoint and refreshes a stale request without changing the key', async () => {
  const secret = await getCliSecret(directory);
  const oldRequest = String(Math.floor(Date.now() / 1000) - 900);
  await writeFile(marker(), oldRequest);
  let handled = false;
  const port = await listen(async (request, response) => {
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/auth/reset-password');
    const bearer = request.headers.authorization?.slice('Bearer '.length) ?? '';
    const token = jwt.verify(bearer, secret, { algorithms: ['HS256'], subject: 'cli' });
    expect(typeof token).toBe('object');
    if (typeof token === 'string') throw new Error('Expected a CLI JWT payload');
    expect((token.exp ?? 0) - (token.iat ?? 0)).toBe(60);
    expect(Number(await readFile(marker(), 'utf8'))).toBeGreaterThan(Number(oldRequest));
    expect((await stat(marker())).mode & 0o777).toBe(0o600);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ newPassword: password });
    expect(await readdir(stateDirectory())).toEqual(['password-change-request']);
    await rm(marker());
    handled = true;
    response.writeHead(201).end(JSON.stringify({ success: true }));
  });
  await expect(resetOperatorPassword(directory, password, port)).resolves.toBeUndefined();
  expect(handled).toBe(true);
  expect(await readFile(join(directory, '.secrets', 'cli-secret'), 'utf8')).toBe(secret);
  await expect(readFile(marker())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires a private local CLI key and a valid password before creating a request', async () => {
  await expect(resetOperatorPassword(directory, 'short')).rejects.toThrow('at least eight characters');
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('CLI key is unavailable');
  expect(await readdir(stateDirectory())).toEqual([]);
});

it('refuses a state directory writable by other users', async () => {
  await getCliSecret(directory);
  await chmod(stateDirectory(), 0o777);
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('state directory is not private');
  expect(await readdir(stateDirectory())).toEqual([]);
});

it('refuses to overwrite an existing symbolic link in the request path', async () => {
  await getCliSecret(directory);
  const unrelated = join(directory, 'preserve');
  await writeFile(unrelated, 'unrelated file');
  await symlink(unrelated, marker());
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('existing password reset request needs review');
  expect(await readFile(unrelated, 'utf8')).toBe('unrelated file');
});

it.each([
  [201, 'an unconfirmed response', 'could not confirm the password reset'],
  [303, 'a redirect to another endpoint', 'could not confirm the password reset'],
  [401, 'an authorization failure', 'did not authorize'],
  [409, 'a simultaneous reset', 'already running'],
  [500, 'a potentially committed recovery failure', 'could not confirm the password reset'],
])('handles HTTP %d with %s without revealing the response content', async (status, _case, message) => {
  await getCliSecret(directory);
  let calls = 0;
  const port = await listen((request, response) => {
    calls++;
    request.resume();
    response.writeHead(status, { Location: '/another-route' }).end(JSON.stringify({ diagnostic: password }));
  });
  const operation = resetOperatorPassword(directory, password, port);
  await expect(operation).rejects.toThrow(message);
  await expect(operation).rejects.not.toThrow(password);
  expect(calls).toBe(1);
  expect(Number(await readFile(marker(), 'utf8'))).toBeGreaterThan(0);
});

const app = 'notes:private_store';
const requestId = '00000000-0000-4000-8000-000000000001';
const encodedApp = encodeURIComponent(app);
const statusRoute = `/api/app-lifecycle/${encodedApp}/job?requestId=${requestId}`;
const observation = (status: AppJob['status']) => ({
  requestId,
  appUrn: app,
  command: 'backup',
  status,
  phase: 'copying',
  startedAt: 1,
  updatedAt: 2,
  cancellable: true,
  message: password,
});

it.each([
  ['backup', true, 'POST', `/api/backups/${encodedApp}/backup`, 201],
  ['update', undefined, 'PATCH', `/api/app-lifecycle/${encodedApp}/update`, 200],
  ['update', false, 'PATCH', `/api/app-lifecycle/${encodedApp}/update`, 200],
] as const)('submits one %s and waits for its exact terminal status (backup setting %s)', async (action, performBackup, method, route, code) => {
  const secret = await getCliSecret(directory);
  const lines: string[] = [];
  let mutations = 0;
  let reads = 0;
  const port = await listen(async (incoming, response) => {
    jwt.verify(incoming.headers.authorization?.slice('Bearer '.length) ?? '', secret, { algorithms: ['HS256'], subject: 'cli' });
    if (incoming.method === method && incoming.url === route) {
      mutations++;
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      expect(body).toBe(action === 'update' ? JSON.stringify({ performBackup: performBackup ?? true }) : '');
      response.writeHead(code).end(JSON.stringify({ requestId }));
      return;
    }
    expect(incoming.method).toBe('GET');
    expect(incoming.url).toBe(statusRoute);
    reads++;
    if (reads === 1) response.writeHead(503).end();
    else {
      const state = reads === 3 ? 'running' : reads === 4 ? 'unconfirmed' : 'succeeded';
      response.writeHead(200).end(JSON.stringify({ job: reads === 2 ? null : { ...observation(state), command: action } }));
    }
  });
  await runAppJob({
    dataDir: directory,
    action,
    app,
    performBackup,
    port,
    pollIntervalMs: 1,
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
  });
  expect(mutations).toBe(1);
  expect(reads).toBe(5);
  expect(lines[0]).toContain(requestId);
  expect(lines[1]).toContain('running: copying');
  expect(lines[2]).toContain('unconfirmed');
  expect(lines[3]).toContain(`completed for ${app}`);
  expect(lines.join(' ')).not.toContain(password);
  expect(await readdir(stateDirectory())).toEqual([]);
});

it.each([
  ['failed', observation('failed')],
  ['cancelled', observation('cancelled')],
  ['interrupted', observation('interrupted')],
  ['different job', { ...observation('succeeded'), appUrn: 'notes:another_store' }],
  ['different job', { ...observation('succeeded'), command: 'update' }],
  ['different job', { ...observation('succeeded'), requestId: '00000000-0000-4000-8000-000000000002' }],
  ['invalid job status', { ...observation('succeeded'), status: 'done' }],
])('reports %s as a non-success, without replay or raw server output', async (message, job) => {
  await getCliSecret(directory);
  const calls: string[] = [];
  const lines: string[] = [];
  const port = await listen((incoming, response) => {
    calls.push(incoming.method ?? '');
    response.writeHead(incoming.method === 'POST' ? 201 : 200).end(JSON.stringify(incoming.method === 'POST' ? { requestId } : { job }));
  });
  const pending = runAppJob({
    dataDir: directory,
    action: 'backup',
    app,
    port,
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
  });
  await expect(pending).rejects.toThrow(message);
  await expect(pending).rejects.not.toThrow(password);
  expect(calls).toEqual(['POST', 'GET']);
  expect(lines).toHaveLength(1);
});

it.each([303, 401, 409, 500])('does not replay unaccepted or ambiguous admission responses (%d)', async (status) => {
  await getCliSecret(directory);
  const calls: string[] = [];
  const lines: string[] = [];
  const port = await listen((incoming, response) => {
    calls.push(incoming.method ?? '');
    response.writeHead(status, { Location: '/another-route' }).end(JSON.stringify({ debug: password }));
  });
  const pending = runAppJob({
    dataDir: directory,
    action: 'backup',
    app,
    port,
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
  });
  await expect(pending).rejects.toThrow(/could not confirm|did not authorize|reported a conflict/);
  await expect(pending).rejects.not.toThrow(password);
  expect(calls).toEqual(['POST']);
  expect(lines).toEqual([]);
});

it('stops waiting for the exact accepted job after an interrupt without issuing a cancellation or replay', async () => {
  await getCliSecret(directory);
  const quit = new AbortController();
  const calls: string[] = [];
  const lines: string[] = [];
  const port = await listen((incoming, response) => {
    calls.push(incoming.method ?? '');
    response
      .writeHead(incoming.method === 'POST' ? 201 : 200)
      .end(JSON.stringify(incoming.method === 'POST' ? { requestId } : { job: observation('running') }));
  });
  await expect(
    runAppJob({
      dataDir: directory,
      action: 'backup',
      app,
      port,
      signal: quit.signal,
      write: (line) => {
        lines.push(line);
        if (lines.length === 2) quit.abort();
      },
    }),
  ).rejects.toThrow(`Stopped waiting for the job. Check Tasks for ${requestId}.`);
  expect(calls).toEqual(['POST', 'GET']);
});

it('requires an exact namespaced app ID and a local CLI key before dispatch', async () => {
  const options = { dataDir: directory, action: 'backup' as const, signal: new AbortController().signal, write: () => undefined };
  await expect(runAppJob({ ...options, app: '../anything:local' })).rejects.toThrow('Specify the app as');
  await expect(runAppJob({ ...options, app })).rejects.toThrow('CLI key is unavailable');
});
