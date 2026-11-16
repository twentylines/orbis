import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { timeMachineSelectedReceiptSchema } from '@runtipi/common/schemas/time-machine';
import { corePayloadImage, corePayloadTar } from './time-machine-core-payload.fixture';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { HostSelectedCaptureClient } from '../host-updates/host-selected-capture-client';
import type { StoredCoreTimeMachinePoint } from './time-machine-store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acquireBackupMaintenance,
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  setCorePreparationRecoveryRequired,
} from '@/common/backup-maintenance';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';
import {
  authorizeSettingsPasswordExport,
  withSettingsExportAccess,
  verifyResetExportProof,
  withResetExportAccess,
  type SettingsExportAccess,
} from './settings-export-authorization';
import type { AuthService } from '../auth/auth.service';
import type { PasskeyService } from '../auth/passkey.service';

let f: Awaited<ReturnType<typeof coreCapsuleFixture>>;
const signal = () => new AbortController().signal;
const auth = () => f.auth as unknown as AuthService;
const binding = () => ({
  exportId: randomUUID(),
  ownerId: 1,
  selection: { version: 1 as const, settings: true, dashboard: true, wallpapers: true, themes: true, timeMachine: [f.point.id] },
});
const consume = async (value: { source: NodeJS.ReadableStream }) => {
  let bytes = 0;
  for await (const chunk of value.source) bytes += Buffer.byteLength(chunk);
  return bytes;
};
async function ordinary<T>(work: (access: SettingsExportAccess, item: ReturnType<typeof binding>) => Promise<T>, abortSignal = signal()) {
  const item = binding();
  const ticket = await authorizeSettingsPasswordExport(auth(), f.request, f.credentials, item);
  return withSettingsExportAccess(ticket, item, abortSignal, (access) => work(access, item));
}
beforeEach(async () => {
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  setCorePreparationRecoveryRequired(false);
  f = await coreCapsuleFixture();
});
afterEach(async () => {
  setRestoreRecoveryRequired(false);
  setCorePreparationRecoveryRequired(false);
  await f?.dispose();
  expect(backupMaintenanceActive()).toBe(false);
});

it('checks the password once across authorized real sealed v3 reads and retains the public password check', async () => {
  await ordinary(async (access, item) => {
    for (let i = 0; i < 2; i++) {
      expect(await f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), consume)).toBe(f.point.archiveBytes);
    }
  });
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  await f.machine.withPortablePoint(f.point.id, 1, f.request, f.credentials, signal(), consume);
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
});

it('rejects forged, wrong owner, unselected point and closed access before exposing any archive', async () => {
  const callback = vi.fn(consume);
  await expect(f.machine.withPortablePointForExport(f.point.id, 1, {} as SettingsExportAccess, randomUUID(), signal(), callback)).rejects.toThrow();
  let closed: SettingsExportAccess | undefined;
  let exportId = '';
  await ordinary(async (access, item) => {
    closed = access;
    exportId = item.exportId;
    await expect(f.machine.withPortablePointForExport(f.point.id, 2, access, item.exportId, signal(), callback)).rejects.toThrow();
    await expect(f.machine.withPortablePointForExport(randomUUID(), 1, access, item.exportId, signal(), callback)).rejects.toThrow();
    await expect(f.machine.withComponentsPortablePointForExport(randomUUID(), 1, access, item.exportId, signal(), vi.fn())).rejects.toThrow();
  });
  if (!closed) throw new Error('Missing callback-scoped access');
  await expect(f.machine.withPortablePointForExport(f.point.id, 1, closed, exportId, signal(), callback)).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
});

it('keeps ordinary export blocked by held maintenance', async () => {
  await ordinary(async (access, item) => {
    const release = await acquireBackupMaintenance(signal());
    try {
      await expect(f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), consume)).rejects.toThrow();
    } finally {
      release();
    }
  });
});

it('borrows only the actual reset lease after passkey proof, with no password verification', async () => {
  const passkeys = { verifySensitive: vi.fn(async () => f.actor) };
  async function reset(work: (access: SettingsExportAccess, item: ReturnType<typeof binding>) => Promise<void>) {
    const proof = await verifyResetExportProof(auth(), passkeys as unknown as PasskeyService, f.request, 'keep', {
      method: 'passkey',
      challengeId: randomUUID(),
      response: {},
    });
    const item = binding();
    return withBackupMaintenanceLease(signal(), (lease) =>
      withResetExportAccess(
        proof,
        {
          resetId: randomUUID(),
          accounts: 'keep',
          users: [1],
          exports: [item],
        },
        lease,
        signal(),
        (access) => work(access, item),
      ),
    );
  }
  await reset(async (access, item) => {
    expect(await f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), consume)).toBe(f.point.archiveBytes);
    expect(await f.machine.withComponentsPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), vi.fn())).toBeNull();
  });
  for (const hold of [setRestoreRecoveryRequired, setCorePreparationRecoveryRequired]) {
    await expect(
      reset(async (access, item) => {
        hold(true);
        try {
          await f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), consume);
        } finally {
          hold(false);
        }
      }),
    ).rejects.toThrow();
  }
  expect(passkeys.verifySensitive).toHaveBeenCalledTimes(3);
  expect(f.auth.verifySensitiveAction).not.toHaveBeenCalled();
});

