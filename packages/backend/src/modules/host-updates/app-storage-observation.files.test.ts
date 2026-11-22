import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppStorageWitness } from './app-storage-observation';

const canonical = (value: unknown): string =>
  value !== null && typeof value === 'object'
    ? '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    : JSON.stringify(value);
const h = (letter: string) => letter.repeat(64);
let root: string;
let data: string;
let socket: string;
let engine: string;
let hostServer: http.Server;
let engineServer: http.Server;
let calls: unknown[];
let change: (value: Record<string, unknown>) => void;
let status: number;
let delayed: boolean;
let arrived: (() => void) | undefined;
const witnesses: AppStorageWitness[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'as-'));
  data = path.join(root, 'data');
  await fs.mkdir(data);
  socket = path.join(root, 's');
  engine = path.join(root, 'd');
  calls = [];
  change = () => {};
  status = 200;
  delayed = false;
  arrived = undefined;
  engineServer = http.createServer((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  await new Promise<void>((resolve) => engineServer.listen(engine, resolve));
  await fs.chmod(engine, 0o660);
  hostServer = http.createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(parts).toString());
    calls.push({ path: request.url, input, host: request.headers.host });
    arrived?.();
    if (delayed) return;
    const directory = await fs.stat(data, { bigint: true });
    const dock = await fs.stat(engine, { bigint: true });
    const value: Record<string, unknown> = {
      schema: 'orbis.app-storage-observation.v1',
      appUrn: input.appUrn,
      nonce: input.nonce,
      controller: { id: h('a'), imageId: `sha256:${h('b')}`, startedAt: 'fixture-start', definitionSha256: h('c') },
      daemonSha256: h('d'),
      dockerSocket: { device: String(dock.dev), inode: String(dock.ino) },
      hostBasePath: '/fixture/app-data',
      hostPath: '/fixture/app-data/store/demo',
      containerPath: '/app-data/store/demo',
      directory: {
        device: String(directory.dev),
        inode: String(directory.ino),
        uid: Number(directory.uid),
        gid: Number(directory.gid),
        mode: Number(directory.mode & 0o7777n),
      },
      mountTablesSha256: h('e'),
      controllerNamespace: '1:55',
    };
    change(value);
    const body = JSON.stringify({
      ...value,
      bindingSha256: createHash('sha256')
        .update('orbis.app-storage-observation.v1\n' + canonical(value))
        .digest('hex'),
    });
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => hostServer.listen(socket, resolve));
  await fs.chmod(socket, 0o600);
  // The fixture uses real sockets/directories. Only the Engine socket's Root
  // ownership is modeled on macOS; no native Root peer/daemon is claimed.
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation(async (selected, options) => {
    const info = await lstat(selected, options);
    if (String(selected) !== engine || !options?.bigint) return info;
    return new Proxy(info, {
      get(target, key) {
        if (key === 'uid') return 0n;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});
afterEach(async () => {
  for (const witness of witnesses.splice(0)) await witness.close();
  vi.restoreAllMocks();
  for (const server of [hostServer, engineServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await fs.rm(root, { recursive: true, force: true });
});
const options = () => ({ socketPath: socket, appUrn: 'demo:store', localDirectory: data, docker: new Dockerode({ socketPath: engine }) });
async function open() {
  const value = await AppStorageWitness.open(options());
  witnesses.push(value);
  return value;
}

it('binds real filesystem identity and protected HTTP transport to the exact Engine client, with reobservation around effects', async () => {
  await fs.writeFile(path.join(data, 'preserved'), 'original');
  const prior = await fs.stat(data);
  const value = await open();
  let docker: Dockerode | undefined;
  await expect(
    value.use(async (client, observation) => {
      docker = client;
      return observation.hostPath;
    }),
  ).resolves.toBe('/fixture/app-data/store/demo');
  expect(docker).toBeInstanceOf(Dockerode);
  expect(calls).toHaveLength(4);
  for (const call of calls) expect(call).toMatchObject({ path: '/v1/app-storage/observe', host: 'orbis', input: { appUrn: 'demo:store' } });
  expect(new Set(calls.map((value) => (value as { input: { nonce: string } }).input.nonce)).size).toBe(4);
  expect(await fs.readFile(path.join(data, 'preserved'), 'utf8')).toBe('original');
  expect((await fs.stat(data)).ino).toBe(prior.ino);
});

it.each(['directory', 'engine', 'nonce', 'controller'])('refuses a mismatched %s before any caller effect', async (kind) => {
  change = (value) => {
    if (kind === 'directory') value.directory = { ...(value.directory as object), inode: '1' };
    if (kind === 'engine') value.dockerSocket = { device: '1', inode: '1' };
    if (kind === 'nonce') value.nonce = h('f');
    if (kind === 'controller' && calls.length > 1) value.controller = { ...(value.controller as object), id: h('f') };
  };
  await expect(open()).rejects.toThrow(/^The app storage binding could not be verified\.$/);
});

it('refuses remote and custom-agent Engine clients before contacting Host', async () => {
  await expect(AppStorageWitness.open({ ...options(), docker: new Dockerode({ host: '127.0.0.1', port: 2375 }) })).rejects.toThrow();
  const selected = options();
  Reflect.set(selected.docker.modem, 'agent', {});
  await expect(AppStorageWitness.open(selected)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

it('preserves renamed original data and refuses a replacement directory before the effect', async () => {
  await fs.writeFile(path.join(data, 'preserved'), 'original');
  const value = await open();
  await fs.rename(data, path.join(root, 'retained'));
  await fs.mkdir(data);
  const effect = vi.fn();
  await expect(value.use(effect)).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, 'retained/preserved'), 'utf8')).toBe('original');
});

it('refuses data aliases and exposed Host socket permissions', async () => {
  const alias = path.join(root, 'alias');
  await fs.symlink(data, alias);
  await expect(AppStorageWitness.open({ ...options(), localDirectory: alias })).rejects.toThrow();
  await fs.chmod(socket, 0o666);
  await expect(open()).rejects.toThrow();
});

it('detects Host binding drift before callback and after a possible effect', async () => {
  const value = await open();
  change = (metadata) => {
    metadata.daemonSha256 = h('f');
  };
  const refused = vi.fn();
  await expect(value.use(refused)).rejects.toThrow();
  expect(refused).not.toHaveBeenCalled();
  change = () => {};
  const effect = vi.fn(async () => {
    change = (metadata) => {
      metadata.mountTablesSha256 = h('f');
    };
    return 'effect finished';
  });
  await expect(value.use(effect)).rejects.toThrow();
  expect(effect).toHaveBeenCalledOnce();
});

it('rejects concurrent use or close while a checked effect is active, and rejects use after close', async () => {
  const value = await open();
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = value.use(async () => {
    entered?.();
    await hold;
  });
  await ready;
  await expect(value.use(async () => {})).rejects.toThrow();
  await expect(value.close()).rejects.toThrow();
  release?.();
  await pending;
  await value.close();
  await expect(value.use(async () => {})).rejects.toThrow();
});

it('cancels an outstanding HTTP observation without calling any effect', async () => {
  delayed = true;
  const abort = new AbortController();
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const checked = expect(AppStorageWitness.open({ ...options(), signal: abort.signal })).rejects.toThrow(
    /^The app storage binding could not be verified\.$/,
  );
  await ready;
  abort.abort();
  await checked;
});

it('handles old or unavailable Host routes as unqualified storage', async () => {
  status = 404;
  await expect(open()).rejects.toThrow(/^The app storage binding could not be verified\.$/);
});
