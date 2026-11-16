import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import { planResetSafetyExports, type ResetSafetyCapture } from './reset-safety-plan';
import {
  verifyResetExportProof,
  withResetExportAccess,
  withResetInventoryAccess,
  withResetExportAccessFromInventory,
  authorizeSettingsPasswordExport,
  withSettingsExportAccess,
  type SettingsExportAccess,
  type ResetInventoryAccess,
  type ResetInventoryBinding,
} from './settings-export-authorization';
import type { ResetCaptureInventory } from './reset-safety-capture-inventory';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';

let root: string;
let machine: TimeMachineService;
let store: TimeMachineStore;
let components: TimeMachineComponentsStore;
let restoreDarwin: () => void;
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const passkeys = { verifySensitive: vi.fn() };

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-capture-inventory-')));
  restoreDarwin = stabilizeDarwinFixtureCreation(() => root);
  auth.operatorActionContext.mockResolvedValue({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: 'synthetic-security' });
  auth.verifySensitiveAction.mockResolvedValue({});
  passkeys.verifySensitive.mockResolvedValue({});
  const config = { get: (key: string) => (key === 'directories' ? { dataDir: root } : false) };
  machine = new TimeMachineService(
    config as never,
    {} as never,
    auth as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: vi.fn(async () => {}) } as never,
  );
  await machine.onModuleInit();
  store = new TimeMachineStore(root);
  components = new TimeMachineComponentsStore(root);
});
afterEach(async () => {
  await machine?.onModuleDestroy();
  vi.restoreAllMocks();
  restoreDarwin?.();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function core(ownerId = 1) {
  const { point } = await store.create(ownerId, 1);
  await store.fail(point, 'capture-failed');
  return store.load(point.id);
}
async function component(corePointId: string, ownerId = 2, id: string = randomUUID()) {
  const point = await components.create(ownerId, id, corePointId, 'a'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'b'.repeat(64),
    apps: [{ urn: 'fixture:store', mountIds: ['c'.repeat(64)] }],
  });
  await components.interrupted(point);
  return components.load(point.id);
}
async function scope<T>(captures: ResetSafetyCapture[], work: () => Promise<T>, users = [1, 2], target = machine) {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts: 'keep', users, captures }).plan;
  const signal = AbortSignal.timeout(15_000);
  const proof = await verifyResetExportProof(auth as never, passkeys as never, {} as Request, 'keep', {
    method: 'password',
    password: 'synthetic password',
  });
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetExportAccess(proof, plan, lease, signal, (access) => target.withResetPreferencesSnapshot({ plan, access, lease, signal }, work)),
  );
}

async function inventory<T = ResetCaptureInventory>(
  work?: (value: ResetCaptureInventory, access: ResetInventoryAccess, binding: ResetInventoryBinding) => Promise<T>,
  target = machine,
) {
  const resetId = randomUUID();
  const accounts = 'keep' as const;
  const signal = AbortSignal.timeout(15_000);
  const proof = await verifyResetExportProof(auth as never, passkeys as never, {} as Request, accounts, {
    method: 'password',
    password: 'synthetic password',
  });
  return withBackupMaintenanceLease(signal, (lease) => {
    const binding = { resetId, accounts, lease, signal };
    return withResetInventoryAccess(proof, binding, async (access) => {
      const value = await target.resetCaptureInventory({ ...binding, access });
      return work ? work(value, access, binding) : value;
    });
  });
}

it('discovers both real stores before planning, without repeating the reset proof or invoking public reconciliation', async () => {
  const saved = await core();
  const selected = await component(saved.id);
  const publicList = vi.spyOn(machine, 'list').mockRejectedValue(new Error('Public list must not be called'));
  await inventory(async (value, access, binding) => {
    const planned = planResetSafetyExports({
      resetId: binding.resetId,
      accounts: binding.accounts,
      users: [1, 2],
      captures: value.captures.map((point) => {
        if (point.effectiveOwnerId === null) throw new Error('Unexpected fixture custody hold');
        return { id: point.id, ownerId: point.effectiveOwnerId };
      }),
    }).plan;
    expect(
      await withResetExportAccessFromInventory(access, planned, (exports) =>
        machine.withResetPreferencesSnapshot(
          {
            plan: planned,
            access: exports,
            lease: binding.lease,
            signal: binding.signal,
          },
          async () => 'complete inventory snapshot',
        ),
      ),
    ).toBe('complete inventory snapshot');
    expect(value.captures.map((point) => point.id).sort()).toEqual([saved.id, selected.id].sort());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.captures)).toBe(true);
    expect(value.captures.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/envelope|nonce|keyId/);
  });
  expect(publicList).not.toHaveBeenCalled();
  expect(auth.verifySensitiveAction).toHaveBeenCalledOnce();
});

