import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalPublicationJson } from './host-controller-publication';
import { HostCoreCaptureReader, type CoreCheckpointDownload } from './host-core-capture-reader';
import type { CoreCaptureBinding, CoreCaptureStatus } from './host-core-capture-contract';

vi.unmock('fs');
vi.unmock('node:fs');
vi.unmock('fs/promises');
vi.unmock('node:fs/promises');

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const h = (letter: string) => letter.repeat(64);
const binding: CoreCaptureBinding = { id: '12345678-1234-4234-8234-123456789abc', sourceSha256: h('a'), sourceHoldSha256: h('b') };
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ct-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data');
  await fs.mkdir(directory, { mode: 0o700 });
  const socket = path.join(root, 's');
  const data = Buffer.alloc(160_000, 97);
  const artifact = {
    schema: 'orbis.time-machine-core-checkpoint-artifact.v1' as const,
    pointId: binding.id,
    sourceSha256: binding.sourceSha256,
    checkpointSha256: h('d'),
    captureJobSha256: h('e'),
    portableStorageSha256: h('f'),
    manifestSha256: h('0'),
    resourceCount: 2,
    roleImageIds: { controller: `sha256:${h('1')}`, database: `sha256:${h('2')}`, queue: `sha256:${h('3')}` },
    compatibility: {
      os: 'linux' as const,
      architecture: 'amd64' as const,
      database: { engine: 'postgresql' as const, major: 16 },
      storageFormat: 'physical-pgdata.v1' as const,
    },
    checkpoint: { bytes: data.length, sha256: hash(data) },
  };
  const status: CoreCaptureStatus = {
    version: 1,
    ...binding,
    state: 'resumed-awaiting-publication',
    ready: { captureReceiptSha256: h('c'), checkpointArtifactSha256: hash(canonicalPublicationJson(artifact)), artifact },
  };
  const state = {
    metadata: status as unknown,
    payload: data,
    statusCode: 200,
    contentType: 'application/octet-stream',
    length: data.length,
    cacheControl: 'no-store',
    pause: false,
    requests: [] as { path: string; body: unknown }[],
    statusReads: 0,
    afterTransfer: () => {},
    metadataLength: 0,
  };
  const server = http.createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk));
      state.requests.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(parts).toString()) });
      if (request.url?.endsWith('/status')) {
        state.statusReads++;
        const body = JSON.stringify(state.metadata);
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': state.metadataLength || Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        response.end(body);
      } else {
        response.writeHead(state.statusCode, {
          'Content-Type': state.contentType,
          'Content-Length': state.length,
          'Cache-Control': state.cacheControl,
        });
        if (state.pause) response.write(state.payload.subarray(0, 8192));
        else {
          state.afterTransfer();
          response.end(state.payload);
        }
      }
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fs.chmod(socket, 0o600);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const reader = new HostCoreCaptureReader(socket);
  return { root, directory, socket, data, state, reader, status };
}

it('downloads exact approved bytes and binds the independent capture receipt into the payload expectation', async () => {
  const f = await fixture();
  const token = await f.reader.prepare(binding, signal());
  const progress: number[] = [];
  const saved = await f.reader.download(token, f.directory, signal(), (bytes, total) => {
    expect(total).toBe(f.data.length);
    progress.push(bytes);
  });
  expect(await fs.readFile(saved.checkpointFile)).toEqual(f.data);
  expect((await fs.stat(saved.checkpointFile)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(saved.checkpointFile)).nlink).toBe(1);
  expect(saved.expectation.captureReceiptSha256).toBe(h('c'));
  expect(saved.expectation.checkpoint).toEqual({ bytes: f.data.length, sha256: hash(f.data) });
  expect(saved.expectation.images).toEqual(f.status.ready.artifact.roleImageIds);
  expect(progress.at(0)).toBe(0);
  expect(progress.at(-1)).toBe(f.data.length);
  expect(f.state.requests[1]?.body).toEqual({
    sourceSha256: binding.sourceSha256,
    sourceHoldSha256: binding.sourceHoldSha256,
    captureReceiptSha256: h('c'),
    checkpointArtifactSha256: f.status.ready.checkpointArtifactSha256,
  });
  expect(f.state.statusReads).toBe(2);
  expect(await fs.readdir(f.directory)).toEqual(['checkpoint.tar']);
  await expect(f.reader.download(token, f.directory, signal())).rejects.toThrow();
});

