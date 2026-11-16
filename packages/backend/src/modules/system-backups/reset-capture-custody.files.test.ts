import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import type { ResetJournal } from '../system-reset/reset-contract';
import { ResetCaptureCustody, type ResetCaptureSource } from './reset-capture-custody';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const journal = (users = [1, 2], createdAt = 1000): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: 'controller.test',
  accounts: 'remove',
  users,
  phase: 'prepared',
  createdAt,
});
const source = (ownerId = 1, kind: ResetCaptureSource['kind'] = 'core'): ResetCaptureSource => ({
  kind,
  id: randomUUID(),
  ownerId,
  identitySha256: 'a'.repeat(64),
});
const captureKey = (point: ResetCaptureSource) => `${point.kind}:${point.id}`;
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reset-capture-custody-')));
  await fs.chmod(root, 0o700);
  roots.push(root);
  const directory = path.join(root, 'custody');
  const custody = new ResetCaptureCustody(directory);
  const first = source();
  const second = source(2, 'components');
  const points = [first, second];
  const read = async (kind: ResetCaptureSource['kind'], id: string) => points.find((point) => point.kind === kind && point.id === id);
  return { root, directory, custody, points, first, second, read };
}
async function available(custody: ResetCaptureCustody, operation: ResetJournal, points: ResetCaptureSource[]) {
  await custody.prepare(operation, points);
  await custody.complete({ ...operation, phase: 'complete' }, async () => true);
}

test('a completed reset transfers access without rewriting original capture owners or identity', async () => {
  const f = await fixture();
  const original = structuredClone(f.points);
  const operation = journal();
  await available(f.custody, operation, f.points);
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([null, null]);
  let validations = 0;
  await f.custody.claim(
    3,
    async () => {
      validations++;
    },
    f.read,
  );
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([3, 3]);
  expect(f.points).toEqual(original);
  expect(validations).toBeGreaterThanOrEqual(4);
  expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(f.directory, operation.id, 'record.json'))).mode & 0o777).toBe(0o600);
});

test('uncompleted or unverified resets never authorize a new account', async () => {
  const f = await fixture();
  const operation = journal();
  await f.custody.prepare(operation, f.points);
  await expect(f.custody.complete({ ...operation, phase: 'complete' }, async () => false)).rejects.toThrow();
  await f.custody.claim(
    3,
    async () => {
      throw new Error('must not authorize');
    },
    f.read,
  );
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([1, 2]);
  await expect(f.custody.complete({ ...operation, phase: 'preferences' }, async () => true)).rejects.toThrow();
});

test('completion is bound to the reset cohort and creation time across authorized controller replacement', async () => {
  const f = await fixture();
  const operation = journal();
  await f.custody.prepare(operation, f.points);
  for (const change of [{ users: [1] }, { createdAt: 1001 }])
    await expect(f.custody.complete({ ...operation, ...change, phase: 'complete' }, async () => true)).rejects.toThrow();
  expect((await fs.readdir(f.directory)).some((name) => name.endsWith('.available'))).toBe(false);
  await f.custody.complete({ ...operation, controller: 'replacement.test', phase: 'complete' }, async () => true);
  expect(JSON.parse(await fs.readFile(path.join(f.directory, operation.id, 'record.json'), 'utf8')).controller).toBe(operation.controller);
});

test('prepare resumes the exact immutable inventory across controller replacement and rejects drift', async () => {
  const f = await fixture();
  const operation = journal();
  await f.custody.prepare(operation, f.points);
  await f.custody.prepare(operation, [...f.points].reverse());
  await f.custody.prepare({ ...operation, controller: 'replacement.test' }, f.points);
  await expect(f.custody.prepare(operation, f.points.slice(1))).rejects.toThrow();
  await expect(
    f.custody.prepare(
      operation,
      f.points.map((point) => ({ ...point, identitySha256: 'b'.repeat(64) })),
    ),
  ).rejects.toThrow();
});

test('failed authorization quarantines the whole claim and a restart resumes only its recorded claimant', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  let calls = 0;
  await expect(
    f.custody.claim(
      3,
      async () => {
        if (++calls === 3) throw new Error('session expired');
      },
      f.read,
    ),
  ).rejects.toThrow('session expired');
  const restarted = new ResetCaptureCustody(f.directory);
  expect([...(await restarted.owners(f.points)).values()]).toEqual([null, null]);
  await expect(restarted.claim(4, async () => undefined, f.read)).rejects.toThrow();
  await restarted.claim(3, async () => undefined, f.read);
  expect([...(await restarted.owners(f.points)).values()]).toEqual([3, 3]);
});

test('concurrent claimants cannot split access to captures from the same reset', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  let entered = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const validate = async () => {
    if (++entered === 2) release();
    await barrier;
  };
  const results = await Promise.allSettled([f.custody.claim(3, validate, f.read), new ResetCaptureCustody(f.directory).claim(4, validate, f.read)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const owners = new Set((await f.custody.owners(f.points)).values());
  expect(owners.size).toBe(1);
  expect([3, 4]).toContain([...owners][0]);
});

test('a source replaced under the same identifier cannot inherit a retained capture claim', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  const replaced = { ...f.first, identitySha256: 'c'.repeat(64) };
  await expect(
    f.custody.claim(
      3,
      async () => undefined,
      async (kind, id) => (id === replaced.id ? replaced : f.read(kind, id)),
    ),
  ).rejects.toThrow();
  await expect(f.custody.owners([replaced])).rejects.toThrow();
  expect((await fs.readdir(f.directory)).some((name) => name.endsWith('.claimed'))).toBe(false);
});