it('keeps orphan owners and equal cross-store UUIDs distinct instead of omitting retained captures', async () => {
  const point = await core(19);
  await component(point.id, 23, point.id);
  const value = await inventory();
  expect(value.captures.map((point) => [point.kind, point.id, point.sourceOwnerId, point.effectiveOwnerId, point.version, point.status])).toEqual([
    ['components', point.id, 23, 23, 4, 'interrupted'],
    ['core', point.id, 19, 19, 1, 'failed'],
  ]);
  expect(new Set(value.captures.map((point) => point.metadataSha256)).size).toBe(2);
  expect((await store.load(point.id)).ownerId).toBe(19);
  expect((await components.load(point.id)).ownerId).toBe(23);
});

it('reports unclaimed receipt-backed custody explicitly while retaining the original encrypted owner', async () => {
  const point = await core();
  const operation = {
    version: 1 as const,
    id: randomUUID(),
    controller: 'synthetic',
    accounts: 'remove' as const,
    users: [1, 2],
    phase: 'prepared' as const,
    createdAt: 1,
  };
  await withBackupMaintenanceLease(new AbortController().signal, () => machine.prepareResetOwnership(operation, [1, 2]));
  await machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  auth.operatorActionContext.mockResolvedValue({ userId: 3, sessionBinding: 'replacement-session', securityBinding: 'replacement-security' });
  const value = await inventory();
  expect(value.captures[0]).toMatchObject({ kind: 'core', id: point.id, sourceOwnerId: 1, effectiveOwnerId: null });
  expect((await store.load(point.id)).ownerId).toBe(1);
});

it('withholds pre-plan inventory if real metadata changes between its two reads', async () => {
  const point = await core();
  const list = TimeMachineStore.prototype.list;
  let reads = 0;
  vi.spyOn(TimeMachineStore.prototype, 'list').mockImplementation(async function (this: TimeMachineStore) {
    const value = await list.call(this);
    if (++reads === 1)
      await fs.writeFile(path.join(root, 'backups/time-machine/points', point.id, 'point.json'), JSON.stringify({ ...point, ownerId: 2 }));
    return value;
  });
  await expect(inventory()).rejects.toThrow();
  expect((await store.load(point.id)).ownerId).toBe(2);
});

it('refuses unreadable real metadata before returning a partial pre-plan inventory', async () => {
  const point = await core();
  await fs.writeFile(path.join(root, 'backups/time-machine/points', point.id, 'point.json'), '{}');
  await expect(inventory()).rejects.toThrow();
});

it('inventories a sealed encrypted core without reading its plaintext payload or changing its key custody', async () => {
  const fixture = await coreCapsuleFixture();
  try {
    const key = path.join(fixture.root, 'backups/time-machine/keys/master-v1.key');
    const before = await fs.readFile(key);
    const value = await inventory(undefined, fixture.machine);
    expect(value.captures).toHaveLength(1);
    expect(value.captures[0]).toMatchObject({
      kind: 'core',
      id: fixture.point.id,
      sourceOwnerId: 1,
      effectiveOwnerId: 1,
      version: 3,
      status: 'sealed',
    });
    expect(await fs.readFile(key)).toEqual(before);
    expect((await fixture.store.load(fixture.point.id)).archiveSha256).toBe(fixture.point.archiveSha256);
  } finally {
    await fixture.dispose();
  }
});

