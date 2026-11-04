import { expect, test } from 'bun:test';
import { advanceCoreUpdate, type CoreUpdateWatch } from './core-update-state';
import {
  observeCoreOperationProgress,
  parseCoreOperationProgress,
  readCoreOperationProgress,
  type CoreOperationProgress,
} from './core-operation-progress';

const id = '11111111-2222-4333-8444-555555555555';
const targetTag = 'v0.6.1-beta.4';
const accepted = () => {
  const watch = advanceCoreUpdate(null, { type: 'accepted', id, targetTag });
  if (!watch) throw new Error('Invalid accepted update fixture');
  return watch;
};
const progress = (phase: NonNullable<CoreOperationProgress['job']>['phase'], state: NonNullable<CoreOperationProgress['job']>['state'] = 'running') =>
  parseCoreOperationProgress({ version: 1, job: { id, targetTag, state, phase } });

test('independent phases update the matching operation during a main-server outage', () => {
  let watch: CoreUpdateWatch | null = accepted();
  for (const [phase, expected] of [
    ['downloading', 'downloading'],
    ['installing', 'updating'],
    ['restarting', 'offline'],
    ['verifying', 'checking'],
  ] as const) {
    watch = observeCoreOperationProgress(watch, progress(phase));
    expect(watch?.phase).toBe(expected);
  }
  expect(observeCoreOperationProgress(null, progress('restarting'))?.id).toBe(id);
});

test('terminal progress never declares the target ready or initiates a fresh terminal watch', () => {
  const completed = progress(null, 'complete');
  expect(observeCoreOperationProgress(accepted(), completed)?.phase).toBe('checking');
  expect(observeCoreOperationProgress(null, completed)).toBeNull();
  const ready = { ...accepted(), phase: 'ready' as const, refreshIssued: true };
  expect(observeCoreOperationProgress(ready, completed)).toBe(ready);
});

test('a different job or target cannot overwrite the accepted operation', () => {
  const watch = accepted();
  const other = progress('restarting');
  if (!other.job) throw new Error('Missing progress fixture');
  other.job.id = '11111111-2222-4333-8444-555555555556';
  expect(observeCoreOperationProgress(watch, other)).toBe(watch);
  other.job.id = id;
  other.job.targetTag = 'v0.6.1-beta.5';
  expect(observeCoreOperationProgress(watch, other)).toBe(watch);
  expect(observeCoreOperationProgress(watch, { version: 1, job: null })).toBe(watch);
});

test('rejects malformed or private progress fields and never copies arbitrary server text', () => {
  const valid = { version: 1, job: { id, targetTag, state: 'running', phase: 'restarting' } };
  for (const input of [
    null,
    { ...valid, token: 'private' },
    { ...valid, job: { ...valid.job, snapshot: '/private/path' } },
    { ...valid, job: { ...valid.job, phase: 'staged' } },
    { ...valid, job: { ...valid.job, state: 'idle' } },
    { ...valid, job: { ...valid.job, download: {} } },
    { ...valid, job: { ...valid.job, id: 'invalid' } },
  ])
    expect(() => parseCoreOperationProgress(input)).toThrow('unavailable');
  expect(observeCoreOperationProgress(accepted(), progress(null, 'failed'))?.phase).toBe('failed');
});

test('reads bounded streamed JSON without needing Orbis or a healthy build response', async () => {
  const original = globalThis.fetch;
  const expected = progress('restarting');
  globalThis.fetch = (async (url, options) => {
    expect(url).toBe('/api/system/core-update-progress');
    expect(options?.cache).toBe('no-store');
    expect(options?.redirect).toBe('error');
    return new Response(JSON.stringify(expected));
  }) as typeof fetch;
  try {
    expect(await readCoreOperationProgress()).toEqual(expected);
  } finally {
    globalThis.fetch = original;
  }
});

test('cancels an oversized progress stream without reading it to completion', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    { preconnect: original.preconnect },
  );
  try {
    await expect(readCoreOperationProgress()).rejects.toThrow('unavailable');
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});