test('core and component captures can use the same UUID without sharing their access records', async () => {
  const f = await fixture();
  f.second.id = f.first.id;
  await available(f.custody, journal(), f.points);
  await f.custody.claim(3, async () => undefined, f.read);
  expect((await f.custody.owners(f.points)).size).toBe(2);
  expect((await f.custody.owners([source(4)])).values().next().value).toBe(4);
});

test('a second account-removing reset follows the verified effective owner, preserving the original cryptographic owner', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  await f.custody.claim(3, async () => undefined, f.read);
  await available(f.custody, journal([3], 2000), f.points);
  await f.custody.claim(4, async () => undefined, f.read);
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([4, 4]);
  expect(f.points.map((point) => point.ownerId)).toEqual([1, 2]);
});

test('deleted captures do not block claiming surviving captures, but reusing their UUID remains rejected', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  const removed = f.points.pop();
  if (!removed) throw new Error('missing fixture');
  await f.custody.claim(3, async () => undefined, f.read);
  expect((await f.custody.owners(f.points)).get(captureKey(f.first))).toBe(3);
  await expect(f.custody.owners([{ ...removed, ownerId: 9 }])).rejects.toThrow();
});

test('unknown owners and duplicate sources cannot be admitted', async () => {
  const f = await fixture();
  await expect(f.custody.prepare(journal([1]), f.points)).rejects.toThrow();
  await expect(f.custody.prepare(journal(), [f.first, f.first])).rejects.toThrow();
  await expect(
    f.custody.prepare(
      journal(),
      Array.from({ length: 33 }, () => source()),
    ),
  ).rejects.toThrow();
});

test('successive resets use durable predecessors even when the clock moves backward', async () => {
  const f = await fixture();
  await available(f.custody, journal(), f.points);
  await f.custody.claim(3, async () => undefined, f.read);
  await available(f.custody, journal([3], 500), f.points);
  await f.custody.claim(4, async () => undefined, f.read);
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([4, 4]);
});

test('a forked or missing predecessor cannot grant capture access', async () => {
  for (const mode of ['fork', 'missing'] as const) {
    const f = await fixture();
    await available(f.custody, journal(), f.points);
    await f.custody.claim(3, async () => undefined, f.read);
    const next = journal([3], 2000);
    await available(f.custody, next, f.points);
    const filename = path.join(f.directory, next.id, 'record.json');
    const value = JSON.parse(await fs.readFile(filename, 'utf8'));
    value.captures[0].previousResetId = mode === 'fork' ? null : randomUUID();
    await fs.writeFile(filename, JSON.stringify(value));
    await expect(f.custody.owners(f.points)).rejects.toThrow();
  }
});

test('private authority rejects symlinked records, permissive directories and orphaned claim markers', async () => {
  for (const kind of ['symlink', 'permissions', 'orphan'] as const) {
    const f = await fixture();
    const operation = journal();
    await f.custody.prepare(operation, f.points);
    if (kind === 'symlink') {
      const record = path.join(f.directory, operation.id, 'record.json');
      const original = path.join(f.root, 'retained.json');
      await fs.rename(record, original);
      await fs.symlink(original, record);
    } else if (kind === 'permissions') await fs.chmod(path.join(f.directory, operation.id), 0o755);
    else await fs.rename(path.join(f.directory, operation.id), path.join(f.directory, `${operation.id}.claim`));
    await expect(f.custody.owners(f.points)).rejects.toThrow();
  }
});

test('keeping accounts leaves capture access untouched and creates no custody state', async () => {
  const f = await fixture();
  const operation = { ...journal(), accounts: 'keep' as const };
  await f.custody.prepare(operation, f.points);
  await f.custody.complete({ ...operation, phase: 'complete' }, async () => {
    throw new Error('must not check');
  });
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an explicit global reset preserves captures orphaned by older account resets', async () => {
  const f = await fixture();
  f.first.ownerId = 7;
  const operation = journal();
  await f.custody.prepareForGlobalReset(operation, f.points, [1, 2]);
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, operation.id, 'record.json'), 'utf8'));
  expect(manifest).toMatchObject({ version: 2, users: [1, 2], orphanedOwners: [7] });
  await f.custody.complete({ ...operation, phase: 'complete' }, async () => true);
  // This number was not an active account at reset time; a new operator may receive it.
  await f.custody.claim(7, async () => undefined, f.read);
  expect([...(await f.custody.owners(f.points)).values()]).toEqual([7, 7]);
  expect(f.first.ownerId).toBe(7);
  expect(f.second.ownerId).toBe(2);
});

test('global adoption rejects an empty, duplicated or out-of-scope current account cohort', async () => {
  const f = await fixture();
  for (const users of [[], [1, 1], [1, 3], [0]]) await expect(f.custody.prepareForGlobalReset(journal(), f.points, users)).rejects.toThrow();
  expect(await f.custody.hasReset(journal())).toBe(false);
});