it('does not expose pre-plan inventory to ordinary exports or fabricated inventory authority', async () => {
  const point = await core();
  const signal = new AbortController().signal;
  await withBackupMaintenanceLease(signal, async (lease) => {
    await expect(
      machine.resetCaptureInventory({
        resetId: randomUUID(),
        accounts: 'keep',
        lease,
        signal: new AbortController().signal,
        access: {} as ResetInventoryAccess,
      }),
    ).rejects.toThrow();
    const binding = {
      exportId: randomUUID(),
      ownerId: 1,
      selection: { version: 1 as const, settings: true, dashboard: true, wallpapers: true, themes: true, timeMachine: [point.id] },
    };
    const ticket = await authorizeSettingsPasswordExport(auth as never, {} as Request, { password: 'synthetic password' }, binding);
    await withSettingsExportAccess(ticket, binding, signal, async (access: SettingsExportAccess) => {
      await expect(
        machine.resetCaptureInventory({ resetId: randomUUID(), accounts: 'keep', lease, signal, access: access as unknown as ResetInventoryAccess }),
      ).rejects.toThrow();
    });
  });
});

it('rejects a plan that omits a real core-store point before consuming state', async () => {
  const point = await core();
  const consumed = vi.fn(async () => 'partial');
  await expect(scope([], consumed)).rejects.toThrow();
  expect(consumed).not.toHaveBeenCalled();
  expect((await store.load(point.id)).ownerId).toBe(1);
});

it('rejects a plan that omits a real components-store point', async () => {
  const point = await core();
  await component(point.id);
  const consumed = vi.fn(async () => 'partial');
  await expect(scope([{ id: point.id, ownerId: 1 }], consumed)).rejects.toThrow();
  expect(consumed).not.toHaveBeenCalled();
});

it('covers both raw stores including failed metadata without calling the public reconciliation list', async () => {
  const point = await core();
  const selected = await component(point.id);
  const list = vi.spyOn(machine, 'list').mockRejectedValue(new Error('Public list must not be used'));
  const captures = [
    { id: point.id, ownerId: 1 },
    { id: selected.id, ownerId: 2 },
  ];
  expect(await scope(captures, async () => 'snapshot only')).toBe('snapshot only');
  expect(list).not.toHaveBeenCalled();
  expect((await store.load(point.id)).status).toBe('failed');
  expect((await components.load(selected.id)).status).toBe('interrupted');
});

it('detects an external capture added while the state callback runs', async () => {
  await expect(
    scope([], async () => {
      await core();
    }),
  ).rejects.toThrow();
});

it('detects a capture removed while the state callback runs', async () => {
  const point = await core();
  const directory = path.join(root, 'backups/time-machine/points', point.id);
  await expect(
    scope([{ id: point.id, ownerId: 1 }], async () => {
      await fs.rm(directory, { recursive: true });
    }),
  ).rejects.toThrow();
});

it('detects a changed source owner while preserving the replacement metadata', async () => {
  const point = await core();
  await expect(
    scope([{ id: point.id, ownerId: 1 }], async () => {
      await fs.writeFile(path.join(root, 'backups/time-machine/points', point.id, 'point.json'), JSON.stringify({ ...point, ownerId: 2 }));
    }),
  ).rejects.toThrow();
  expect((await store.load(point.id)).ownerId).toBe(2);
});

it('detects component metadata drift even when capture IDs and owners are unchanged', async () => {
  const point = await core();
  const selected = await component(point.id);
  const file = path.join(components.directory(selected.id), 'point.json');
  await expect(
    scope(
      [
        { id: point.id, ownerId: 1 },
        { id: selected.id, ownerId: 2 },
      ],
      async () => {
        await fs.writeFile(file, JSON.stringify({ ...selected, planSha256: 'b'.repeat(64) }));
      },
    ),
  ).rejects.toThrow();
  expect((await components.load(selected.id)).planSha256).toBe('b'.repeat(64));
});

it('fails on unreadable capture metadata instead of reporting an empty inventory', async () => {
  const point = await core();
  await fs.writeFile(path.join(root, 'backups/time-machine/points', point.id, 'point.json'), '{}');
  const consumed = vi.fn(async () => 'partial');
  await expect(scope([], consumed)).rejects.toThrow();
  expect(consumed).not.toHaveBeenCalled();
});

