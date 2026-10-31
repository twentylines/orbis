import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { HostUpdatesService } from './host-updates.service';
import { controllerConfigPaths, type ControllerCaptureIdentity } from './host-controller-config';

const identity: ControllerCaptureIdentity = {
  pointId: '11111111-1111-4111-8111-111111111111',
  controllerId: 'a'.repeat(64),
  imageId: `sha256:${'b'.repeat(64)}`,
};
const privateBytes = Buffer.from('FIXTURE_PRIVATE_VALUE=not-a-real-secret\n');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
function packet() {
  const files = controllerConfigPaths.map((name) =>
    name === 'user-config/tipi-compose.yml' || name === 'orbis-host-compose.yml'
      ? { path: name, present: false }
      : {
          path: name,
          present: true,
          bytes: privateBytes.length,
          mode: 0o600,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          device: '1',
          inode: '2',
          mtimeNs: '1793404800000000000',
          ctimeNs: '1793404800000000000',
          sha256: hash(privateBytes),
          data: privateBytes.toString('base64'),
        },
  );
  const controller = {
    id: identity.controllerId,
    imageId: identity.imageId,
    imageReference: `ghcr.io/twentylines/orbis@sha256:${'c'.repeat(64)}`,
    project: 'runtipi',
    service: 'runtipi',
    startedAt: '2026-10-31T00:00:00Z',
    releaseTag: 'v0.5.0-beta.1',
    releaseDigest: `sha256:${'c'.repeat(64)}`,
  };
  const rootIdentity = {
    device: '1',
    inode: '2',
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    mode: 0o700,
    pathSha256: hash('configured-root-fixture'),
  };
  const descriptor = {
    version: 1,
    pointId: identity.pointId,
    controller,
    rootIdentity,
    files: files.map((file) => {
      const { data: _data, ...metadata } = file;
      return metadata;
    }),
  };
  return { ...descriptor, files, configurationSetSha256: hash(`orbis.controller-config.v1\n${canonical(descriptor)}`) };
}
let directory: string;
let socket: string;
let server: http.Server;
let service: HostUpdatesService;
let payload: unknown;
let status = 200;
let afterRead: (() => Promise<void>) | undefined;
const requests: { path: string; body: unknown }[] = [];
const originalSocket = process.env.ORBIS_HOST_SOCKET;
function client(endpoint: string) {
  process.env.ORBIS_HOST_SOCKET = endpoint;
  const value = new HostUpdatesService({} as never, {} as never);
  process.env.ORBIS_HOST_SOCKET = originalSocket;
  return value;
}
beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-config-client-')));
  socket = path.join(directory, 'host.sock');
  server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url ?? '', body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/status') {
      response.end(JSON.stringify({ available: true, capabilities: ['controller-config.v1'], enrolled: true }));
      return;
    }
    if (afterRead) await afterRead();
    response.statusCode = status;
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  service = client(socket);
});
beforeEach(() => {
  requests.length = 0;
  payload = packet();
  status = 200;
  afterRead = undefined;
});
afterEach(async () => {
  await fs.chmod(directory, 0o700);
  await fs.chmod(socket, 0o600);
});
afterAll(async () => {
  process.env.ORBIS_HOST_SOCKET = originalSocket;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await fs.rm(directory, { recursive: true, force: true });
});

it('connects the private client to the fixed Unix route and returns immutable private bytes bound to point/controller/image', async () => {
  const result = await service.captureControllerConfiguration(identity);
  expect(requests).toEqual([{ path: '/v1/controller-config/capture', body: identity }]);
  expect(result.metadata.pointId).toBe(identity.pointId);
  expect(result.metadata.controller.id).toBe(identity.controllerId);
  expect(result.metadata.controller.imageId).toBe(identity.imageId);
  expect(result.read('.env')).toEqual(privateBytes);
  result.read('.env')?.fill(0);
  expect(result.read('.env')).toEqual(privateBytes);
  expect(result.read('orbis-host-compose.yml')).toBeNull();
  expect(Object.isFrozen(result.metadata.files)).toBe(true);
  expect(() => JSON.stringify(result)).toThrow('private');
  expect(JSON.stringify(result.metadata)).not.toContain(privateBytes.toString('base64'));
  expect(JSON.stringify(result.metadata)).not.toContain(privateBytes.toString());
});

it('never merges capture payloads into ordinary host status or calls its unbounded status path during capture', async () => {
  await service.captureControllerConfiguration(identity);
  expect(requests.every((request) => request.path === '/v1/controller-config/capture')).toBe(true);
  const ordinary = await service.status();
  expect(ordinary).toEqual({ available: true, capabilities: ['controller-config.v1'], enrolled: true });
  expect(JSON.stringify(ordinary)).not.toContain(privateBytes.toString('base64'));
  expect(JSON.stringify(ordinary)).not.toContain('rootIdentity');
});

