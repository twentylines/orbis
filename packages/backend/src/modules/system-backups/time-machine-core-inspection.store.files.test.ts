import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CoreInspectionStore } from './time-machine-core-inspection.store';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
it('does not assume directory link counts used by a particular filesystem', async () => {
  const original = fs.lstat.bind(fs);
  const lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    const info = await original(...args);
    if (info.isDirectory()) Object.defineProperty(info, 'nlink', { value: typeof info.nlink === 'bigint' ? 1n : 1 });
    return info;
  }) as typeof fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(lstat);
  const { store } = await setup();
  const id = randomUUID();
  const record = await store.reserve(id, binding);
  expect(await store.get(id, binding)).toEqual(record);
});
const pointId = randomUUID();
const actor = { ownerId: 1, sessionBinding: '1'.repeat(64), securityBinding: '2'.repeat(64) };
const binding = { pointId, ownerId: 1, archiveSha256: '3'.repeat(64), manifestSha256: '4'.repeat(64), actor };
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-inspection-store-'));
  roots.push(root);
  return { root, store: new CoreInspectionStore(root), directory: path.join(root, 'backups/time-machine/core-inspections') };
}
it('separates new preparation identities from legacy inspection and rejects arbitrary namespaces', async () => {
  const { root, store } = await setup();
  const requestId = randomUUID();
  const records = await Promise.all(
    [
      store,
      ...(['core-bootstrap-inspections', 'core-runtime-enrollments', 'core-target-preparations'] as const).map(
        (namespace) => new CoreInspectionStore(root, namespace),
      ),
    ].map((entry) => entry.reserve(requestId, binding)),
  );
  expect(new Set(records.map((record) => record.id)).size).toBe(4);
  for (const namespace of ['../outside', 'core-inspections/child', 'other'])
    expect(() => new CoreInspectionStore(root, namespace as never)).toThrow();
});
it('persists idempotent dispatch intent without treating it as execution success', async () => {
  const { root } = await setup();
  const store = new CoreInspectionStore(root, 'core-bootstrap-inspections');
  const id = randomUUID();
  await store.reserve(id, binding);
  expect(await store.marked(id, binding, 'requested')).toBe(false);
  await store.mark(id, binding, 'requested');
  await store.mark(id, binding, 'requested');
  const reload = new CoreInspectionStore(root, 'core-bootstrap-inspections');
  expect(await reload.marked(id, binding, 'requested')).toBe(true);
  expect(await reload.marked(id, binding, 'approval-requested')).toBe(false);
  await expect(reload.marked(id, { ...binding, actor: { ...actor, securityBinding: '9'.repeat(64) } }, 'requested')).rejects.toThrow();
  await expect(reload.mark(id, binding, 'complete' as never)).rejects.toThrow();
});
it('rejects a dispatch marker copied from another operation with the same source and actor', async () => {
  const { root } = await setup();
  const store = new CoreInspectionStore(root, 'core-bootstrap-inspections');
  const first = randomUUID();
  const second = randomUUID();
  await store.reserve(first, binding);
  await store.reserve(second, binding);
  await store.mark(first, binding, 'requested');
  const directory = path.join(root, 'backups/time-machine/core-bootstrap-inspections');
  await fs.copyFile(path.join(directory, `${first}.requested.json`), path.join(directory, `${second}.requested.json`));
  await fs.chmod(path.join(directory, `${second}.requested.json`), 0o600);
  await expect(store.marked(second, binding, 'requested')).rejects.toThrow();
});
it('persists a request idempotently across instances and rejects changed point, actor, or hashes', async () => {
  const { root, store } = await setup();
  const requestId = randomUUID();
  const record = await store.reserve(requestId, binding);
  const reloaded = new CoreInspectionStore(root);
  expect(await reloaded.reserve(requestId, binding)).toEqual(record);
  expect(await reloaded.get(requestId, binding)).toEqual(record);
  await expect(reloaded.get(requestId, { ...binding, pointId: randomUUID() })).rejects.toThrow();
  await expect(reloaded.get(requestId, { ...binding, actor: { ...actor, sessionBinding: '9'.repeat(64) } })).rejects.toThrow();
  await expect(reloaded.get(requestId, { ...binding, manifestSha256: '9'.repeat(64) })).rejects.toThrow();
});
it.each(['corrupt', 'symlink', 'hardlink', 'shared'] as const)('rejects %s mapping files', async (kind) => {
  const { root, store, directory } = await setup();
  const id = randomUUID();
  await store.reserve(id, binding);
  const file = path.join(directory, `${id}.json`);
  if (kind === 'corrupt') await fs.writeFile(file, '{}');
  if (kind === 'shared') await fs.chmod(file, 0o644);
  if (kind === 'hardlink') await fs.link(file, path.join(root, 'other'));
  if (kind === 'symlink') {
    await fs.unlink(file);
    await fs.symlink(path.join(root, 'missing'), file);
  }
  await expect(store.get(id, binding)).rejects.toThrow();
});
it('does not dispatch multiple identities when concurrent publication races', async () => {
  const { store } = await setup();
  const id = randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.reserve(id, binding)));
  const successful = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof store.reserve>>> => r.status === 'fulfilled');
  expect(successful.length).toBeGreaterThan(0);
  expect(new Set(successful.map((r) => r.value.id)).size).toBe(1);
  expect((await store.reserve(id, binding)).id).toBe(successful[0]?.value.id);
});

it('admits a new handle after 256 retained requests without scanning or deleting them', async () => {
  const { store, directory } = await setup();
  const first = await store.reserve(randomUUID(), binding);
  for (let index = 1; index < 256; index++) {
    const record = { ...first, requestId: randomUUID(), id: randomUUID() };
    await fs.writeFile(path.join(directory, `${record.requestId}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  }
  const requestId = randomUUID();
  const record = await store.reserve(requestId, binding);
  const open = vi.spyOn(fs, 'open');
  expect(await store.get(requestId, binding)).toEqual(record);
  expect(open.mock.calls.filter(([file]) => String(file).endsWith('.json'))).toHaveLength(1);
  expect(await store.get(first.requestId, binding)).toEqual(first);
  expect((await fs.readdir(directory)).length).toBe(257);
});

it('reads legacy paired records without changing their Root operation or removing evidence', async () => {
  const { store, directory } = await setup();
  const record = { ...(await store.reserve(randomUUID(), binding)), version: 1 };
  const file = path.join(directory, `${record.requestId}.json`);
  await fs.writeFile(file, JSON.stringify(record));
  const point = path.join(directory, pointId);
  await fs.mkdir(point, { mode: 0o700 });
  await fs.writeFile(path.join(point, '0.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  expect(await store.get(record.requestId, binding)).toEqual(record);
  expect(await store.reserve(record.requestId, binding)).toEqual(record);
  expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(record));
  await fs.unlink(path.join(point, '0.json'));
  await expect(store.reserve(record.requestId, binding)).rejects.toThrow();
});

it('rejects a request reused across points before creating another binding', async () => {
  const { store, directory } = await setup();
  const requestId = randomUUID();
  const record = await store.reserve(requestId, binding);
  await expect(store.reserve(requestId, { ...binding, pointId: randomUUID() })).rejects.toThrow();
  expect(await store.get(requestId, binding)).toEqual(record);
  expect(await fs.readdir(directory)).toEqual([`${requestId}.json`]);
});