it('refuses an ambiguous cross-store UUID before a partial export can be accepted', async () => {
  const point = await core();
  await component(point.id, 1, point.id);
  const consumed = vi.fn(async () => 'partial');
  await expect(scope([{ id: point.id, ownerId: 1 }], consumed)).rejects.toThrow();
  expect(consumed).not.toHaveBeenCalled();
});

it('rejects a snapshot that outlives service shutdown', async () => {
  await expect(
    scope([], async () => {
      await machine.onModuleDestroy();
    }),
  ).rejects.toThrow();
});

it('uses receipt-backed effective ownership while preserving the original encrypted source owner', async () => {
  const point = await core();
  const selected = await component(point.id);
  const operation = {
    version: 1 as const,
    id: randomUUID(),
    controller: 'synthetic-controller',
    accounts: 'remove' as const,
    users: [1, 2],
    phase: 'prepared' as const,
    createdAt: 1,
  };
  await withBackupMaintenanceLease(new AbortController().signal, async () => machine.prepareResetOwnership(operation, [1, 2]));
  await machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  auth.operatorActionContext.mockResolvedValue({ userId: 3, sessionBinding: 'new-synthetic-session', securityBinding: 'new-synthetic-security' });
  await machine.reconcileResetOwnership(3, {} as Request);
  expect(
    await scope(
      [
        { id: point.id, ownerId: 3 },
        { id: selected.id, ownerId: 3 },
      ],
      async () => 'snapshot only',
      [3],
    ),
  ).toBe('snapshot only');
  expect((await store.load(point.id)).ownerId).toBe(1);
  expect((await components.load(selected.id)).ownerId).toBe(2);
});

it('reads a genuine sealed encrypted core capture without changing its files or key custody', async () => {
  const fixture = await coreCapsuleFixture();
  try {
    const directory = path.join(fixture.root, 'backups/time-machine/points', fixture.point.id);
    const names = await fs.readdir(directory);
    const before = await Promise.all(names.map((name) => fs.readFile(path.join(directory, name))));
    const key = path.join(fixture.root, 'backups/time-machine/keys/master-v1.key');
    const originalKey = await fs.readFile(key);
    expect(await scope([{ id: fixture.point.id, ownerId: 1 }], async () => 'snapshot only', [1, 2], fixture.machine)).toBe('snapshot only');
    for (const [index, name] of names.entries()) expect(await fs.readFile(path.join(directory, name))).toEqual(before[index]);
    expect(await fs.readFile(key)).toEqual(originalKey);
  } finally {
    await fixture.dispose();
  }
});

it('does not bypass quarantined capture custody after a completed reset remains unclaimed', async () => {
  const point = await core();
  const operation = {
    version: 1 as const,
    id: randomUUID(),
    controller: 'synthetic-controller',
    accounts: 'remove' as const,
    users: [1, 2],
    phase: 'prepared' as const,
    createdAt: 1,
  };
  await withBackupMaintenanceLease(new AbortController().signal, async () => machine.prepareResetOwnership(operation, [1, 2]));
  await machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => true);
  auth.operatorActionContext.mockResolvedValue({ userId: 3, sessionBinding: 'new-synthetic-session', securityBinding: 'new-synthetic-security' });
  const consumed = vi.fn(async () => 'partial');
  await expect(scope([{ id: point.id, ownerId: 3 }], consumed, [3])).rejects.toThrow();
  expect(consumed).not.toHaveBeenCalled();
  expect((await store.load(point.id)).ownerId).toBe(1);
});

it('keeps original capture access during preparation when no completion receipt exists', async () => {
  const point = await core();
  const operation = {
    version: 1 as const,
    id: randomUUID(),
    controller: 'synthetic-controller',
    accounts: 'remove' as const,
    users: [1, 2],
    phase: 'prepared' as const,
    createdAt: 1,
  };
  await withBackupMaintenanceLease(new AbortController().signal, async () => machine.prepareResetOwnership(operation, [1, 2]));
  await expect(machine.completeResetOwnership({ ...operation, phase: 'complete' }, async () => false)).rejects.toThrow();
  expect(await scope([{ id: point.id, ownerId: 1 }], async () => 'pre-erase snapshot')).toBe('pre-erase snapshot');
  expect((await store.load(point.id)).ownerId).toBe(1);
});