it('copies the exact caller binding before asynchronous socket work', async () => {
  const caller = { ...identity };
  const pending = service.captureControllerConfiguration(caller);
  caller.pointId = '22222222-2222-4222-8222-222222222222';
  expect((await pending).metadata.pointId).toBe(identity.pointId);
  expect(requests).toEqual([{ path: '/v1/controller-config/capture', body: identity }]);
});

it.each(['point', 'controller', 'image', 'file-hash', 'set-hash', 'unknown-file', 'unknown-field', 'bad-base64'] as const)(
  'rejects mismatched %s without returning payload or helper details',
  async (change) => {
    const value = packet();
    const first = value.files[0];
    if (!first) throw new Error('Missing fixed-file fixture.');
    if (change === 'point') value.pointId = '22222222-2222-4222-8222-222222222222';
    if (change === 'controller') value.controller.id = 'd'.repeat(64);
    if (change === 'image') value.controller.imageId = `sha256:${'e'.repeat(64)}`;
    if (change === 'file-hash') Reflect.set(first, 'sha256', 'f'.repeat(64));
    if (change === 'set-hash') value.configurationSetSha256 = 'f'.repeat(64);
    if (change === 'unknown-file') Reflect.set(first, 'path', '../outside');
    if (change === 'unknown-field') Reflect.set(value, 'debug', privateBytes.toString());
    if (change === 'bad-base64') Reflect.set(first, 'data', `${privateBytes.toString('base64')}\n`);
    payload = value;
    await expect(service.captureControllerConfiguration(identity)).rejects.toThrow('Controller configuration capture requires');
  },
);

it('rejects invalid caller identity before sending a request and reports an old helper explicitly', async () => {
  await expect(service.captureControllerConfiguration({ ...identity, pointId: '../outside' })).rejects.toThrow();
  await expect(service.captureControllerConfiguration({ ...identity, root: '/not-allowed' } as ControllerCaptureIdentity)).rejects.toThrow();
  expect(requests).toEqual([]);
  status = 404;
  payload = { error: 'PRIVATE_FIXTURE' };
  await expect(service.captureControllerConfiguration(identity)).rejects.toThrow('controller-config.v1');
});

it('refuses permissive sockets, aliased parents and a parent changed during the request', async () => {
  await fs.chmod(socket, 0o666);
  await expect(service.captureControllerConfiguration(identity)).rejects.toThrow();
  expect(requests).toEqual([]);
  await fs.chmod(socket, 0o600);
  const alias = path.join(directory, 'alias');
  await fs.symlink(directory, alias);
  await expect(client(path.join(alias, 'host.sock')).captureControllerConfiguration(identity)).rejects.toThrow();
  expect(requests).toEqual([]);
  afterRead = () => fs.chmod(directory, 0o710);
  await expect(service.captureControllerConfiguration(identity)).rejects.toThrow();
});

it('bounds responses and never forwards untrusted helper error content', async () => {
  payload = 'x'.repeat(6 * 1024 * 1024 + 1);
  await expect(service.captureControllerConfiguration(identity)).rejects.toThrow('Controller configuration capture requires');
  status = 409;
  payload = { error: privateBytes.toString() };
  const error = await service.captureControllerConfiguration(identity).catch((value) => value);
  expect(String(error)).not.toContain(privateBytes.toString());
  expect(String(error)).not.toContain(directory);
});

it('verifies the actual Python service response through the actual Unix client with an explicit Docker identity fixture', async () => {
  const child = spawn('python3', [path.resolve('../../scripts/test_orbis_host_controller_config.py'), '--serve-client-fixture'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on('data', () => undefined);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let fixtureSocket: string | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const line = await new Promise<string>((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error('Private service fixture did not become ready.')), 5000);
      lines.once('line', (line) => resolve(line));
      child.once('error', () => reject(new Error('Private service fixture could not start.')));
      child.once('exit', () => reject(new Error('Private service fixture stopped before readiness.')));
    });
    clearTimeout(readyTimer);
    const endpoint = JSON.parse(line) as ControllerCaptureIdentity & { socket: string };
    fixtureSocket = endpoint.socket;
    const capture = await client(endpoint.socket).captureControllerConfiguration({
      pointId: endpoint.pointId,
      controllerId: endpoint.controllerId,
      imageId: endpoint.imageId,
    });
    expect(capture.metadata.pointId).toBe(endpoint.pointId);
    expect(capture.metadata.controller.id).toBe(endpoint.controllerId);
    expect(capture.metadata.controller.imageId).toBe(endpoint.imageId);
    expect(capture.read('.env')).toEqual(privateBytes);
    expect(capture.metadata.configurationSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => JSON.stringify(capture)).toThrow('private');
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((_resolve, reject) => {
          expiryTimer = setTimeout(() => reject(new Error('Private service fixture did not expire.')), 7000);
        }),
      ]);
      expect(child.exitCode).toBe(0);
    } finally {
      clearTimeout(expiryTimer);
    }
  } finally {
    clearTimeout(readyTimer);
    lines.close();
    child.kill('SIGTERM');
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 3000);
      }),
    ]);
    clearTimeout(cleanupTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  if (fixtureSocket) await expect(fs.stat(path.dirname(fixtureSocket))).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);
