import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HostCoreCaptureReader } from '../host-updates/host-core-capture-reader';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { backupMetadataBytes } from './backup-crypto';
import type { RetainedImagePlatform } from './backup-image-retention';
import { createCorePayloadFixture } from './time-machine-core-payload.fixture';
import { saveCoreCapture } from './time-machine-core-save';
import { TimeMachineStore, type TimeMachineCoreDraftMetadata, type StoredCoreTimeMachinePoint } from './time-machine-store';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const signal = () => new AbortController().signal;
function metadata(point: StoredCoreTimeMachinePoint, compatibility: TimeMachineCoreDraftMetadata['compatibility']): TimeMachineCoreDraftMetadata {
  return {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: 'Saved Orbis capture',
    source: 'manual',
    software: { orbis: '0.8.0-beta.2', runtipi: 'fixture', architecture: compatibility.architecture },
    coverage: {
      database: true,
      configuration: true,
      appearance: true,
      controllerConfiguration: true,
      controllerVersion: true,
      dockerImages: true,
      appData: false,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [{ code: 'activation-not-integrated', message: 'Restore is not integrated.' }] },
    preview: { available: false, reason: { code: 'preview-not-captured', message: 'No preview in this fixture.' } },
    breakdown: [],
    excludedApps: [],
    restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
    compatibility,
  };
}

async function fixture(kind: 'docker' | 'oci' = 'docker') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cs-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const payload = await createCorePayloadFixture(kind);
  cleanup.push(() => fs.rm(payload.root, { recursive: true, force: true }));
  const store = new TimeMachineStore(root);
  const created = await store.create(1, 3);
  const checkpointDirectory = path.join(root, 'checkpoint');
  const imageDirectory = path.join(root, 'images');
  await fs.mkdir(checkpointDirectory, { mode: 0o700 });
  await fs.mkdir(imageDirectory, { mode: 0o700 });
  const expectation = payload.options.expectation;
  const binding = { id: created.point.id, sourceSha256: expectation.sourceSha256, sourceHoldSha256: 'b'.repeat(64) };
  const artifact = {
    schema: 'orbis.time-machine-core-checkpoint-artifact.v1',
    pointId: created.point.id,
    sourceSha256: expectation.sourceSha256,
    checkpointSha256: expectation.checkpointSha256,
    captureJobSha256: 'c'.repeat(64),
    portableStorageSha256: 'd'.repeat(64),
    manifestSha256: 'e'.repeat(64),
    resourceCount: expectation.resourceCount,
    roleImageIds: expectation.images,
    compatibility: expectation.compatibility,
    checkpoint: expectation.checkpoint,
  };
  const ready = { captureReceiptSha256: 'f'.repeat(64), checkpointArtifactSha256: hash(canonicalPublicationJson(artifact)), artifact };
  const status = { version: 1, ...binding, state: 'resumed-awaiting-publication', ready };
  const server = http.createServer(async (request, response) => {
    try {
      for await (const _ of request) {
        /* drain the bounded fixture request */
      }
      const body = request.url?.endsWith('/status') ? Buffer.from(JSON.stringify(status)) : payload.checkpoint;
      response.writeHead(200, {
        'Content-Type': request.url?.endsWith('/status') ? 'application/json' : 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      response.end(body);
    } catch {
      response.destroy();
    }
  });
  const socket = path.join(root, 's');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fs.chmod(socket, 0o600);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const reader = new HostCoreCaptureReader(socket);
  const download = await reader.prepare(binding, signal());
  const image = payload.saved.item;
  const platform = { os: 'linux', architecture: expectation.compatibility.architecture };
  const docker = {
    inspect: vi.fn(async (id: string, _signal: AbortSignal, selected?: RetainedImagePlatform) => {
      if (id !== image.imageId) throw new Error('Unexpected fixture image.');
      if (kind === 'oci') {
        const manifest = image.identity.manifestId;
        if (!manifest) throw new Error('The fixture has no OCI manifest.');
        return selected
          ? { Id: manifest, RepoDigests: [], Os: 'linux', Architecture: platform.architecture }
          : {
              Id: id,
              RepoDigests: [],
              Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: manifest, platform }, ImageData: { Platform: platform } }],
            };
      }
      return { Id: id, RepoDigests: [], Os: 'linux', Architecture: platform.architecture };
    }),
    save: vi.fn(async () => Readable.from([payload.saved.archive])),
    load: vi.fn(async () => {
      throw new Error('Capture must not load images.');
    }),
    preflightLoad: vi.fn(async () => {
      throw new Error('Capture must not prepare image activation.');
    }),
  };
  return {
    root,
    payload,
    store,
    point: created.point,
    reader,
    download,
    checkpointDirectory,
    imageDirectory,
    docker,
    metadata: metadata(created.point, expectation.compatibility),
    signal: signal(),
    image,
  };
}

it.each(['docker', 'oci'] as const)('joins actual Unix transfer, %s image retention and encrypted library publication', async (kind) => {
  const f = await fixture(kind);
  const result = await saveCoreCapture(f);
  const reopened = new TimeMachineStore(f.root);
  const point = await reopened.load(f.point.id);
  expect(point.status).toBe('sealed');
  expect(await reopened.metadata(point)).toEqual(result.metadata);
  expect(result.metadata.core.captureReceiptSha256).toBe('f'.repeat(64));
  expect(result.metadata.core.imageCount).toBe(1);
  expect(result.metadata.coverage.appData).toBe(false);
  expect(f.docker.save).toHaveBeenCalledTimes(1);
  expect(f.docker.load).not.toHaveBeenCalled();
  expect(f.docker.preflightLoad).not.toHaveBeenCalled();
  expect(await fs.readFile(result.staging.checkpointFile)).toEqual(f.payload.checkpoint);
  await reopened.withArchive(point, signal(), async (source, passphrase) => {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const plaintext = await backupMetadataBytes(Buffer.concat(chunks), passphrase, true, 1024 * 1024);
    expect(plaintext.subarray(0, 8).toString()).toBe('ORBISCO1');
    const manifest = JSON.parse(plaintext.subarray(12, 12 + plaintext.readUInt32BE(8)).toString());
    expect(manifest.pointId).toBe(point.id);
    expect(manifest.captureReceiptSha256).toBe('f'.repeat(64));
    expect(manifest.inventory.bindings.map((item: { imageId: string }) => item.imageId)).toEqual([f.image.imageId, f.image.imageId, f.image.imageId]);
  });
});

it('rejects mismatched image bytes without sealing or discarding the captured checkpoint', async () => {
  const f = await fixture();
  f.docker.save.mockImplementation(async () => Readable.from([Buffer.from('wrong image bytes')]));
  await expect(saveCoreCapture(f)).rejects.toThrow();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  expect(await fs.readFile(path.join(f.checkpointDirectory, 'checkpoint.tar'))).toEqual(f.payload.checkpoint);
});

it('requires the root checkpoint and reserved point to have the same identity', async () => {
  const f = await fixture();
  const other = await f.store.create(1, 3);
  await expect(saveCoreCapture({ ...f, point: other.point, metadata: metadata(other.point, f.metadata.compatibility) })).rejects.toThrow();
  expect(f.docker.save).not.toHaveBeenCalled();
  expect((await f.store.load(f.point.id)).status).toBe('capturing');
  expect((await f.store.load(other.point.id)).status).toBe('capturing');
});
