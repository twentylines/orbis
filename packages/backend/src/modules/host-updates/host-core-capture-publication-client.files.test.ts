import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalPublicationJson } from './host-controller-publication';
import { HostCoreCapturePublicationClient } from './host-core-capture-publication-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const h = (v: string) => v.repeat(64);
const binding = { id: '11111111-1111-4111-8111-111111111111', sourceSha256: h('a'), sourceHoldSha256: h('b') };
const signal = () => new AbortController().signal;
async function fixture(extra = false) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sp-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socketRoot = await fs.mkdtemp(path.join(await fs.realpath(process.env.ORBIS_CORE_SOCKET_TEST_DIR ?? os.tmpdir()), 'sp-'));
  cleanup.push(() => fs.rm(socketRoot, { recursive: true, force: true }));
  const socket = path.join(socketRoot, 's');
  const directory = path.join(root, 'd');
  await fs.mkdir(directory, { mode: 0o700 });
  const contents: Record<string, Buffer> = {
    'point.json': Buffer.from('point'),
    'metadata.orbis': Buffer.from('metadata'),
    'capture-draft.orbis': Buffer.from('draft'),
    'core.orbis': Buffer.alloc(100, 42),
    ...(extra ? { 'wallpaper.orbis': Buffer.from('wallpaper'), 'icons.orbis': Buffer.from('icons') } : {}),
  };
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }]));
  const expectation = {
    pointId: binding.id,
    sourceSha256: binding.sourceSha256,
    checkpointSha256: h('c'),
    captureReceiptSha256: h('d'),
    resourceCount: 1,
    images: { controller: `sha256:${h('e')}`, database: `sha256:${h('f')}`, queue: `sha256:${h('f')}` },
    compatibility: { os: 'linux', architecture: 'amd64', database: { engine: 'postgresql', major: 16 }, storageFormat: 'physical-pgdata.v1' },
    checkpoint: { bytes: 1, sha256: h('0') },
  };
  const core = {
    schema: 'orbis.core-capture-publication.v1',
    pointId: binding.id,
    ownerId: 1,
    createdAt: 1,
    pointSha256: sha(contents['point.json'] ?? ''),
    pointReservationSha256: h('1'),
    metadataSha256: sha(contents['metadata.orbis'] ?? ''),
    cipherBytes: 100,
    cipherSha256: sha(contents['core.orbis'] ?? ''),
    manifestSha256: h('2'),
    imageInventorySha256: h('3'),
    captureReceiptSha256: expectation.captureReceiptSha256,
    sourceSha256: binding.sourceSha256,
    checkpointSha256: expectation.checkpointSha256,
    checkpoint: expectation.checkpoint,
    resourceCount: 1,
    imageCount: 2,
  };
  const publication = { schema: 'orbis.core-capture-catalog-publication.v1', core, keyId: h('4'), files };
  const state = {
    capabilityStatus: 200,
    capability: {
      schema: 'orbis.core-capture-sentinel-reader.v1',
      version: 1,
      operations: ['sentinel-publication', 'sentinel-file'],
      pointVersion: 3,
      lifecycleAuthority: false,
    } as unknown,
    status: {
      ...binding,
      version: 1,
      publisher: 'sentinel.v1',
      state: 'verified',
      receiptSha256: h('5'),
      publicationSha256: sha(canonicalPublicationJson(publication)),
      preparationSha256: h('6'),
      terminalSha256: h('7'),
      pointReservationSha256: h('1'),
      publication,
      expectation,
    } as Record<string, unknown>,
    changed: false,
    corrupt: false,
    truncated: false,
    encoding: false,
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url?.endsWith('/sentinel-file')) {
      const original = contents[body.fileName] ?? Buffer.alloc(0);
      const data = state.corrupt ? Buffer.alloc(original.length) : original;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': data.length,
        ...(state.encoding ? { 'Content-Encoding': 'gzip' } : {}),
      });
      res.end(state.truncated ? data.subarray(0, data.length - 1) : data);
      return;
    }
    const isCapability = req.method === 'GET';
    const value = isCapability ? state.capability : state.changed ? { ...state.status, terminalSha256: h('8') } : state.status;
    const data = Buffer.from(JSON.stringify(value));
    res.writeHead(isCapability ? state.capabilityStatus : 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': data.length,
    });
    res.end(data);
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
  return { state, contents, socket, directory, client: new HostCoreCapturePublicationClient(socket) };
}
it('negotiates valid old-service 404 but rejects malformed fallback', async () => {
  const f = await fixture();
  expect(await f.client.negotiate(signal())).toBe(true);
  f.state.capabilityStatus = 404;
  f.state.capability = { error: 'not found' };
  expect(await f.client.negotiate(signal())).toBe(false);
  f.state.capability = { error: 'not found', extra: true };
  await expect(f.client.negotiate(signal())).rejects.toThrow();
});
it.each([false, true])('downloads the %s optional file set and consumes tokens', async (extra) => {
  const f = await fixture(extra);
  const token = await f.client.prepare(binding, signal());
  const progress: number[] = [];
  const result = await f.client.download(token, f.directory, signal(), (n) => progress.push(n));
  expect(result.pointReservationSha256).toBe(h('1'));
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(Object.values(f.contents).reduce((n, v) => n + v.length, 0));
  for (const [name, bytes] of Object.entries(f.contents)) expect(await fs.readFile(path.join(f.directory, name))).toEqual(bytes);
  await expect(f.client.download(token, f.directory, signal())).rejects.toThrow();
});
it('rejects changed metadata, corrupt bytes and unknown staging content without consuming evidence', async () => {
  const f = await fixture();
  let token = await f.client.prepare(binding, signal());
  f.state.changed = true;
  await expect(f.client.download(token, f.directory, signal())).rejects.toThrow();
  expect((await fs.readdir(f.directory)).length).toBeGreaterThan(0);
  const other = await fixture();
  token = await other.client.prepare(binding, signal());
  other.state.corrupt = true;
  await expect(other.client.download(token, other.directory, signal())).rejects.toThrow();
  await expect(other.client.download(token, other.directory, signal())).rejects.toThrow();
  const third = await fixture();
  token = await third.client.prepare(binding, signal());
  await fs.writeFile(path.join(third.directory, 'unknown'), 'keep');
  await expect(third.client.download(token, third.directory, signal())).rejects.toThrow();
  expect(await fs.readFile(path.join(third.directory, 'unknown'), 'utf8')).toBe('keep');
});
it('rejects mismatched binding and reservation', async () => {
  const f = await fixture();
  await expect(f.client.status({ ...binding, sourceSha256: h('9') }, signal())).rejects.toThrow();
  f.state.status.pointReservationSha256 = h('9');
  await expect(f.client.prepare(binding, signal())).rejects.toThrow();
});

