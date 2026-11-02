import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { controllerConfigPaths } from '../host-updates/host-controller-config';
import type { ControllerPublicationExpectation } from '../host-updates/host-controller-publication';
import { backupMetadataBytes } from './backup-crypto';
import { admitRuntimeFile } from './time-machine-runtime-reader';
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
function manifest() {
  const pointId = '11111111-1111-4111-8111-111111111111';
  const hash = 'a'.repeat(64);
  const controller = {
    id: 'b'.repeat(64),
    imageId: `sha256:${'c'.repeat(64)}`,
    imageReference: `ghcr.io/twentylines/orbis@sha256:${'d'.repeat(64)}`,
    project: 'runtipi',
    service: 'runtipi',
    startedAt: '2026-10-31T00:00:00Z',
    releaseTag: 'v0.5.0-beta.3',
    releaseDigest: `sha256:${'d'.repeat(64)}`,
  };
  return {
    schema: 'orbis.time-machine-runtime.v2',
    pointId,
    legacy: { bytes: 52, cipherSha256: hash, manifestSha256: hash },
    imageCaptureSha256: hash,
    imageInventorySha256: hash,
    configurationSetSha256: hash,
    publicationProofSha256: hash,
    controller: {
      containerId: controller.id,
      sourceImageId: controller.imageId,
      publishedReference: controller.imageReference,
      publishedDigest: controller.releaseDigest,
    },
    configuration: {
      version: 1,
      pointId,
      configurationSetSha256: hash,
      controller,
      rootIdentity: { device: '1', inode: '1', uid: 0, gid: 0, mode: 0o700, pathSha256: hash },
      files: controllerConfigPaths.map((path) => ({ path, present: false })),
    },
    entries: [
      { name: 'controller-publication/proof.json', bytes: 1, sha256: hash },
      { name: 'image-capture/capture.json', bytes: 1, sha256: hash },
    ],
    controllerRuntimeCoherence: false,
    restoreReady: false,
  };
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup(change?: (bytes: Buffer) => Buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-reader-'));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const value = manifest();
  const metadata = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(12);
  header.write('ORBISTM1');
  header.writeUInt32BE(metadata.length, 8);
  const bytes = Buffer.concat([header, metadata, Buffer.from('xy')]);
  const source = path.join(root, 'runtime.orbis');
  await fs.writeFile(source, await backupMetadataBytes(change ? change(bytes) : bytes, 'test-passphrase-long', false), { mode: 0o600 });
  const staging = path.join(root, 'staging');
  await fs.mkdir(staging, { mode: 0o700 });
  return {
    source,
    stagingParent: staging,
    passphrase: 'test-passphrase-long',
    signal: new AbortController().signal,
    maximumBytes: 1024 * 1024,
    expected: { manifestSha256: sha(metadata), manifest: value, publication: {} as ControllerPublicationExpectation },
  };
}
it.each(['magic', 'truncated', 'trailing', 'metadata', 'entry'] as const)(
  'rejects authenticated %s corruption and removes all staging',
  async (kind) => {
    const options = await setup((bytes) => {
      if (kind === 'truncated') return bytes.subarray(0, bytes.length - 1);
      if (kind === 'trailing') return Buffer.concat([bytes, Buffer.from('extra')]);
      const result = Buffer.from(bytes);
      const index = kind === 'magic' ? 0 : kind === 'metadata' ? 15 : result.length - 1;
      result[index] = required(result[index]) ^ 1;
      return result;
    });
    await expect(admitRuntimeFile(options)).rejects.toThrow();
    expect(await fs.readdir(options.stagingParent)).toEqual([]);
  },
);
it.each(['wrong-key', 'cancelled', 'source-symlink', 'parent-symlink', 'limit'] as const)('rejects %s before exposing files', async (kind) => {
  const options = await setup();
  if (kind === 'wrong-key') options.passphrase = 'wrong-passphrase-long';
  if (kind === 'cancelled') options.signal = AbortSignal.abort();
  if (kind === 'limit') options.maximumBytes = 13;
  if (kind === 'source-symlink') {
    const link = `${options.source}.link`;
    await fs.symlink(options.source, link);
    options.source = link;
  }
  if (kind === 'parent-symlink') {
    const link = `${options.stagingParent}.link`;
    await fs.symlink(options.stagingParent, link);
    options.stagingParent = link;
  }
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});
it.each(['order', 'path', 'duplicate', 'v1'] as const)('rejects externally supplied invalid %s expectations', async (kind) => {
  const options = await setup();
  const value = options.expected.manifest;
  if (kind === 'order') value.entries.reverse();
  if (kind === 'path') required(value.entries[0]).name = '../escape';
  if (kind === 'duplicate') value.entries.push({ ...required(value.entries[0]) });
  if (kind === 'v1') {
    value.schema = 'orbis.time-machine-runtime.v1';
    value.entries.shift();
    delete (value as Partial<typeof value>).publicationProofSha256;
  }
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});

it('rejects a modified GCM tag and cleans plaintext staging', async () => {
  const options = await setup();
  const bytes = await fs.readFile(options.source);
  bytes[bytes.length - 1] = required(bytes[bytes.length - 1]) ^ 1;
  await fs.writeFile(options.source, bytes);
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});
it('enforces a deadline during authentication and removes temporary files', async () => {
  const options = await setup();
  await expect(admitRuntimeFile({ ...options, timeoutMs: 1 })).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});
it('bounds header metadata before allocation', async () => {
  const options = await setup((bytes) => {
    const copy = Buffer.from(bytes);
    copy.writeUInt32BE(0xffffffff, 8);
    return copy;
  });
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});
it('admits a real encrypted ordered v2 payload with independently supplied configuration and publication authority', async () => {
  const { connectedCaptureFixture } = await import('./time-machine-capture.fixture');
  const { runtimePayload, canonicalRuntimeJson } = await import('./time-machine-runtime-payload');
  const { encryptBackupStream } = await import('./backup-crypto');
  const { Readable } = await import('node:stream');
  const { validateRetainedImageInventory } = await import('./backup-image-retention');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-positive-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, '.env'), 'DISPOSABLE_FIXTURE=true');
  const fixture = await connectedCaptureFixture(data, {});
  const pointId = '11111111-1111-4111-8111-111111111111';
  const configuration = await fixture.host.captureControllerConfiguration({ pointId, controllerId: fixture.ids.core, imageId: fixture.image.id });
  const publicationExpectation: ControllerPublicationExpectation = {
    configuration: configuration.metadata,
    publication: {
      ...fixture.image.publication,
      schema: 'orbis.release.v1',
      image: 'ghcr.io/twentylines/orbis',
      runtipiCompatibility: '4.10.1',
      installationProtocol: 'orbis.installation-state.v1',
    },
    platform: { os: 'linux', architecture: 'arm64' },
  };
  const publication = await fixture.host.prepareControllerPublication(publicationExpectation);
  const archive = fixture.image.archive;
  const inventory = validateRetainedImageInventory({
    version: 1,
    bindings: [
      { key: 'controller/runtipi/runtipi', imageId: fixture.image.id },
      { key: 'controller/runtipi/runtipi-db', imageId: fixture.image.id },
    ],
    images: [
      {
        imageId: fixture.image.id,
        repoDigests: [],
        archive: `image-${fixture.image.id.slice(7)}.tar`,
        bytes: archive.length,
        sha256: sha(archive),
        identity: {
          kind: 'docker',
          configId: fixture.image.id,
          archiveRootId: fixture.image.id,
          manifestId: null,
          platform: null,
          expandedBytes: 2048,
        },
      },
    ],
  });
  const legacy = { bytes: 52, cipherSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
  const capture = {
    schema: 'orbis.time-machine-image-capture.v1' as const,
    pointId,
    createdAt: 1793404800000,
    backupManifestSha256: legacy.manifestSha256,
    platform: publicationExpectation.platform,
    apps: [],
    containers: [
      { ...required(fixture.values.get(fixture.ids.core)), role: 'controller', appUrn: null, key: 'controller/runtipi/runtipi', wasRunning: true },
      {
        ...required(fixture.values.get(fixture.ids.database)),
        role: 'database',
        appUrn: null,
        key: 'controller/runtipi/runtipi-db',
        wasRunning: true,
      },
    ],
    inventory,
    inventorySha256: sha(Buffer.from(canonicalRuntimeJson(inventory))),
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
  const files = [
    { name: 'capture.json', bytes: captureBytes.length, sha256: sha(captureBytes), open: async () => Readable.from([captureBytes]) },
    {
      name: `images/${required(inventory.images[0]).archive}`,
      bytes: archive.length,
      sha256: sha(archive),
      open: async () => Readable.from([archive]),
    },
  ];
  const signal = new AbortController().signal;
  const payload = runtimePayload(
    {
      images: { capture, files, sha256: sha(captureBytes), dispose: async () => undefined } as never,
      configuration,
      publication,
      publicationExpectation,
    },
    legacy,
    signal,
  );
  const source = path.join(root, 'runtime.orbis');
  await encryptBackupStream({
    source: payload.stream,
    plaintextBytes: payload.bytes,
    destination: source,
    passphrase: 'test-passphrase-long',
    signal,
  });
  const stagingParent = path.join(root, 'staging');
  await fs.mkdir(stagingParent, { mode: 0o700 });
  const admissionOptions = {
    source,
    stagingParent,
    passphrase: 'test-passphrase-long',
    signal,
    maximumBytes: 1024 * 1024,
    expected: { manifest: payload.manifest, manifestSha256: payload.manifestSha256, publication: publicationExpectation },
  };
  const space = await fs.statfs(stagingParent, { bigint: true });
  const capacity = vi.spyOn(fs, 'statfs').mockResolvedValue({ ...space, bavail: 0n });
  try {
    await expect(admitRuntimeFile(admissionOptions)).rejects.toThrow();
    expect(capacity).toHaveBeenCalledOnce();
    expect(await fs.readdir(stagingParent)).toEqual([]);
  } finally {
    capacity.mockRestore();
  }
  await fs.chmod(source, 0o644);
  await expect(admitRuntimeFile(admissionOptions)).rejects.toThrow();
  await fs.chmod(source, 0o600);
  await fs.link(source, `${source}.link`);
  await expect(admitRuntimeFile(admissionOptions)).rejects.toThrow();
  await fs.rm(`${source}.link`);
  await fs.rename(source, `${source}.saved`);
  execFileSync('mkfifo', [source]);
  await expect(admitRuntimeFile({ ...admissionOptions, timeoutMs: 100 })).rejects.toThrow();
  await fs.rm(source);
  await fs.rename(`${source}.saved`, source);
  const admitted = await admitRuntimeFile(admissionOptions);
  expect([...admitted.files.keys()]).toEqual(payload.manifest.entries.map((entry) => entry.name));
  expect(admitted.restoreReady).toBe(false);
  const { verifyRetainedImageArchives } = await import('./backup-image-retention');
  const wrongInventory = structuredClone(inventory);
  required(wrongInventory.images[0]).identity.expandedBytes++;
  await expect(verifyRetainedImageArchives({ inventory: wrongInventory, files: admitted.files, signal })).rejects.toThrow();
  for (const entry of payload.manifest.entries) {
    const filename = required(admitted.files.get(entry.name));
    expect(sha(await fs.readFile(filename))).toBe(entry.sha256);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  }
  await admitted.dispose();
  expect(await fs.readdir(stagingParent)).toEqual([]);
});

it('rejects public input permissions and multiply linked input without leaving staging', async () => {
  const options = await setup();
  await fs.chmod(options.source, 0o644);
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  await fs.chmod(options.source, 0o600);
  await fs.link(options.source, `${options.source}.link`);
  await expect(admitRuntimeFile(options)).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});

it('rejects FIFO input without waiting for a writer and cleans staging', async () => {
  const options = await setup();
  await fs.rm(options.source);
  execFileSync('mkfifo', [options.source]);
  await expect(admitRuntimeFile({ ...options, timeoutMs: 100 })).rejects.toThrow();
  expect(await fs.readdir(options.stagingParent)).toEqual([]);
});