it('retains archive integrity verification for authenticated exports', async () => {
  const file = path.join(f.root, 'backups/time-machine/points', f.point.id, 'core.orbis');
  const bytes = await fs.readFile(file);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  await fs.writeFile(file, bytes);
  const callback = vi.fn(consume);
  await expect(
    ordinary((access, item) => f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), callback)),
  ).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
});

it('clears exporting and resolves its completion after callback failure and cancellation', async () => {
  await ordinary(async (access, item) => {
    let done: Promise<void> | undefined;
    const cancelled = new AbortController();
    for (const cancel of [false, true]) {
      const work = f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, cancelled.signal, async (value) => {
        done = Reflect.get(f.machine, 'exporting').done;
        await consume(value);
        if (cancel) {
          cancelled.abort();
          return 0;
        }
        throw new Error('fixture callback failure');
      });
      await expect(work).rejects.toThrow();
      await expect(done).resolves.toBeUndefined();
      expect(Reflect.get(f.machine, 'exporting')).toBeUndefined();
    }
  });
});

it('retains persisted point ownership checks after export authorization', async () => {
  await ordinary(async (access, item) => {
    const callback = vi.fn(consume);
    // The service uses its own real store; modify the persisted owner rather than replacing its ownership gate.
    const file = path.join(f.root, 'backups/time-machine/points', f.point.id, 'point.json');
    const original = await fs.readFile(file);
    const point = JSON.parse(original.toString());
    try {
      await fs.writeFile(file, JSON.stringify({ ...point, ownerId: 2 }));
      await expect(f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), callback)).rejects.toThrow();
    } finally {
      await fs.writeFile(file, original);
    }
    expect(callback).not.toHaveBeenCalled();
  });
});

it('rechecks account authority after asynchronous point reads and refuses successful settlement after revocation', async () => {
  await expect(
    ordinary(async (access, item) =>
      f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), async (value) => {
        await consume(value);
        f.auth.operatorActionContext.mockResolvedValue({ ...f.actor, securityBinding: 'c'.repeat(64) });
        return 1;
      }),
    ),
  ).rejects.toThrow();
  expect(Reflect.get(f.machine, 'exporting')).toBeUndefined();
});

it('retains components ownership and integrity admission, and the original components password API', async () => {
  const components = new TimeMachineComponentsStore(f.root);
  const point = await components.create(1, randomUUID(), f.point.id, 'c'.repeat(64), {
    version: 1,
    reviewId: randomUUID(),
    reviewSha256: 'd'.repeat(64),
    apps: [{ urn: 'notes:_user', mountIds: ['e'.repeat(64)] }],
  });
  const item = binding();
  item.selection.timeMachine = [point.id];
  const ticket = await authorizeSettingsPasswordExport(auth(), f.request, f.credentials, item);
  const callback = vi.fn();
  await withSettingsExportAccess(ticket, item, signal(), async (access) => {
    // A real unsealed components point cannot expose portable entries.
    await expect(f.machine.withComponentsPortablePointForExport(point.id, 1, access, item.exportId, signal(), callback)).rejects.toThrow();
    const file = path.join(components.directory(point.id), 'point.json');
    const original = await fs.readFile(file);
    try {
      await fs.writeFile(file, JSON.stringify({ ...point, ownerId: 2 }));
      await expect(f.machine.withComponentsPortablePointForExport(point.id, 1, access, item.exportId, signal(), callback)).rejects.toThrow();
    } finally {
      await fs.writeFile(file, original);
    }
  });
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  await expect(f.machine.withComponentsPortablePoint(point.id, 1, f.request, f.credentials, signal(), callback)).rejects.toThrow();
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
  expect(callback).not.toHaveBeenCalled();
  expect(Reflect.get(f.machine, 'exporting')).toBeUndefined();
});

it('excludes concurrent portable readers for the entire consume callback', async () => {
  await ordinary(async (access, item) => {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), async (value) => {
      await consume(value);
      entered();
      await gate;
    });
    try {
      await ready;
      await expect(f.machine.withPortablePointForExport(f.point.id, 1, access, item.exportId, signal(), consume)).rejects.toThrow();
    } finally {
      release();
      await work;
    }
  });
});

