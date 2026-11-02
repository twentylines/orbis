import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { controllerConfigPaths } from '../host-updates/host-controller-config';
import { canonicalRuntimeJson } from './time-machine-runtime-payload';
import { prepareRetainedImagePins, readRootBoundImageExpectations } from './time-machine-retained-images';
import { stageRetainedRuntime } from './time-machine-retained-stage';
import { loadRetainedImages } from './backup-image-retention';
import { verifyCaptureAgainstBackup } from './backup-image-capture';
vi.mock('./backup-image-retention', async (original) => {
  const actual = await original<typeof import('./backup-image-retention')>();
  return { ...actual, loadRetainedImages: vi.fn(async () => new Map([['apps/demo:store/web', `sha256:${'c'.repeat(64)}`]])) };
});
vi.mock('./backup-image-capture', () => ({ verifyCaptureAgainstBackup: vi.fn(async () => undefined) }));
const roots: string[] = [];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-image-pins-')));
  roots.push(data);
  const restoreId = randomUUID();
  const pointId = randomUUID();
  const directory = path.join(data, 'backups', 'restores', restoreId, 'retained');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `sha256:${'c'.repeat(64)}`;
  const inventory = {
    version: 1,
    images: [
      {
        imageId: id,
        repoDigests: [],
        archive: `image-${'c'.repeat(64)}.tar`,
        bytes: 2048,
        sha256: 'd'.repeat(64),
        identity: { kind: 'docker', configId: id, archiveRootId: id, manifestId: null, platform: null, expandedBytes: 2048 },
      },
    ],
    bindings: [{ key: 'apps/demo:store/web', imageId: id }],
  };
  const capture = { pointId, apps: [{ urn: 'demo:store', project: 'demo_store', sourceSha256: 'e'.repeat(64), services: ['web'] }], inventory };
  const captureBytes = Buffer.from(canonicalRuntimeJson(capture));
  const hash = 'a'.repeat(64);
  const controller = {
    id: 'b'.repeat(64),
    imageId: id,
    imageReference: `ghcr.io/twentylines/orbis@sha256:${'f'.repeat(64)}`,
    project: 'runtipi',
    service: 'runtipi',
    startedAt: 'fixture',
    releaseTag: 'v0.5.0-beta.3',
    releaseDigest: `sha256:${'f'.repeat(64)}`,
  };
  const manifest = {
    schema: 'orbis.time-machine-runtime.v3',
    pointId,
    legacy: { bytes: 52, cipherSha256: hash, manifestSha256: hash },
    imageCaptureSha256: sha(captureBytes),
    imageInventorySha256: sha(canonicalRuntimeJson(inventory)),
    configurationSetSha256: hash,
    publicationProofSha256: hash,
    coherenceSha256: hash,
    controllerAuthoritySha256: hash,
    controller: {
      containerId: controller.id,
      sourceImageId: id,
      publishedReference: controller.imageReference,
      publishedDigest: controller.releaseDigest,
    },
    configuration: {
      version: 1,
      pointId,
      configurationSetSha256: hash,
      controller,
      rootIdentity: { device: '1', inode: '1', uid: 0, gid: 0, mode: 0o700, pathSha256: hash },
      files: controllerConfigPaths.map((name) => ({ path: name, present: false })),
    },
    entries: [
      { name: 'coherence/receipt.json', bytes: 1, sha256: hash },
      { name: 'controller-authority/receipt.json', bytes: 1, sha256: hash },
      { name: 'controller-publication/proof.json', bytes: 1, sha256: hash },
      { name: 'image-capture/capture.json', bytes: captureBytes.length, sha256: sha(captureBytes) },
    ],
    controllerRuntimeCoherence: true,
    restoreReady: false,
  };
  const manifestBytes = Buffer.from(canonicalRuntimeJson(manifest));
  await fs.writeFile(path.join(directory, 'runtime-manifest.json'), manifestBytes, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'image-capture.json'), captureBytes, { mode: 0o600 });
  return { data, restoreId, directory, capture, manifest, manifestHash: sha(manifestBytes) };
}
it('generates no-pull pins from independently admitted capture and loaded immutable image IDs', async () => {
  const value = await fixture();
  const pins = await prepareRetainedImagePins({
    dataDirectory: value.data,
    restoreId: value.restoreId,
    expectedManifest: value.manifest,
    expectedManifestSha256: value.manifestHash,
    expectedCapture: value.capture,
    docker: {} as never,
    signal: new AbortController().signal,
  });
  expect(verifyCaptureAgainstBackup).toHaveBeenCalledOnce();
  expect(loadRetainedImages).toHaveBeenCalledOnce();
  expect(pins).toHaveLength(1);
  expect(pins[0]?.name).toBe(`${sha('demo:store')}.json`);
  expect(JSON.parse(Buffer.from(pins[0]?.data ?? []).toString())).toMatchObject({
    services: { web: { image: `sha256:${'c'.repeat(64)}`, pull_policy: 'never' } },
  });
});
it('rejects altered staged capture before any image load', async () => {
  const value = await fixture();
  await fs.appendFile(path.join(value.directory, 'image-capture.json'), ' ');
  await expect(
    prepareRetainedImagePins({
      dataDirectory: value.data,
      restoreId: value.restoreId,
      expectedManifest: value.manifest,
      expectedManifestSha256: value.manifestHash,
      expectedCapture: value.capture,
      docker: {} as never,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(loadRetainedImages).not.toHaveBeenCalled();
});

it('derives expectations only from the root-bound manifest digest and rejects changed capture bytes', async () => {
  const value = await fixture();
  const options = {
    dataDirectory: value.data,
    restoreId: value.restoreId,
    manifestSha256: value.manifestHash,
    pointId: value.manifest.pointId,
    signal: new AbortController().signal,
  };
  expect(await readRootBoundImageExpectations(options)).toMatchObject({ expectedManifest: value.manifest, expectedCapture: value.capture });
  await expect(readRootBoundImageExpectations({ ...options, manifestSha256: 'f'.repeat(64) })).rejects.toThrow();
  await fs.appendFile(path.join(value.directory, 'image-capture.json'), ' ');
  await expect(readRootBoundImageExpectations(options)).rejects.toThrow();
});

it('refuses runtime staging when the pinned database dump differs from the coherent capture', async () => {
  const value = await fixture();
  const source = path.join(value.data, 'claimed');
  await fs.mkdir(path.join(source, 'content'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(source, 'content', 'database.dump'), 'changed', { mode: 0o600 });
  const journalDirectory = path.join(value.data, 'journal');
  await fs.mkdir(journalDirectory, { mode: 0o700 });
  const journal = { directory: journalDirectory, refresh: async () => ({ phase: 'staging', decision: null }) };
  const admitted = {
    manifest: value.manifest,
    files: new Map(),
    coherence: { pointId: value.manifest.pointId, database: { bytes: 7, sha256: 'f'.repeat(64) } },
    controllerAuthority: { metadata: { version: 1 } },
  };
  await expect(
    stageRetainedRuntime({
      journal: journal as never,
      source: { directory: source, seal: { manifest: { sha256: value.manifest.legacy.manifestSha256 } } } as never,
      admitted: admitted as never,
      expectedManifestSha256: value.manifestHash,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  await expect(fs.lstat(path.join(journalDirectory, 'retained'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([3, 4, 6] as const)('stages v%s root-reviewed files after checking the pinned dump and capture binding', async (version) => {
  const value = await fixture();
  const source = path.join(value.data, 'claimed');
  await fs.mkdir(path.join(source, 'content'), { recursive: true, mode: 0o700 });
  const dump = Buffer.from('database fixture');
  await fs.writeFile(path.join(source, 'content', 'database.dump'), dump, { mode: 0o600 });
  const journalDirectory = path.join(value.data, 'journal');
  await fs.mkdir(journalDirectory, { mode: 0o700 });
  const content = Buffer.from('private configuration');
  const files = controllerConfigPaths.map((name) =>
    name === 'user-config/tipi-compose.yml' || name === 'orbis-host-compose.yml'
      ? { path: name, present: false as const }
      : {
          path: name,
          present: true as const,
          bytes: content.length,
          mode: 0o600,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          device: '1',
          inode: '2',
          mtimeNs: '1',
          ctimeNs: '1',
          sha256: sha(content),
        },
  );
  const descriptor = { ...value.manifest.configuration, files };
  const { configurationSetSha256: _old, ...configurationBody } = descriptor;
  const configurationSetSha256 = sha(`orbis.controller-config.v1\n${canonicalRuntimeJson(configurationBody)}`);
  const captureBytes = Buffer.from(canonicalRuntimeJson(value.capture));
  const blobs = new Map<string, Buffer>([
    ['image-capture/capture.json', captureBytes],
    ['coherence/receipt.json', Buffer.from('{}')],
    ['controller-authority/receipt.json', Buffer.from('{}')],
    ['controller-publication/proof.json', Buffer.from('{}')],
  ]);
  if (version === 4 || version === 6) blobs.set('host-identity/proxy.json', Buffer.from('{}'));
  if (version === 6) blobs.set('app-runtime/create-intents.json', Buffer.from('{"fixture":true}'));
  for (const file of files) if (file.present) blobs.set(`controller-config/${file.path}`, content);
  const controllerArchive = `image-capture/images/image-${'c'.repeat(64)}.tar`;
  blobs.set(controllerArchive, Buffer.from('image archive fixture'));
  const entries = [...blobs]
    .map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha(bytes) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifest = {
    ...value.manifest,
    ...(version === 4 ? { schema: 'orbis.time-machine-runtime.v4', proxyHostIdentitySha256: sha('{}') } : {}),
    ...(version === 6
      ? { schema: 'orbis.time-machine-runtime.v6', proxyHostIdentitySha256: sha('{}'), appRuntimeSha256: sha('{"fixture":true}') }
      : {}),
    configuration: { ...descriptor, configurationSetSha256 },
    configurationSetSha256,
    coherenceSha256: sha('{}'),
    controllerAuthoritySha256: sha('{}'),
    publicationProofSha256: sha('{}'),
    entries,
  };
  const admittedFiles = new Map<string, string>();
  let index = 0;
  for (const [name, bytes] of blobs) {
    const file = path.join(value.data, `admitted-${index++}`);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    admittedFiles.set(name, file);
  }
  const journal = { directory: journalDirectory, refresh: async () => ({ phase: 'staging', decision: null }) };
  const admitted = {
    manifest,
    files: admittedFiles,
    capture: value.capture,
    coherence: { pointId: manifest.pointId, database: { bytes: dump.length, sha256: sha(dump) } },
    controllerAuthority: {
      metadata: { version: version === 6 ? 4 : version === 4 ? 2 : 1, ...(version === 6 ? { appRuntimeSha256: sha('{"fixture":true}') } : {}) },
    },
    ...(version === 6 ? { appRuntime: { read: () => Buffer.from('{"fixture":true}') } } : {}),
  };
  await stageRetainedRuntime({
    journal: journal as never,
    source: { directory: source, seal: { manifest: { sha256: manifest.legacy.manifestSha256 } } } as never,
    admitted: admitted as never,
    expectedManifestSha256: sha(canonicalRuntimeJson(manifest)),
    signal: new AbortController().signal,
  });
  expect(await fs.readFile(path.join(journalDirectory, 'retained', 'controller-image.tar'))).toEqual(blobs.get(controllerArchive));
  expect(await fs.readFile(path.join(journalDirectory, 'retained', 'images', path.basename(controllerArchive)))).toEqual(
    blobs.get(controllerArchive),
  );
  expect(verifyCaptureAgainstBackup).toHaveBeenCalledOnce();
  if (version === 4 || version === 6)
    expect(await fs.readFile(path.join(journalDirectory, 'retained', 'proxy-host-identity.json'), 'utf8')).toBe('{}');
  if (version === 6) {
    expect(await fs.readFile(path.join(journalDirectory, 'retained', 'app-runtime.json'), 'utf8')).toBe('{"fixture":true}');
    const appFile = admittedFiles.get('app-runtime/create-intents.json');
    if (!appFile) throw new Error('Missing staged app runtime');
    await fs.writeFile(appFile, '{"fixture":null}', { mode: 0o600 });
    const retryDirectory = path.join(value.data, 'tampered-journal');
    await fs.mkdir(retryDirectory, { mode: 0o700 });
    await expect(
      stageRetainedRuntime({
        journal: { ...journal, directory: retryDirectory } as never,
        source: { directory: source, seal: { manifest: { sha256: manifest.legacy.manifestSha256 } } } as never,
        admitted: admitted as never,
        expectedManifestSha256: sha(canonicalRuntimeJson(manifest)),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(retryDirectory, 'retained'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
