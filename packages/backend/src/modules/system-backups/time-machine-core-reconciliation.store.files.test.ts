import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { CoreReconciliationStore, type CoreReconciliationBinding } from './time-machine-core-reconciliation.store';

const directories: string[] = [];
const actor = { ownerId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const inspection = () => ({
  version: 2 as const,
  id: randomUUID(),
  requestId: randomUUID(),
  pointId: randomUUID(),
  ownerId: 1,
  archiveSha256: '3'.repeat(64),
  manifestSha256: '4'.repeat(64),
  actor: { ...actor },
});
const binding = () => {
  const sourcePreparation = inspection();
  return { sourcePreparation, sourceInspection: { ...sourcePreparation, id: randomUUID() }, destinationInspection: inspection() };
};
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-reconciliation-store-'));
  directories.push(dir);
  return new CoreReconciliationStore(dir);
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

it('publishes one durable identity and binds both inspections across concurrent admission and reload', async () => {
  const store = await fixture();
  const selected = binding();
  const requestId = randomUUID();
  const records = await Promise.all(Array.from({ length: 8 }, () => store.reserve(requestId, selected)));
  expect(new Set(records.map((record) => record.id)).size).toBe(1);
  const record = records[0];
  if (!record) throw new Error('Missing admitted record');
  expect(record.sourcePreparation).toEqual(selected.sourcePreparation);
  expect(record.sourceInspection).toEqual(selected.sourceInspection);
  expect(record.destinationInspection).toEqual(selected.destinationInspection);
  expect((await fs.stat(path.join(store.root, `${requestId}.json`))).mode & 0o777).toBe(0o600);
  await store.mark(record, 'requested');
  expect(await store.marked(record, 'settled')).toBe(false);
  await store.mark(record, 'settled');
  expect(await store.recoveryRecords()).toEqual([record]);
  expect(await store.marked(record, 'requested')).toBe(true);
  expect(await store.marked(record, 'settled')).toBe(true);
});

it.each(['sourcePreparation', 'sourceInspection', 'destinationInspection'] as const)(
  'rejects replacement of immutable %s under the same request',
  async (side) => {
    const store = await fixture();
    const selected = binding();
    const requestId = randomUUID();
    const record = await store.reserve(requestId, selected);
    for (const drift of [{ id: randomUUID() }, { archiveSha256: '9'.repeat(64) }, { manifestSha256: '8'.repeat(64) }, { requestId: randomUUID() }]) {
      await expect(store.reserve(requestId, { ...selected, [side]: { ...selected[side], ...drift } })).rejects.toThrow();
    }
    expect(await store.get(requestId)).toEqual(record);
  },
);

it('rejects caller fields, legacy records, mixed owners and actor/session identities', async () => {
  const store = await fixture();
  const selected = binding();
  for (const drift of [
    { version: 1 },
    { ownerId: 2 },
    { extra: true },
    { actor: { ...actor, sessionBinding: '9'.repeat(64) } },
    { actor: { ...actor, securityBinding: '9'.repeat(64) } },
  ]) {
    await expect(
      store.reserve(randomUUID(), {
        ...selected,
        destinationInspection: { ...selected.destinationInspection, ...drift },
      } as CoreReconciliationBinding),
    ).rejects.toThrow();
  }
  await expect(store.reserve(randomUUID(), { ...selected, destinationInspection: selected.sourcePreparation })).rejects.toThrow();
  await expect(store.get('../escape')).rejects.toThrow();
});

it.each(['orphan', 'mismatch', 'mode', 'symlink', 'hardlink', 'unknown'])('keeps %s recovery corruption closed', async (failure) => {
  const store = await fixture();
  const record = await store.reserve(randomUUID(), binding());
  await store.mark(record, 'requested');
  const filename = path.join(store.root, `${record.requestId}.json`);
  const marker = path.join(store.root, `${record.requestId}.requested.json`);
  if (failure === 'orphan') await fs.unlink(filename);
  if (failure === 'mismatch') await fs.writeFile(marker, JSON.stringify({ ...record, id: randomUUID() }));
  if (failure === 'mode') await fs.chmod(filename, 0o644);
  if (failure === 'symlink') {
    await fs.unlink(marker);
    await fs.symlink(filename, marker);
  }
  if (failure === 'hardlink') await fs.link(filename, path.join(store.root, 'extra'));
  if (failure === 'unknown') await fs.writeFile(path.join(store.root, 'unknown.json'), '{}');
  await expect(store.recoveryRecords()).rejects.toThrow();
});

it('never accepts settlement without durable dispatch intent', async () => {
  const store = await fixture();
  const record = await store.reserve(randomUUID(), binding());
  await expect(store.mark(record, 'settled')).rejects.toThrow();
  await fs.writeFile(path.join(store.root, `${record.requestId}.settled.json`), JSON.stringify(record), { mode: 0o600 });
  await expect(store.recoveryRecords()).rejects.toThrow();
});

it('keeps random review identities durable and outside the original operation namespace', async () => {
  const store = await fixture();
  const parent = await store.reserve(randomUUID(), binding());
  const requestId = randomUUID();
  expect(await store.review(requestId, parent)).toBeUndefined();
  const reviewRoot = path.join(path.dirname(store.root), 'core-restoration-reviews');
  await expect(fs.lstat(reviewRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(store.review(requestId, parent, true)).rejects.toThrow();
  await store.mark(parent, 'requested');
  await store.mark(parent, 'settled');
  const records = await Promise.all(Array.from({ length: 4 }, () => store.review(requestId, parent, true)));
  const review = records[0];
  if (!review) throw new Error('Review mapping missing');
  expect(new Set(records.map((value) => value?.id)).size).toBe(1);
  expect(review.id).not.toBe(parent.id);
  expect(review.reconciliationId).toBe(parent.id);
  expect(await store.review(requestId, parent)).toEqual(review);
  expect((await fs.stat(path.join(reviewRoot, `${parent.requestId}.${requestId}.json`))).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(store.root)).toEqual(expect.arrayContaining([`${parent.requestId}.json`]));
  expect((await fs.readdir(store.root)).some((name) => name.includes(requestId))).toBe(false);
  expect(await store.recoveryRecords()).toEqual([parent]);
});

it.each(['parent', 'binding', 'mode', 'hardlink', 'symlink'] as const)('refuses %s review mapping tampering', async (drift) => {
  const store = await fixture();
  const parent = await store.reserve(randomUUID(), binding());
  await store.mark(parent, 'requested');
  await store.mark(parent, 'settled');
  const requestId = randomUUID();
  const review = await store.review(requestId, parent, true);
  if (!review) throw new Error('Review mapping missing');
  const filename = path.join(path.dirname(store.root), 'core-restoration-reviews', `${parent.requestId}.${requestId}.json`);
  if (drift === 'parent' || drift === 'binding')
    await fs.writeFile(
      filename,
      JSON.stringify({
        ...review,
        [drift === 'parent' ? 'reconciliationId' : 'reconciliationSha256']: drift === 'parent' ? randomUUID() : '9'.repeat(64),
      }),
    );
  if (drift === 'mode') await fs.chmod(filename, 0o644);
  if (drift === 'hardlink') await fs.link(filename, `${filename}.alias`);
  if (drift === 'symlink') {
    await fs.rename(filename, `${filename}.held`);
    await fs.symlink(`${filename}.held`, filename);
  }
  await expect(store.review(requestId, parent)).rejects.toThrow();
  expect(await store.recoveryRecords()).toEqual([parent]);
});