it.each(['ownerId', 'createdAt'])('rejects a zero %s even with a matching publication digest', async (field) => {
  const f = await fixture();
  const publication = f.state.status.publication as { core: Record<string, unknown> };
  publication.core[field] = 0;
  f.state.status.publicationSha256 = sha(canonicalPublicationJson(publication));
  await expect(f.client.prepare(binding, signal())).rejects.toThrow();
});

it.each(['truncated', 'encoding'] as const)('rejects %s transfers and keeps partial evidence', async (kind) => {
  const f = await fixture();
  const token = await f.client.prepare(binding, signal());
  f.state[kind] = true;
  await expect(f.client.download(token, f.directory, signal())).rejects.toThrow();
  expect((await fs.readdir(f.directory)).length).toBeGreaterThan(0);
});
it('rejects foreign tokens, socket identity changes, and insecure staging', async () => {
  const f = await fixture();
  let token = await f.client.prepare(binding, signal());
  await expect(new HostCoreCapturePublicationClient(f.socket).download(token, f.directory, signal())).rejects.toThrow();
  await fs.chmod(f.socket, 0o400);
  await expect(f.client.download(token, f.directory, signal())).rejects.toThrow();
  await fs.chmod(f.socket, 0o600);
  token = await f.client.prepare(binding, signal());
  await fs.chmod(f.directory, 0o755);
  await expect(f.client.download(token, f.directory, signal())).rejects.toThrow();
});
it('does not fall back on transport errors or malformed capability', async () => {
  const f = await fixture();
  f.state.capability = { schema: 'wrong' };
  await expect(f.client.negotiate(signal())).rejects.toThrow();
  const missing = new HostCoreCapturePublicationClient(path.join(path.dirname(f.socket), 'missing'));
  await expect(missing.negotiate(signal())).rejects.toThrow();
});
