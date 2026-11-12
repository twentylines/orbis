import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { historicalPoint } from './time-machine.test-data';
import { readHistoricalAppIcons } from './historical-app-icons';
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==', 'base64');
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const point = historicalPoint();
  if (!point.metadata?.preview.available) throw new Error('Missing preview');
  const descriptor = {
    urn: 'store:notes',
    identity: sha(png),
    bytes: png.length,
    mime: 'image/png' as const,
    width: 2,
    height: 2,
    source: 'captured-installed' as const,
  };
  const body = Buffer.from(JSON.stringify({ version: 1, icons: [{ ...descriptor, data: png.toString('base64') }] }));
  point.metadata.preview.appIcons = { available: true, identity: sha(body), cipherSha256: 'a'.repeat(64), bytes: body.length, icons: [descriptor] };
  return { point, body, asset: point.metadata.preview.appIcons };
}
test('older points do not request icons or substitute current marketplace resources', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error('No current requests allowed');
  }) as unknown as unknown as typeof fetch;
  expect(await readHistoricalAppIcons(historicalPoint(), new AbortController().signal)).toEqual([]);
  expect(calls).toBe(0);
});
test('reads only the exact point-bound bundle and verifies image bytes before returning blobs', async () => {
  const { point, body, asset } = fixture();
  let requested = '';
  globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
    requested = String(url);
    expect(options?.credentials).toBe('same-origin');
    expect(options?.redirect).toBe('error');
    expect(options?.cache).toBe('no-store');
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } });
  }) as unknown as typeof fetch;
  const icons = await readHistoricalAppIcons(point, new AbortController().signal);
  expect(requested).toBe(`/api/system-backups/time-machine/points/${point.id}/icons/${asset.identity}`);
  expect(icons[0]?.urn).toBe('store:notes');
  const icon = icons[0];
  if (!icon) throw new Error('Captured icon is missing');
  expect(Buffer.from(await icon.blob.arrayBuffer())).toEqual(png);
  expect(icons[0]?.blob.type).toBe('image/png');
});
test('rejects changed, truncated or excessive point asset responses', async () => {
  const { point, body } = fixture();
  for (const bytes of [Buffer.from('changed'), body.subarray(0, -1), Buffer.concat([body, Buffer.from('extra')])]) {
    globalThis.fetch = (async () => new Response(bytes, { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(readHistoricalAppIcons(point, new AbortController().signal)).rejects.toThrow();
  }
});
test('rejects arbitrary asset identities before network access and aborts stale reads', async () => {
  const { point, asset } = fixture();
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error('Forbidden');
  }) as unknown as unknown as typeof fetch;
  asset.identity = '../current';
  await expect(readHistoricalAppIcons(point, new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(0);
  const abort = new AbortController();
  abort.abort();
  await expect(readHistoricalAppIcons(fixture().point, abort.signal)).rejects.toThrow();
});

test('rejects an SVG body even when a forged payload labels it as a raster', async () => {
  const { point, asset } = fixture();
  const image = Buffer.from('<svg onload="forbidden()"/>');
  const original = asset.icons[0];
  if (!original) throw new Error('Captured icon fixture is missing');
  const descriptor = { ...original, identity: sha(image), bytes: image.length };
  const body = Buffer.from(JSON.stringify({ version: 1, icons: [{ ...descriptor, data: image.toString('base64') }] }));
  asset.icons = [descriptor];
  asset.identity = sha(body);
  asset.bytes = body.length;
  globalThis.fetch = (async () => new Response(body, { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  await expect(readHistoricalAppIcons(point, new AbortController().signal)).rejects.toThrow();
});

test('preserves every byte value across a large decoded icon and rejects a changed image digest', async () => {
  const { point, asset } = fixture();
  const image = Buffer.alloc(256 * 1024);
  for (let index = 0; index < image.length; index++) image[index] = index % 256;
  png.copy(image, 0, 0, 8);
  const original = asset.icons[0];
  if (!original) throw new Error('Captured icon fixture is missing');
  const descriptor = { ...original, identity: sha(image), bytes: image.length };
  const respond = () => {
    const body = Buffer.from(JSON.stringify({ version: 1, icons: [{ ...descriptor, data: image.toString('base64') }] }));
    asset.icons = [descriptor];
    asset.identity = sha(body);
    asset.bytes = body.length;
    globalThis.fetch = (async () => new Response(body, { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  };
  respond();
  const icons = await readHistoricalAppIcons(point, new AbortController().signal);
  const icon = icons[0];
  if (!icon) throw new Error('Captured icon is missing');
  expect(Buffer.from(await icon.blob.arrayBuffer())).toEqual(image);
  image[image.length - 1] = image.readUInt8(image.length - 1) ^ 1;
  respond();
  await expect(readHistoricalAppIcons(point, new AbortController().signal)).rejects.toThrow();
});
