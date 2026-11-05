import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type { ControllerPublicationExpectation } from '../host-updates/host-controller-publication';
import { connectedCaptureFixture } from '../system-backups/time-machine-capture.fixture';
import { fullBackupFixture } from '../system-backups/backup-import.fixture';
import { encryptBackup } from '../system-backups/backup-crypto';
import { validateRetainedImageInventory } from '../system-backups/backup-image-retention';
import { canonicalRuntimeJson, type CapturedRuntimeInput } from '../system-backups/time-machine-runtime-payload';
import { TimeMachineStore, type TimeMachineDraftMetadata } from '../system-backups/time-machine-store';
import { timeMachineIssue } from '../system-backups/time-machine-policy';
import { stabilizeExistingDarwinFixtures } from '../system-backups/darwin-files.fixture';
import { exportCapsule, importCapsule, type CapsuleSource } from './capsule';
import { verifyCapsuleContents, type VerifiedCapsuleContents } from './verify';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
};
const password = 'portable-fixture-password';
const target = { orbisVersion: 'v1.0.0', runtipiVersion: '4.10.1', architecture: 'arm64' };

export async function portablePointFixture(root: string) {
  const backup = await fullBackupFixture(root);
  const sourceRoot = path.join(root, 'source-library');
  const destinationRoot = path.join(root, 'destination-library');
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  await fs.mkdir(destinationRoot, { mode: 0o700 });
  const source = new TimeMachineStore(sourceRoot);
  const destination = new TimeMachineStore(destinationRoot);
  const draft = await source.create(3, 2);
  const connected = await connectedCaptureFixture(backup.source, {});
  const configuration = await connected.host.captureControllerConfiguration({
    pointId: draft.point.id,
    controllerId: connected.ids.core,
    imageId: connected.image.id,
  });
  const publicationExpectation: ControllerPublicationExpectation = {
    configuration: configuration.metadata,
    publication: {
      ...connected.image.publication,
      schema: 'orbis.release.v1',
      image: 'ghcr.io/twentylines/orbis',
      runtipiCompatibility: '4.10.1',
      installationProtocol: 'orbis.installation-state.v1',
    },
    platform: { os: 'linux' as const, architecture: 'arm64' },
  };
  const publication = await connected.host.prepareControllerPublication(publicationExpectation);
  const image = connected.image.archive;
  const inventory = validateRetainedImageInventory({
    version: 1,
    bindings: [
      { key: 'controller/runtipi/runtipi', imageId: connected.image.id },
      { key: 'controller/runtipi/runtipi-db', imageId: connected.image.id },
    ],
    images: [
      {
        imageId: connected.image.id,
        repoDigests: [],
        archive: `image-${connected.image.id.slice(7)}.tar`,
        bytes: image.length,
        sha256: sha(image),
        identity: {
          kind: 'docker',
          configId: connected.image.id,
          archiveRootId: connected.image.id,
          manifestId: null,
          platform: null,
          expandedBytes: 2048,
        },
      },
    ],
  });
  const manifestSha256 = sha(await fs.readFile(path.join(backup.content, 'manifest.json')));
  const capture = {
    schema: 'orbis.time-machine-image-capture.v1' as const,
    pointId: draft.point.id,
    createdAt: backup.manifest.createdAt,
    backupManifestSha256: manifestSha256,
    platform: publicationExpectation.platform,
    apps: [],
    containers: [
      {
        ...required(connected.values.get(connected.ids.core)),
        role: 'controller' as const,
        appUrn: null,
        key: 'controller/runtipi/runtipi',
        wasRunning: true,
      },
      {
        ...required(connected.values.get(connected.ids.database)),
        role: 'database' as const,
        appUrn: null,
        key: 'controller/runtipi/runtipi-db',
        wasRunning: true,
      },
    ],
    inventory,
    inventorySha256: sha(canonicalRuntimeJson(inventory)),
    coverage: {
      appData: 'legacy-quiesced-container-copy',
      database: 'legacy-logical-dump',
      controller: 'not-quiesced',
      controllerConfiguration: 'not-captured',
      encryptedEnvelope: 'not-integrated',
      restoreReady: false,
    } as const,
  };
  const captureBytes = Buffer.from(canonicalRuntimeJson(capture));
  const input: CapturedRuntimeInput = {
    images: {
      directory: root,
      capture,
      sha256: sha(captureBytes),
      dispose: async () => undefined,
      files: [
        { name: 'capture.json', bytes: captureBytes.length, sha256: sha(captureBytes), open: async () => Readable.from([captureBytes]) },
        {
          name: `images/${required(inventory.images[0]).archive}`,
          bytes: image.length,
          sha256: sha(image),
          open: async () => Readable.from([image]),
        },
      ],
    },
    configuration,
    publication,
    publicationExpectation,
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPUiHJjYGBgYmBgYGBgYGBgAAAJbADMvnADbQAAAABJRU5ErkJggg==',
    'base64',
  );
  // Use the validated image asset path so enrollment also exercises encrypted preview assets.
  const { capturedWallpaper } = await import('../system-backups/time-machine-assets');
  const wallpaperAsset = await source.retainWallpaper(draft.point, capturedWallpaper(png, 'captured-custom', sha(png)), signal());
  const metadata: TimeMachineDraftMetadata = {
    version: 2,
    id: draft.point.id,
    createdAt: draft.point.createdAt,
    label: 'Portable older runtime',
    source: 'manual',
    manifestSha256,
    software: { orbis: 'v1.0.0', runtipi: '4.10.1', architecture: 'arm64' },
    coverage: {
      database: true,
      configuration: true,
      appData: true,
      dockerImages: true,
      controllerConfiguration: true,
      controllerVersion: false,
      appearance: true,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [timeMachineIssue('activation-not-integrated')] },
    preview: {
      available: true,
      kind: 'historical-home-projection',
      version: 1,
      capturedAt: backup.manifest.createdAt,
      desktop: {
        serverName: 'Saved desktop',
        preset: 'forest',
        mode: 'dark',
        density: 'comfortable',
        wallpaper: 'canopy',
        wallpaperMode: 'custom',
        wallpaperPreset: null,
        appearance: {},
        workspace: { order: ['applications'], hidden: [], wide: [], showAllApps: false, pinnedApps: [] },
      },
      theme: null,
      customWallpaperAvailable: true,
      wallpaperAsset,
      screenshot: { available: false, reason: timeMachineIssue('screenshot-not-captured') },
      resolvedSystemMode: null,
      apps: [],
    },
    breakdown: [],
    excludedApps: [],
  };
  await fs.rm(backup.encrypted);
  await encryptBackup({ source: backup.archive, destination: backup.encrypted, passphrase: draft.passphrase, signal: signal() });
  stabilizeExistingDarwinFixtures(root);
  const inputFile = await fs.open(backup.encrypted, 'r');
  await source.seal(draft.point, inputFile.createReadStream({ autoClose: true }), (await fs.stat(backup.encrypted)).size, metadata, signal(), {
    input,
  });
  const point = await source.load(draft.point.id);
  const directory = path.join(sourceRoot, 'backups/time-machine/points', point.id);
  const entries: CapsuleSource[] = [];
  for (const name of ['backup.orbis', 'runtime.orbis', 'metadata.orbis', 'wallpaper.orbis'] as const) {
    const file = path.join(directory, name);
    const bytes = await fs.readFile(file);
    entries.push({ name, file, bytes: bytes.length, sha256: sha(bytes) });
  }
  stabilizeExistingDarwinFixtures(root);
  const capsule = path.join(root, 'saved.orbis-tm');
  await exportCapsule({
    destination: capsule,
    pointId: point.id,
    createdAt: point.createdAt,
    pointKey: draft.passphrase,
    entries,
    passphrase: password,
    signal: signal(),
  });
  let token: VerifiedCapsuleContents | undefined;
  const opened = await importCapsule({
    source: capsule,
    stagingParent: root,
    passphrase: password,
    signal: signal(),
    verify: async (manifest, directory, signal) => {
      token = await verifyCapsuleContents({ manifest, directory, signal, database: { review: vi.fn().mockResolvedValue(undefined) }, target });
    },
  });
  return {
    source,
    destination,
    sourceRoot,
    destinationRoot,
    point,
    opened,
    token: required(token),
    key: draft.passphrase,
    png,
    capsule,
    passphrase: password,
    target,
  };
}
