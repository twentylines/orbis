import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { boundedBody, readHistoricalWallpaper, readTimeMachinePoints, reviewTimeMachinePoint } from './time-machine-api';
import { historicalPoint, readyReview } from './time-machine.test-data';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('bounded transport cancels oversized streamed bodies before accepting private metadata or assets', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedBody(new Response(stream), 10)).rejects.toThrow('exceeded');
  expect(cancelled).toBe(true);
  await expect(boundedBody(new Response('x', { headers: { 'Content-Length': '999' } }), 10)).rejects.toThrow('exceeded');
});
test('historical assets use only point-bound identity URLs and enforce MIME, length and available content digest', async () => {
  const point = historicalPoint();
  if (!point.metadata?.preview.available) throw new Error('Fixture preview missing');
  const bytes = new Uint8Array([1, 2, 3]);
  const identity = createHash('sha256').update(bytes).digest('hex');
  point.metadata.preview.wallpaperAsset = {
    available: true,
    identity,
    cipherSha256: 'd'.repeat(64),
    bytes: 3,
    mime: 'image/png',
    width: 1,
    height: 1,
    source: 'captured-builtin',
  };
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const blob = await readHistoricalWallpaper(point, new AbortController().signal);
  expect(blob.size).toBe(3);
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/system-backups/time-machine/points/${point.id}/assets/${identity}`);
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
  globalThis.fetch = mock(async () => new Response(bytes, { headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
  await expect(readHistoricalWallpaper(point, new AbortController().signal)).rejects.toThrow('type changed');
});
test('server review responses must bind the selected sealed point and exact archive digests', async () => {
  const review = readyReview();
  globalThis.fetch = mock(async () => Response.json({ version: 1, review })) as unknown as typeof fetch;
  expect((await reviewTimeMachinePoint(historicalPoint(), new AbortController().signal))?.reviewId).toBe(review.reviewId);
  globalThis.fetch = mock(async () => Response.json({ version: 1, review: { ...review, archiveSha256: 'e'.repeat(64) } })) as unknown as typeof fetch;
  await expect(reviewTimeMachinePoint(historicalPoint(), new AbortController().signal)).rejects.toThrow('point changed');
});

test('capture export lists use the bounded authenticated Time Machine endpoint and validate saved points', async () => {
  const list = { version: 1 as const, available: true, activeCaptureId: null, points: [historicalPoint()] };
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(list));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(await readTimeMachinePoints(new AbortController().signal)).toEqual(list);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system-backups/time-machine/points');
  expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  globalThis.fetch = mock(async () => Response.json({ ...list, points: [{ ...historicalPoint(), metadata: null }] })) as unknown as typeof fetch;
  await expect(readTimeMachinePoints(new AbortController().signal)).rejects.toThrow('unsupported Time Machine response');
});
