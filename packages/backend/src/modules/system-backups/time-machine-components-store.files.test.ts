import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { timeMachineCaptureSchema, timeMachineSelectedReceiptSchema } from '@runtipi/common/schemas/time-machine';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';
import { corePayloadImage, corePayloadTar } from './time-machine-core-payload.fixture';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import type { StoredCoreTimeMachinePoint } from './time-machine-store';
import type { HostSelectedCaptureClient } from '../host-updates/host-selected-capture-client';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { exportCapsule, importCapsule, type CapsuleSource } from '../time-machine-capsules/capsule';
import {
  verifyCapsuleContents,
  componentsCapsuleReview,
  withVerifiedCoreCapsuleContents,
  withVerifiedCapsuleContents,
} from '../time-machine-capsules/verify';
import { observeComponentsCatalog, verifyComponentsCatalog } from './time-machine-components-catalog';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fixtures: Awaited<ReturnType<typeof coreCapsuleFixture>>[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
async function fixture(kind: 'docker' | 'oci' = 'docker', corruptImage = false) {
  const f = await coreCapsuleFixture();
  fixtures.push(f);
  const store = new TimeMachineComponentsStore(f.root);
  const id = randomUUID();
  const mount = 'a'.repeat(64);
  const plan = 'b'.repeat(64);
  const selection = { version: 1 as const, reviewId: randomUUID(), reviewSha256: 'c'.repeat(64), apps: [{ urn: 'notes:_user', mountIds: [mount] }] };
  const point = await store.create(1, id, f.point.id, plan, selection);
  const data = Buffer.from('the selected app settings bytes');
  const image = corePayloadImage(kind);
  if (corruptImage) {
    const offset = image.archive.indexOf(Buffer.from('authenticated fixture'));
    if (offset < 0) throw new Error('Expected image layer fixture');
    image.archive[offset] = (image.archive[offset] ?? 0) ^ 1;
  }
  const included = [{ id: mount, appUrn: 'notes:_user', service: 'notes', destination: '/config', classification: 'app-data', type: 'bind' }];
  const platform = { os: 'linux', architecture: 'arm64' };
  const inspection = {
    Id: image.item.imageId,
    Os: 'linux',
    Architecture: 'arm64',
    RepoDigests: [],
    ...(kind === 'oci' ? { Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: image.item.identity.manifestId, platform } }] } : {}),
  };
  const imageExports = [
    {
      imageId: image.item.imageId,
      platform,
      inspection,
      selected: { ...inspection, Id: image.item.identity.manifestId ?? image.item.imageId },
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
  if (metadata.version !== 3) throw new Error('Expected v3 fixture');
  const receipt = timeMachineSelectedReceiptSchema.assert({
    schema: 'orbis.selected-capture-receipt.v1',
    pointId: id,
    corePointId: f.point.id,
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
  return { f, store, point, core, metadata, client, receipt, artifact };
}

it.each(['docker', 'oci'] as const)('captures and seals v4 using an unchanged v3 component and verified %s selected images', async (kind) => {
  const f = await fixture(kind);
  const original = await fs.readFile(path.join(f.f.root, 'backups/time-machine/points', f.core.id, 'point.json'));
  await f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal());
  const point = await f.store.load(f.point.id);
  const metadata = await f.store.metadata(point);
  expect(point).toMatchObject({ version: 4, status: 'sealed' });
  expect(await f.store.public(point)).toMatchObject({ captureBinding: { version: 1, corePointId: f.core.id, componentsPointId: point.id } });
  expect(metadata).toMatchObject({
    version: 4,
    coverage: { appData: true },
    coreComponent: f.metadata,
    selectedComponent: { receipt: f.receipt },
    restore: { ready: false },
  });
  expect(await fs.readFile(path.join(f.f.root, 'backups/time-machine/points', f.core.id, 'point.json'))).toEqual(original);
  expect((await f.store.entries(point, signal())).entries.map((entry) => entry.name).sort()).toEqual([
    'apps.orbis',
    'capture-draft.orbis',
    'components-metadata.orbis',
    'core.orbis',
    'metadata.orbis',
  ]);
  expect(await observeComponentsCatalog(f.f.root, f.core.id)).toMatchObject({
    pointId: point.id,
    corePointId: f.core.id,
    planSha256: f.point.planSha256,
    complete: true,
  });
  expect(await verifyComponentsCatalog(f.f.root, f.core.id, signal())).toMatchObject({ pointId: point.id, complete: true });
});

it('retains unsealed components when a Root-authenticated OCI archive fails image verification', async () => {
  const f = await fixture('oci', true);
  await expect(f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal())).rejects.toThrow();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  const names = await fs.readdir(f.store.directory(f.point.id));
  expect(names).toContain('apps.orbis');
  expect(names).not.toContain('catalog-seal.orbis');
  expect(names).not.toContain('components-metadata.orbis');
  await expect(observeComponentsCatalog(f.f.root, f.core.id)).rejects.toThrow();
});

it('exports and authenticates both components through the new capsule format without restore authority', async () => {
  const f = await fixture();
  await f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal());
  const value = await f.store.entries(await f.store.load(f.point.id), signal());
  const order = ['core.orbis', 'capture-draft.orbis', 'metadata.orbis', 'apps.orbis', 'components-metadata.orbis'];
  const entries = value.entries.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) as CapsuleSource[];
  const destination = path.join(f.f.root, 'selected.orbis-tm');
  await exportCapsule({
    destination,
    pointId: f.point.id,
    createdAt: f.point.createdAt,
    sourceOwnerId: 1,
    pointKey: value.pointKey,
    entries,
    passphrase: f.f.passphrase,
    signal: signal(),
  });
  let reviewed = false;
  const imported = await importCapsule({
    source: destination,
    stagingParent: f.f.root,
    passphrase: f.f.passphrase,
    signal: signal(),
    verify: async (manifest, directory, signal) => {
      expect(manifest.schema).toBe('orbis.time-machine-capsule-private.v3');
      const token = await verifyCapsuleContents({
        manifest,
        directory,
        signal,
        database: f.f.database,
        target: { orbisVersion: 'fixture', runtipiVersion: 'fixture', architecture: 'arm64' },
      });
      expect(await componentsCapsuleReview(token, signal)).toMatchObject({
        pointId: f.point.id,
        restoreSupported: false,
        metadata: { version: 4, selectedComponent: { receipt: f.receipt } },
      });
      await expect(withVerifiedCoreCapsuleContents(token, signal, async () => undefined)).rejects.toThrow();
      await expect(withVerifiedCapsuleContents(token, signal, async () => undefined)).rejects.toThrow();
      reviewed = true;
    },
  });
  expect(reviewed).toBe(true);
  await imported.dispose();
});

