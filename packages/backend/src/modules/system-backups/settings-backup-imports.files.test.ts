import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupDiskActive } from '@/common/backup-disk';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';
import { exportSettingsBundle } from './settings-backup-format';
import { SettingsBackupImportsService } from './settings-backup-imports.service';
import { writeSettingsJsonPart } from './settings-backup-json-parts';

let root: string;
let restore: () => void;
let service: SettingsBackupImportsService;
const passphrase = 'disposable reviewed settings key';
const credentials = { password: 'test-password' };
const request = {} as never;
const actor = { userId: 1, sessionBinding: 'session', securityBinding: 'security' };
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'settings-import-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  service = new SettingsBackupImportsService(
    { get: () => ({ dataDir: root }) } as never,
    { operatorActionContext: async () => actor, verifySensitiveAction: async () => undefined } as never,
    { inspectors: () => ({}) } as never,
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await service.onModuleDestroy();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
async function bundle() {
  const part = await writeSettingsJsonPart({
    kind: 'settings',
    value: { version: 1, server: { timeZone: 'UTC' }, desktop: { serverName: 'Private name' } },
    destination: path.join(root, 'settings.orbis'),
    passphrase,
    signal: signal(),
  });
  const destination = path.join(root, 'export.orbis');
  await exportSettingsBundle({
    destination,
    directory: path.join(root, 'pack'),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: 'development',
    parts: [part],
    passphrase,
    signal: signal(),
  });
  return fs.readFile(destination);
}
async function uploaded(bytes: Buffer) {
  const job = await service.create(1, request, credentials);
  await service.upload(job.id, 1, Readable.from([bytes]), String(bytes.length), signal());
  return job.id;
}
async function reviewed(id: string) {
  const { start } = await service.review(id, 1, request, credentials, passphrase);
  await start;
  const job = (await service.list(1)).jobs.find((value) => value.id === id);
  if (!job?.review) throw new Error('review failed');
  return { version: 1, reviewId: job.review.reviewId, archiveSha256: job.review.archiveSha256, contents: job.review.available };
}
it('uploads and reviews an actual export, and holds the job through a one-shot callback without holding the disk admission', async () => {
  const id = await uploaded(await bundle());
  const selection = await reviewed(id);
  expect(JSON.stringify(await service.list(1))).not.toContain('Private name');
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const consuming = service.withSelection(id, 1, request, credentials, selection, async (value) => {
    expect(backupDiskActive()).toBe(false);
    expect(value.parts[0]?.payload?.desktop.serverName).toBe('Private name');
    enter();
    await gate;
  });
  await ready;
  let removed = false;
  const removing = service.remove(id, 1, request, credentials).then(() => {
    removed = true;
  });
  await Promise.resolve();
  expect(removed).toBe(false);
  release();
  await consuming;
  await removing;
  expect(removed).toBe(true);
});
it('rejects wrong keys, truncated uploads, foreign owners, and replay after restart', async () => {
  const bytes = await bundle();
  const id = await uploaded(bytes);
  await expect(service.upload(id, 2, Readable.from([bytes]), String(bytes.length), signal())).rejects.toThrow();
  const wrong = await service.review(id, 1, request, credentials, 'wrong passphrase');
  await wrong.start;
  expect((await service.list(1)).jobs[0]?.status).toBe('failed');
  const selection = await reviewed(id);
  await service.onModuleDestroy();
  service = new SettingsBackupImportsService(
    { get: () => ({ dataDir: root }) } as never,
    { operatorActionContext: async () => actor, verifySensitiveAction: async () => undefined } as never,
    { inspectors: () => ({}) } as never,
  );
  await expect(service.withSelection(id, 1, request, credentials, selection, async () => undefined)).rejects.toThrow();
  const second = await service.create(1, request, credentials);
  await expect(service.upload(second.id, 1, Readable.from([bytes.subarray(0, 20)]), String(bytes.length), signal())).rejects.toThrow();
});

it('rejects a second claim and an expired review', async () => {
  const id = await uploaded(await bundle());
  const selection = await reviewed(id);
  await service.withSelection(id, 1, request, credentials, selection, async () => undefined);
  await expect(service.withSelection(id, 1, request, credentials, selection, async () => undefined)).rejects.toThrow();
  const next = await reviewed(id);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 16 * 60_000);
  await expect(service.withSelection(id, 1, request, credentials, next, async () => undefined)).rejects.toThrow();
});
it('cancels an upload waiting on an input stream', async () => {
  const job = await service.create(1, request, credentials);
  const abort = new AbortController();
  const input = new Readable({ read() {} });
  const upload = service.upload(job.id, 1, input, undefined, abort.signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  abort.abort();
  await expect(upload).rejects.toThrow();
  expect((await service.list(1)).jobs[0]?.status).toBe('failed');
});

it('reports an interrupted upload after restart and preserves its partial file until explicit removal', async () => {
  const job = await service.create(1, request, credentials);
  const partial = path.join(root, 'backups', 'settings-imports', job.id, 'upload.partial');
  await fs.writeFile(partial, 'interrupted private upload', { mode: 0o600 });
  await service.onModuleDestroy();
  service = new SettingsBackupImportsService(
    { get: () => ({ dataDir: root }) } as never,
    { operatorActionContext: async () => actor, verifySensitiveAction: async () => undefined } as never,
    { inspectors: () => ({}) } as never,
  );
  expect((await service.list(1)).jobs[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Remove it') });
  await expect(service.upload(job.id, 1, Readable.from(['replacement']), '11', signal())).rejects.toThrow();
  expect(await fs.readFile(partial, 'utf8')).toBe('interrupted private upload');
  await service.remove(job.id, 1, request, credentials);
  expect((await service.list(1)).jobs).toEqual([]);
});