it('reads genuine sealed v4 publication entries with ordinary access and the actual reset lease', async () => {
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const components = new TimeMachineComponentsStore(f.root);
  const id = randomUUID();
  const mount = 'a'.repeat(64);
  const plan = 'b'.repeat(64);
  const selection = { version: 1 as const, reviewId: randomUUID(), reviewSha256: 'c'.repeat(64), apps: [{ urn: 'notes:_user', mountIds: [mount] }] };
  const point = await components.create(1, id, f.point.id, plan, selection);
  const data = Buffer.from('selected app settings bytes');
  const image = corePayloadImage('docker');
  const included = [{ id: mount, appUrn: 'notes:_user', service: 'notes', destination: '/config', classification: 'app-data', type: 'bind' }];
  const platform = { os: 'linux', architecture: 'arm64' };
  const inspection = { Id: image.item.imageId, Os: 'linux', Architecture: 'arm64', RepoDigests: [] };
  const imageExports = [
    {
      imageId: image.item.imageId,
      platform,
      inspection,
      selected: inspection,
      archive: image.item.archive,
      bytes: image.archive.length,
      sha256: hash(image.archive),
    },
  ];
  const manifest = {
    schema: 'orbis.selected-app-component.v1',
    pointId: id,
    corePointId: f.point.id,
    planSha256: plan,
    capturedAt: Date.now(),
    selection: selection.apps,
    imageExports,
    images: {
      format: 'orbis.selected-image-exports.v1',
      ids: [image.item.imageId],
      bytes: image.archive.length,
      sha256: hash(canonicalPublicationJson(imageExports)),
    },
    mounts: included,
    containers: {},
    entries: [{ path: 'resources/0000/settings.json', type: 'file', bytes: data.length, sha256: hash(data) }],
  };
  const summary = { ...manifest, manifestSha256: hash(canonicalPublicationJson(manifest)), includedStorage: included };
  const { mounts: _mounts, containers: _containers, entries: _entries, imageExports: _imageExports, ...publicSummary } = summary;
  const artifact = corePayloadTar([
    { name: 'resources/0000/settings.json', data },
    { name: `images/${image.item.archive}`, data: image.archive },
    { name: 'manifest.json', data: Buffer.from(canonicalPublicationJson(manifest)) },
  ]);
  const core = f.point as StoredCoreTimeMachinePoint;
  const metadata = await f.store.metadata(core);
  if (metadata.version !== 3) throw new Error('Expected sealed v3 fixture');
  // This is the established synthetic host-client boundary from the components-store tests.
  // The real sealer verifies the app/image tar and creates the protected publication seal.
  const receipt = timeMachineSelectedReceiptSchema.assert({
    schema: 'orbis.selected-capture-receipt.v1',
    pointId: id,
    corePointId: core.id,
    planSha256: plan,
    parentAdmissionSha256: 'd'.repeat(64),
    coreCheckpointSha256: metadata.core.checkpointSha256,
    artifact: { bytes: artifact.length, sha256: hash(artifact) },
    manifest: publicSummary,
    resumedContainerIds: ['e'.repeat(64)],
  });
  const receiptSha256 = hash(canonicalPublicationJson(receipt));
  const client = {
    receipt: vi.fn(async () => ({ version: 1, receipt, receiptSha256 })),
    withArtifact: vi.fn(async (_id, _hash, _receipt, _signal, consume) => consume(Readable.from(artifact))),
  } as unknown as HostSelectedCaptureClient;
  await components.seal(point, core, metadata, f.store, client, signal());
  expect(await components.load(id)).toMatchObject({ version: 4, status: 'sealed' });
  const expected = (await components.entries(await components.load(id), signal())).entries.map((entry) => entry.name).sort();
  expect(expected).toEqual(['apps.orbis', 'capture-draft.orbis', 'components-metadata.orbis', 'core.orbis', 'metadata.orbis']);
  const item = binding();
  item.selection.timeMachine = [id];
  const read = async (access: SettingsExportAccess) =>
    f.machine.withComponentsPortablePointForExport(id, 1, access, item.exportId, signal(), async (value) => {
      expect(value.point).toMatchObject({ id, ownerId: 1, status: 'sealed' });
      expect(value.metadata).toMatchObject({ version: 4, coverage: { appData: true } });
      expect(value.entries.map((entry) => entry.name).sort()).toEqual(expected);
      expect(value.pointKey).toBe(f.key);
      for (const entry of value.entries) expect(hash(await fs.readFile(entry.file))).toBe(entry.sha256);
      return value.entries.length;
    });
  const ticket = await authorizeSettingsPasswordExport(auth(), f.request, f.credentials, item);
  expect(await withSettingsExportAccess(ticket, item, signal(), read)).toBe(5);
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  f.auth.verifySensitiveAction.mockClear();
  const passkeys = { verifySensitive: vi.fn(async () => f.actor) };
  const proof = await verifyResetExportProof(auth(), passkeys as unknown as PasskeyService, f.request, 'keep', {
    method: 'passkey',
    challengeId: randomUUID(),
    response: {},
  });
  expect(
    await withBackupMaintenanceLease(signal(), (lease) =>
      withResetExportAccess(
        proof,
        {
          resetId: randomUUID(),
          accounts: 'keep',
          users: [1],
          exports: [item],
        },
        lease,
        signal(),
        read,
      ),
    ),
  ).toBe(5);
  expect(passkeys.verifySensitive).toHaveBeenCalledOnce();
  expect(f.auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(Reflect.get(f.machine, 'exporting')).toBeUndefined();
});