it('rejects a mismatched Root plan receipt before copying or sealing any component', async () => {
  const f = await fixture();
  vi.mocked(f.client.receipt).mockResolvedValue({ version: 1, receiptSha256: 'f'.repeat(64), receipt: { ...f.receipt, planSha256: 'f'.repeat(64) } });
  await expect(f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal())).rejects.toThrow();
  expect(f.client.withArtifact).not.toHaveBeenCalled();
  expect(await fs.readdir(f.store.directory(f.point.id))).toEqual(['point.json']);
});
it('observation cannot complete from a sealed point alone and detects changed pinned cipher identities', async () => {
  const f = await fixture();
  await f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal());
  const directory = f.store.directory(f.point.id);
  const witness = path.join(directory, 'catalog-seal.orbis');
  const proof = await fs.readFile(witness);
  await fs.unlink(witness);
  await expect(observeComponentsCatalog(f.f.root, f.core.id)).rejects.toThrow();
  await fs.writeFile(witness, proof, { mode: 0o600 });
  await fs.appendFile(path.join(directory, 'apps.orbis'), Buffer.from([0]));
  await expect(observeComponentsCatalog(f.f.root, f.core.id)).rejects.toThrow();
});
it.each(['disk', 'retention'] as const)('rejects insufficient %s capacity before copying selected components', async (kind) => {
  const f = await fixture();
  if (kind === 'disk') vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 1n, bavail: 1n } as never);
  else vi.spyOn(f.f.store, 'list').mockResolvedValue([{ ...f.core, archiveBytes: 128 * 1024 ** 3 }]);
  await expect(f.store.seal(f.point, f.core, f.metadata, f.f.store, f.client, signal())).rejects.toThrow();
  expect(f.client.withArtifact).not.toHaveBeenCalled();
  expect(await fs.readdir(f.store.directory(f.point.id))).toEqual(['point.json']);
});

it('rejects privileged paths, duplicate apps and unreviewed storage in capture input', () => {
  expect(timeMachineCaptureSchema.allows({ label: 'Orbis only' })).toBe(true);
  expect(
    timeMachineCaptureSchema.allows({
      label: 'Unsafe',
      selection: { version: 1, reviewId: randomUUID(), reviewSha256: 'a'.repeat(64), apps: [{ urn: 'jellyfin:_user', mountIds: ['/media/movies'] }] },
    }),
  ).toBe(false);
  const app = { urn: 'notes:_user', mountIds: ['a'.repeat(64)] };
  expect(
    timeMachineCaptureSchema.allows({
      label: 'Duplicate',
      selection: { version: 1, reviewId: randomUUID(), reviewSha256: 'a'.repeat(64), apps: [app, app] },
    }),
  ).toBe(false);
});