it('rejects forged and foreign capabilities without consuming the owning reader capability', async () => {
  const f = await fixture();
  await expect(f.reader.download({} as CoreCheckpointDownload, f.directory, signal())).rejects.toThrow();
  const token = await f.reader.prepare(binding, signal());
  await expect(new HostCoreCaptureReader(f.socket).download(token, f.directory, signal())).rejects.toThrow();
  expect(f.state.requests).toHaveLength(1);
  await expect(f.reader.download(token, f.directory, signal())).resolves.toBeDefined();
});

it.each(['status', 'type', 'length', 'cache', 'truncated', 'hash'] as const)(
  'rejects a %s transfer failure and removes only its partial file',
  async (mode) => {
    const f = await fixture();
    const token = await f.reader.prepare(binding, signal());
    if (mode === 'status') f.state.statusCode = 409;
    if (mode === 'type') f.state.contentType = 'text/plain';
    if (mode === 'length') f.state.length++;
    if (mode === 'cache') f.state.cacheControl = 'public';
    if (mode === 'truncated') f.state.payload = f.data.subarray(0, f.data.length - 1);
    if (mode === 'hash') f.state.payload = Buffer.alloc(f.data.length, 98);
    await expect(f.reader.download(token, f.directory, signal())).rejects.toThrow();
    expect(await fs.readdir(f.directory)).toEqual([]);
  },
);

it('cancels an incomplete stream and leaves no usable checkpoint', async () => {
  const f = await fixture();
  const token = await f.reader.prepare(binding, signal());
  f.state.pause = true;
  const controller = new AbortController();
  await expect(
    f.reader.download(token, f.directory, controller.signal, (bytes) => {
      if (bytes > 0) controller.abort();
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(f.directory)).toEqual([]);
});

it('preserves an existing destination and refuses socket identity changes', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.directory, 'checkpoint.tar'), 'existing recovery bytes', { mode: 0o600 });
  const token = await f.reader.prepare(binding, signal());
  await expect(f.reader.download(token, f.directory, signal())).rejects.toThrow();
  expect(await fs.readFile(path.join(f.directory, 'checkpoint.tar'), 'utf8')).toBe('existing recovery bytes');
  expect(await fs.readdir(f.directory)).toEqual(['checkpoint.tar']);
  const second = await f.reader.prepare(binding, signal());
  await fs.chmod(f.socket, 0o400);
  await expect(f.reader.download(second, f.directory, signal())).rejects.toThrow();
});

it('rejects changed source status after transfer, and staging permission changes', async () => {
  const f = await fixture();
  const token = await f.reader.prepare(binding, signal());
  f.state.afterTransfer = () => {
    f.state.metadata = { version: 1, ...binding, state: 'recovery-required' };
  };
  await expect(f.reader.download(token, f.directory, signal())).rejects.toThrow();
  expect(await fs.readdir(f.directory)).toEqual([]);
  f.state.metadata = f.status;
  f.state.afterTransfer = () => {};
  const second = await f.reader.prepare(binding, signal());
  await expect(
    f.reader.download(second, f.directory, signal(), (bytes) => {
      if (bytes > 0) chmodSync(f.directory, 0o777);
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(f.directory)).toEqual([]);
});

it('refuses non-ready, overlong and mismatched status responses', async () => {
  const f = await fixture();
  f.state.metadata = { version: 1, ...binding, state: 'reserved' };
  await expect(f.reader.prepare(binding, signal())).rejects.toThrow();
  f.state.metadataLength = 65537;
  await expect(f.reader.status(binding, signal())).rejects.toThrow();
  f.state.metadataLength = 0;
  f.state.metadata = { ...f.status, sourceSha256: h('0') };
  await expect(f.reader.status(binding, signal())).rejects.toThrow();
  await expect(f.reader.status({ ...binding, id: '../../elsewhere' }, signal())).rejects.toThrow();
});
