import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { decodeCapturedIcons, runHistoricalPreviewTask } from './historical-preview-task';
import { historicalPoint } from './time-machine.test-data';
import { readHistoricalAppIcons } from './historical-icon-reader';
import { readHistoricalWallpaper } from './time-machine-api';
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
});
class HeldWorker {
  static instances: HeldWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = 0;
  constructor() {
    HeldWorker.instances.push(this);
  }
  postMessage(...args: unknown[]) {
    this.posted = [structuredClone(args[0], { transfer: args[1] as Transferable[] }), args[1]];
  }
  terminate() {
    this.terminated++;
  }
}
function hold() {
  HeldWorker.instances = [];
  return () => new HeldWorker() as unknown as Worker;
}
function ready(worker: HeldWorker | undefined) {
  if (!worker) throw new Error('Worker missing');
  worker.onmessage?.({ data: { ready: true } } as MessageEvent);
  return worker;
}
test('cancels and terminates an in-flight worker without accepting a queued stale response', async () => {
  const factory = hold();
  const abort = new AbortController();
  const operation = runHistoricalPreviewTask({ mode: 'digest', bytes: new Uint8Array([1, 2, 3]) }, abort.signal, factory);
  const worker = HeldWorker.instances[0];
  if (!worker?.onmessage) throw new Error('Worker missing');
  ready(worker);
  const queued = worker.onmessage;
  const rejected = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  abort.abort();
  queued({ data: { ok: true, value: 'a'.repeat(64) } } as MessageEvent);
  expect(await rejected).toBeInstanceOf(Error);
  expect(worker.terminated).toBeGreaterThan(0);
  expect(worker.onmessage).toBeNull();
});
test('transfers an owned buffer and terminates the completed worker exactly once', async () => {
  const factory = hold();
  const bytes = new Uint8Array([1, 2, 3]);
  const buffer = bytes.buffer;
  const identity = createHash('sha256').update(bytes).digest('hex');
  const operation = runHistoricalPreviewTask({ mode: 'digest', bytes }, new AbortController().signal, factory);
  const worker = HeldWorker.instances[0];
  if (!worker) throw new Error('Worker missing');
  expect(worker.posted).toHaveLength(0);
  expect(bytes.byteLength).toBe(3);
  ready(worker);
  const task = worker.posted[0] as { bytes: Uint8Array };
  expect(task.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(worker.posted[1]).toEqual([buffer]);
  worker.onmessage?.({ data: { ok: true, value: identity } } as MessageEvent);
  expect(await operation).toBe(identity);
  expect(bytes.byteLength).toBe(0);
  expect(worker.terminated).toBe(1);
});
test('rejects malformed/error worker replies and never starts a worker for an already cancelled task', async () => {
  for (const data of [{ ok: false }, { ok: true, value: 'wrong' }, { ok: true, value: [] }, null]) {
    const factory = hold();
    const operation = runHistoricalPreviewTask({ mode: 'digest', bytes: new Uint8Array() }, new AbortController().signal, factory);
    const rejected = operation.then(
      () => undefined,
      (error: unknown) => error,
    );
    ready(HeldWorker.instances[0]);
    HeldWorker.instances[0]?.onmessage?.({ data } as MessageEvent);
    expect(await rejected).toBeInstanceOf(Error);
    expect(HeldWorker.instances[0]?.terminated).toBe(1);
  }
  const factory = hold();
  const abort = new AbortController();
  abort.abort();
  await expect(runHistoricalPreviewTask({ mode: 'digest', bytes: new Uint8Array() }, abort.signal, factory)).rejects.toThrow();
  expect(HeldWorker.instances).toHaveLength(0);
});
test('falls back after a blocked worker startup without transferring or losing the bytes', async () => {
  const factory = hold();
  const bytes = new Uint8Array([1, 2, 3]);
  const identity = createHash('sha256').update(bytes).digest('hex');
  const operation = runHistoricalPreviewTask({ mode: 'digest', bytes }, new AbortController().signal, factory);
  const worker = HeldWorker.instances[0];
  if (!worker?.onmessage) throw new Error('Worker missing');
  const queuedReady = worker.onmessage;
  let prevented = false;
  worker.onerror?.({
    preventDefault() {
      prevented = true;
    },
  } as ErrorEvent);
  queuedReady({ data: { ready: true } } as MessageEvent);
  expect(await operation).toBe(identity);
  expect(prevented).toBe(true);
  expect(bytes.byteLength).toBe(3);
  expect(worker.posted).toHaveLength(0);
  expect(worker.terminated).toBe(1);
});
test('does not retry a failed worker after ownership was transferred', async () => {
  const factory = hold();
  const bytes = new Uint8Array([1, 2, 3]);
  const operation = runHistoricalPreviewTask({ mode: 'digest', bytes }, new AbortController().signal, factory);
  const rejected = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  const worker = ready(HeldWorker.instances[0]);
  expect(bytes.byteLength).toBe(0);
  worker.onerror?.({ preventDefault() {} } as ErrorEvent);
  expect(await rejected).toBeInstanceOf(Error);
  expect(worker.terminated).toBe(1);
});
test('keeps icon and wallpaper integrity verification on an HTTP host without Web Crypto or Worker', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const identity = createHash('sha256').update(image).digest('hex');
  const descriptor = {
    urn: 'store:notes',
    identity,
    bytes: image.length,
    mime: 'image/png' as const,
    width: 2,
    height: 2,
    source: 'captured-installed' as const,
  };
  const bundle = new TextEncoder().encode(JSON.stringify({ version: 1, icons: [{ ...descriptor, data: Buffer.from(image).toString('base64') }] }));
  const asset = {
    available: true as const,
    identity: createHash('sha256').update(bundle).digest('hex'),
    cipherSha256: 'a'.repeat(64),
    bytes: bundle.length,
    icons: [descriptor],
  };
  expect((await decodeCapturedIcons(bundle, asset, new AbortController().signal))[0]?.blob.size).toBe(image.length);
  const point = historicalPoint();
  if (!point.metadata?.preview.available) throw new Error('Preview missing');
  point.metadata.preview.appIcons = asset;
  globalThis.fetch = (async () => new Response(bundle, { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  expect((await readHistoricalAppIcons(point, new AbortController().signal))[0]?.urn).toBe(descriptor.urn);
  point.metadata.preview.wallpaperAsset = {
    available: true,
    identity,
    cipherSha256: 'b'.repeat(64),
    bytes: image.length,
    mime: 'image/png',
    width: 2,
    height: 2,
    source: 'captured-builtin',
  };
  globalThis.fetch = (async () => new Response(image, { headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch;
  expect((await readHistoricalWallpaper(point, new AbortController().signal)).size).toBe(image.length);
  const changed = image.slice();
  changed[changed.length - 1] = 255;
  globalThis.fetch = (async () => new Response(changed, { headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch;
  await expect(readHistoricalWallpaper(point, new AbortController().signal)).rejects.toThrow('could not be verified');
});
