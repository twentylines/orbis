import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exportSettingsBundle } from './settings-backup-format';
import { writeSettingsJsonPart } from './settings-backup-json-parts';
import { openSettingsBackupReview } from './settings-backup-review';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';

let root: string;
let restore: () => void;
const passphrase = 'disposable reviewed settings key';
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'settings-review-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.useRealTimers();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const settings = await writeSettingsJsonPart({
    kind: 'settings',
    value: { version: 1, server: { timeZone: 'UTC' }, desktop: { serverName: 'Private display name' } },
    destination: path.join(root, 'settings.orbis'),
    passphrase,
    signal: signal(),
  });
  const dashboard = await writeSettingsJsonPart({
    kind: 'dashboard',
    value: { version: 1, desktop: { density: 'compact' } },
    destination: path.join(root, 'dashboard.orbis'),
    passphrase,
    signal: signal(),
  });
  const source = path.join(root, 'backup.orbis-settings');
  await exportSettingsBundle({
    destination: source,
    directory: path.join(root, 'pack'),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: 'v0.6.1-beta.3',
    parts: [settings, dashboard],
    passphrase,
    signal: signal(),
  });
  const review = await openSettingsBackupReview({ source, directory: path.join(root, 'review'), passphrase, signal: signal() });
  const request = {
    version: 1,
    reviewId: review.summary.reviewId,
    archiveSha256: review.summary.archiveSha256,
    contents: { ...review.summary.available, settings: false },
  };
  return { review, request };
}

it('shows actual contents without leaking values and consumes only the chosen section once', async () => {
  const { review, request } = await fixture();
  expect(review.summary.available).toEqual({ version: 1, settings: true, dashboard: true, wallpapers: false, themes: false, timeMachine: [] });
  expect(review.summary.contents.map((part) => part.kind)).toEqual(['settings', 'dashboard']);
  expect(JSON.stringify(review.summary)).not.toContain('Private display name');
  const consume = vi.fn(async (value) => {
    expect(value.parts).toHaveLength(1);
    expect(value.parts[0].part.kind).toBe('dashboard');
    expect(value.parts[0].payload).toEqual({ version: 1, desktop: { density: 'compact' } });
    expect(Object.isFrozen(value.parts[0].payload.desktop)).toBe(true);
  });
  await review.withSelection(request, consume);
  await expect(review.withSelection(request, consume)).rejects.toThrow();
  expect(consume).toHaveBeenCalledOnce();
  await review.dispose();
});

it('rejects unreviewed additions, changed archive/review identities and expiry before consuming', async () => {
  const { review, request } = await fixture();
  const consume = vi.fn();
  for (const wrong of [
    { ...request, reviewId: randomUUID() },
    { ...request, archiveSha256: 'a'.repeat(64) },
    { ...request, contents: { ...request.contents, themes: true } },
    { ...request, contents: { ...request.contents, timeMachine: [randomUUID()] } },
  ])
    await expect(review.withSelection(wrong, consume)).rejects.toThrow();
  vi.useFakeTimers();
  vi.setSystemTime(review.summary.expiresAt);
  await expect(review.withSelection(request, consume)).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
  await review.dispose();
});

it('keeps staging until an active consumer finishes and refuses overlap', async () => {
  const { review, request } = await fixture();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = review.withSelection(request, async () => {
    entered();
    await gate;
  });
  await ready;
  await expect(review.withSelection(request, vi.fn())).rejects.toThrow();
  const disposed = review.dispose();
  expect((await fs.lstat(path.join(root, 'review'))).isDirectory()).toBe(true);
  release();
  await pending;
  await Promise.all([disposed, review.dispose()]);
  await expect(fs.lstat(path.join(root, 'review'))).rejects.toMatchObject({ code: 'ENOENT' });
});
