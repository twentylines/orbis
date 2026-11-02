import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { decryptBackup, encryptBackup } from './backup-crypto';
import {
  captureRetainedImages,
  loadRetainedImages,
  retainedImageLimits,
  retainedImageCreationId,
  validateRetainedImageInventory,
  type RetainedImageDocker,
  type RetainedImageInspection,
} from './backup-image-retention';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const signal = () => new AbortController().signal;
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Expected fixture entry');
  return value;
}
const limits = { ...retainedImageLimits, imageBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024, reserveBytes: 1 };
async function root() {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'orbis-images-'));
  roots.push(directory);
  return directory;
}
type Entry = { name: string; data?: Buffer; type?: string; link?: string };
function tar(entries: Entry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    for (const [offset, size, text] of [
      [100, 8, '0000600\0'],
      [108, 8, '0000000\0'],
      [116, 8, '0000000\0'],
      [124, 12, `${data.length.toString(8).padStart(11, '0')}\0`],
      [136, 12, '00000000000\0'],
    ] as const)
      header.write(text, offset, size, 'ascii');
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1, 'ascii');
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write(
      `${header
        .reduce((total, byte) => total + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
      'ascii',
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture(
  options: { repoTags?: string[]; configId?: string; layer?: Buffer; manifest?: unknown; extra?: readonly Entry[]; blobs?: boolean } = {},
) {
  const layer = tar([{ name: 'file.txt', data: Buffer.from('frozen application layer') }]);
  const config = Buffer.from(
    JSON.stringify({ architecture: 'arm64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [`sha256:${sha(layer)}`] } }),
  );
  const id = `sha256:${sha(config)}`;
  const configName = options.blobs ? `blobs/sha256/${id.slice(7)}` : `${id.slice(7)}.json`;
  const layerName = options.blobs ? `blobs/sha256/${sha(layer)}` : `${'b'.repeat(64)}/layer.tar`;
  const manifest = options.manifest ?? [{ Config: options.configId ?? configName, RepoTags: options.repoTags ?? null, Layers: [layerName] }];
  return {
    id,
    archive: tar([
      { name: configName, data: config },
      { name: layerName, data: options.layer ?? layer },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      ...(options.extra ?? []),
    ]),
  };
}
function docker(archive: Buffer, id: string) {
  const inspect = vi.fn(async (requested: string) => ({ Id: requested, RepoDigests: [`registry.example/app@${id}`] }));
  const save = vi.fn(async () =>
    Readable.from(Array.from({ length: Math.ceil(archive.length / 37) }, (_, index) => archive.subarray(index * 37, (index + 1) * 37))),
  );
  const load = vi.fn(async (source: Readable) => {
    const pieces: Buffer[] = [];
    for await (const chunk of source) pieces.push(Buffer.from(chunk));
    expect(Buffer.concat(pieces)).toEqual(archive);
    return Readable.from([Buffer.from(`${JSON.stringify({ stream: `Loaded image ID: ${id}\n` })}\n`)]);
  });
  const preflightLoad = vi.fn(async () => undefined);
  return { inspect, save, load, preflightLoad } satisfies RetainedImageDocker;
}
async function capture(value = fixture()) {
  const engine = docker(value.archive, value.id);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    bindings: [{ key: 'apps/demo:main', imageId: value.id }],
  });
  return { ...saved, engine, ...value };
}
async function load(saved: Awaited<ReturnType<typeof capture>>, inventory: unknown = saved.inventory, abortSignal = signal()) {
  return loadRetainedImages({ stagingDirectory: saved.directory, docker: saved.engine, signal: abortSignal, limits, inventory });
}

it('deduplicates exact IDs, measures private streamed archives and returns immutable creation mappings without pull', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  const bindings = ['controller', 'database', 'apps/demo:main'].map((key) => ({ key, imageId: value.id }));
  const saved = await captureRetainedImages({ stagingDirectory: await root(), docker: engine, signal: signal(), limits, bindings });
  expect(engine.save).toHaveBeenCalledExactlyOnceWith(value.id, expect.any(AbortSignal), undefined);
  expect(saved.inventory.images).toEqual([
    {
      imageId: value.id,
      repoDigests: [`registry.example/app@${value.id}`],
      archive: `image-${value.id.slice(7)}.tar`,
      bytes: value.archive.length,
      sha256: sha(value.archive),
      identity: { kind: 'docker', configId: value.id, manifestId: null, archiveRootId: value.id, platform: null, expandedBytes: 2048 },
    },
  ]);
  expect((await fs.stat(saved.directory)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(saved.directory, first(saved.inventory.images).archive))).mode & 0o777).toBe(0o600);
  const mapped = await loadRetainedImages({
    stagingDirectory: saved.directory,
    docker: engine,
    signal: signal(),
    limits,
    inventory: saved.inventory,
  });
  expect([...mapped]).toEqual(bindings.map((binding) => [binding.key, binding.imageId]));
  expect(engine.load).toHaveBeenCalledTimes(1);
  expect(engine.inspect.mock.calls.map(([requested]) => requested)).toEqual([value.id, value.id, value.id]);
});
it('accepts compatibility manifests pointing at uncompressed content-addressed blobs', async () => {
  const saved = await capture(fixture({ blobs: true }));
  await load(saved);
  expect(saved.engine.load).toHaveBeenCalledTimes(1);
});
it.each(['registry.example/app:latest', 'sha256:abcd'])('refuses noncanonical image ID %s before Docker access', async (id) => {
  const engine = docker(Buffer.alloc(0), '');
  await expect(
    captureRetainedImages({ stagingDirectory: await root(), docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: id }] }),
  ).rejects.toThrow();
  expect(engine.inspect).not.toHaveBeenCalled();
});
it.each([
  ['tag overwrite', () => fixture({ repoTags: ['registry.example/app:latest'] })],
  ['config mismatch', () => fixture({ configId: `${'c'.repeat(64)}.json` })],
  ['layer mismatch', () => fixture({ layer: Buffer.from('corrupt') })],
  ['traversal', () => fixture({ extra: [{ name: '../escape' }] })],
  ['symlink', () => fixture({ extra: [{ name: 'escape', type: '2', link: '/etc/passwd' }] })],
  ['duplicate entry', () => fixture({ extra: [{ name: 'manifest.json', data: Buffer.from('[]') }] })],
  ['multiple images', () => fixture({ manifest: [{}, {}] })],
  [
    'competing OCI index',
    () =>
      fixture({
        extra: [
          { name: 'index.json', data: Buffer.from('{}') },
          { name: 'oci-layout', data: Buffer.from('{}') },
        ],
      }),
  ],
  ['OCI-only unsupported format', () => ({ id: `sha256:${'a'.repeat(64)}`, archive: tar([{ name: 'oci-layout', data: Buffer.from('{}') }]) })],
] as const)('rejects %s exports and cleans partial plaintext', async (_, make) => {
  const value = make();
  const engine = docker(value.archive, value.id);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({ stagingDirectory, docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: value.id }] }),
  ).rejects.toThrow();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
  expect(engine.load).not.toHaveBeenCalled();
});
it.each(['overflow', 'stream-failure', 'capacity'] as const)('cleans %s failure with no retained truncation', async (mode) => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  if (mode === 'stream-failure')
    engine.save.mockImplementation(async () =>
      Readable.from(
        (async function* () {
          yield Buffer.alloc(100);
          throw new Error('failed');
        })(),
      ),
    );
  const stagingDirectory = await root();
  const bounded =
    mode === 'overflow' ? { ...limits, imageBytes: 100 } : mode === 'capacity' ? { ...limits, reserveBytes: Number.MAX_SAFE_INTEGER } : limits;
  await expect(
    captureRetainedImages({ stagingDirectory, docker: engine, signal: signal(), limits: bounded, bindings: [{ key: 'app', imageId: value.id }] }),
  ).rejects.toThrow();
  if (mode === 'capacity') expect(engine.save).not.toHaveBeenCalled();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});
it('preserves the disk reserve if free space falls while an archive streams', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  const stagingDirectory = await root();
  const capacity = vi
    .spyOn(fs, 'statfs')
    .mockResolvedValueOnce({ bavail: 10000n, bsize: 1n, ffree: 100n } as never)
    .mockResolvedValueOnce({ bavail: 1n, bsize: 1n, ffree: 100n } as never);
  try {
    await expect(
      captureRetainedImages({ stagingDirectory, docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: value.id }] }),
    ).rejects.toThrow();
    expect(engine.save).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(stagingDirectory)).toEqual([]);
  } finally {
    capacity.mockRestore();
  }
});
it('removes partial archives when the filesystem reports ENOSPC during a write', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  const stagingDirectory = await root();
  const originalOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    handle.write = vi.fn().mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' })) as typeof handle.write;
    return handle;
  });
  try {
    await expect(
      captureRetainedImages({ stagingDirectory, docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: value.id }] }),
    ).rejects.toThrow();
    expect(engine.save).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(stagingDirectory)).toEqual([]);
  } finally {
    open.mockRestore();
  }
});
it('requires exact inspection both before capture and after loading', async () => {
  const saved = await capture();
  saved.engine.inspect.mockResolvedValue({ Id: `sha256:${'f'.repeat(64)}`, RepoDigests: [] });
  await expect(load(saved)).rejects.toThrow();
  expect(saved.engine.load).toHaveBeenCalledTimes(1);
  saved.engine.save.mockClear();
  await expect(
    captureRetainedImages({ stagingDirectory: await root(), docker: saved.engine, signal: signal(), limits, bindings: saved.inventory.bindings }),
  ).rejects.toThrow();
  expect(saved.engine.save).not.toHaveBeenCalled();
});
it.each(['traversal', 'digest', 'bytes', 'unbound', 'extra'] as const)('rejects %s inventory mutation before load', async (mode) => {
  const saved = await capture();
  const inventory = structuredClone(saved.inventory);
  const image = first(inventory.images);
  if (mode === 'traversal') image.archive = '../image.tar';
  if (mode === 'digest') image.sha256 = 'a'.repeat(64);
  if (mode === 'bytes') image.bytes++;
  if (mode === 'unbound') inventory.bindings = [];
  if (mode === 'extra') Object.assign(image, { source: '/private/file' });
  await expect(load(saved, inventory)).rejects.toThrow();
  expect(saved.engine.load).not.toHaveBeenCalled();
});
it('validates every archive before loading the first image', async () => {
  const saved = await capture();
  const secondId = `sha256:${'d'.repeat(64)}`;
  const second = { ...first(saved.inventory.images), imageId: secondId, archive: `image-${secondId.slice(7)}.tar` };
  await fs.writeFile(path.join(saved.directory, second.archive), Buffer.alloc(second.bytes), { mode: 0o600 });
  await expect(
    load(saved, {
      version: 1,
      images: [...saved.inventory.images, second],
      bindings: [...saved.inventory.bindings, { key: 'second', imageId: secondId }],
    }),
  ).rejects.toThrow();
  expect(saved.engine.load).not.toHaveBeenCalled();
});
it.each(['symlink', 'hardlink', 'public-mode', 'unexpected-file', 'changed-bytes'] as const)('rejects %s staging before load', async (mode) => {
  const saved = await capture();
  const file = path.join(saved.directory, first(saved.inventory.images).archive);
  if (mode === 'symlink') {
    await fs.rm(file);
    await fs.symlink('/etc/passwd', file);
  }
  if (mode === 'hardlink') await fs.link(file, path.join(await root(), 'alias'));
  if (mode === 'public-mode') await fs.chmod(file, 0o644);
  if (mode === 'unexpected-file') await fs.writeFile(path.join(saved.directory, 'extra'), 'unexpected');
  if (mode === 'changed-bytes') {
    const handle = await fs.open(file, 'r+');
    await handle.write(Buffer.from('x'), 0, 1, 0);
    await handle.close();
  }
  await expect(load(saved)).rejects.toThrow();
  expect(saved.engine.load).not.toHaveBeenCalled();
});
it('rejects public and symlinked staging roots', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  const stagingDirectory = await root();
  await fs.chmod(stagingDirectory, 0o755);
  await expect(
    captureRetainedImages({ stagingDirectory, docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: value.id }] }),
  ).rejects.toThrow();
  const alias = path.join(await root(), 'alias');
  await fs.symlink(await root(), alias);
  await expect(
    captureRetainedImages({ stagingDirectory: alias, docker: engine, signal: signal(), limits, bindings: [{ key: 'app', imageId: value.id }] }),
  ).rejects.toThrow();
  expect(engine.save).not.toHaveBeenCalled();
});
it('cancels pending save acquisition and destroys a late stream', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  let deliver: ((stream: Readable) => void) | undefined;
  engine.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  const controller = new AbortController();
  const stagingDirectory = await root();
  const work = captureRetainedImages({
    stagingDirectory,
    docker: engine,
    signal: controller.signal,
    limits,
    bindings: [{ key: 'app', imageId: value.id }],
  });
  await vi.waitFor(() => expect(deliver).toBeDefined());
  controller.abort();
  await expect(work).rejects.toThrow();
  const late = Readable.from([value.archive]);
  if (!deliver) throw new Error('Save stream was not requested');
  deliver(late);
  await vi.waitFor(() => expect(late.destroyed).toBe(true));
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});
it('cancels stalled save streams and load responses', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  const stalled = new Readable({ read() {} });
  engine.save.mockResolvedValue(stalled);
  const controller = new AbortController();
  const stagingDirectory = await root();
  const work = captureRetainedImages({
    stagingDirectory,
    docker: engine,
    signal: controller.signal,
    limits,
    bindings: [{ key: 'app', imageId: value.id }],
  });
  await vi.waitFor(() => expect(engine.save).toHaveBeenCalled());
  controller.abort();
  await expect(work).rejects.toThrow();
  expect(stalled.destroyed).toBe(true);
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
  const saved = await capture();
  const response = new Readable({ read() {} });
  saved.engine.load.mockImplementation(async (source) => {
    for await (const _ of source) {
    }
    return response;
  });
  const cancelled = new AbortController();
  const loading = load(saved, saved.inventory, cancelled.signal);
  await vi.waitFor(() => expect(saved.engine.load).toHaveBeenCalled());
  cancelled.abort();
  await expect(loading).rejects.toThrow();
  expect(response.destroyed).toBe(true);
});
it.each(['error', 'malformed', 'overlong', 'source-not-consumed'] as const)(
  'rejects Docker load %s response without creation mappings',
  async (mode) => {
    const saved = await capture();
    saved.engine.load.mockImplementation(async (source) => {
      if (mode !== 'source-not-consumed')
        for await (const _ of source) {
        }
      return Readable.from([
        mode === 'error'
          ? '{"error":"load failed"}\n'
          : mode === 'malformed'
            ? 'not-json'
            : mode === 'overlong'
              ? 'x'.repeat(limits.responseBytes + 1)
              : '{}\n',
      ]);
    });
    saved.engine.inspect.mockClear();
    await expect(load(saved)).rejects.toThrow();
    expect(saved.engine.inspect).not.toHaveBeenCalled();
  },
);
it('round trips retained bytes through existing authenticated encryption in private staging', async () => {
  const saved = await capture();
  const image = first(saved.inventory.images);
  const encrypted = path.join(await root(), 'layers.orbis');
  const passphrase = 'disposable-image-fixture-passphrase';
  await encryptBackup({ source: path.join(saved.directory, image.archive), destination: encrypted, passphrase });
  expect((await fs.readFile(encrypted)).includes(Buffer.from('frozen application layer'))).toBe(false);
  const opened = path.join(await root(), image.archive);
  await decryptBackup({ source: encrypted, destination: opened, passphrase });
  expect(sha(await fs.readFile(opened))).toBe(image.sha256);
  await expect(
    decryptBackup({ source: encrypted, destination: path.join(await root(), image.archive), passphrase: 'incorrect-image-passphrase' }),
  ).rejects.toThrow();
});
it('bounds inventory bindings, counts and bytes and refuses unknown policy fields', () => {
  expect(validateRetainedImageInventory({ version: 1, images: [], bindings: [] })).toEqual({ version: 1, images: [], bindings: [] });
  expect(() => validateRetainedImageInventory({ version: 1, images: [], bindings: [] }, { ...limits, images: Number.NaN })).toThrow();
  const value = fixture();
  const item = { imageId: value.id, repoDigests: [], archive: `image-${value.id.slice(7)}.tar`, bytes: 100, sha256: sha(value.archive) };
  expect(() =>
    validateRetainedImageInventory(
      {
        version: 1,
        images: [item],
        bindings: [
          { key: 'one', imageId: value.id },
          { key: 'two', imageId: value.id },
        ],
      },
      { ...limits, bindings: 1 },
    ),
  ).toThrow();
  expect(() =>
    validateRetainedImageInventory({ version: 1, images: [item], bindings: [{ key: 'one', imageId: value.id }] }, { ...limits, totalBytes: 99 }),
  ).toThrow();
});

it('requires successful daemon storage preflight before any load request', async () => {
  const saved = await capture();
  saved.engine.preflightLoad.mockRejectedValue(new Error('insufficient daemon storage'));
  await expect(load(saved)).rejects.toThrow();
  expect(saved.engine.preflightLoad).toHaveBeenCalledExactlyOnceWith(
    saved.archive.length + first(saved.inventory.images).identity.expandedBytes * 2 + limits.reserveBytes,
    expect.any(AbortSignal),
  );
  expect(saved.engine.load).not.toHaveBeenCalled();
});
it('applies an operation deadline even without caller cancellation', async () => {
  const value = fixture();
  const engine = docker(value.archive, value.id);
  engine.inspect.mockImplementation(() => new Promise(() => undefined));
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits: { ...limits, operationTimeoutMs: 25 },
      bindings: [{ key: 'app', imageId: value.id }],
    }),
  ).rejects.toThrow();
  expect(engine.save).not.toHaveBeenCalled();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});

const platform = { os: 'linux', architecture: 'arm64' };
function ociFixture(
  options: {
    variant?: string;
    omitArchivePlatform?: boolean;
    dockerAttestation?: boolean;
    corruptCompressed?: boolean;
    wrongDiff?: boolean;
    extra?: readonly Entry[];
    duplicateLayer?: boolean;
    taggedIndex?: boolean;
    multiplePlatforms?: boolean;
    wrongPlatform?: boolean;
    badManifestId?: boolean;
    attestation?: boolean;
    primaryAnnotations?: Record<string, string>;
    artifact?: (value: Record<string, unknown>) => void;
    artifactDescriptor?: (value: Record<string, unknown>) => void;
    statement?: (value: Record<string, unknown>) => void;
    corruptAttestation?: boolean;
    duplicateAttestation?: boolean;
    tooManyAttestations?: boolean;
  } = {},
) {
  const imagePlatform = options.variant ? { ...platform, variant: options.variant } : platform;
  const layer = tar([{ name: 'app', data: Buffer.from('retained OCI application') }]);
  const zipped = gzipSync(layer);
  const blob = options.corruptCompressed ? Buffer.from('invalid gzip data') : zipped;
  const layerId = `sha256:${sha(blob)}`;
  const count = options.duplicateLayer ? 2 : 1;
  const config = Buffer.from(
    JSON.stringify({
      architecture: options.wrongPlatform ? 'amd64' : 'arm64',
      os: 'linux',
      ...(options.variant ? { variant: options.variant } : {}),
      rootfs: { type: 'layers', diff_ids: Array(count).fill(`sha256:${options.wrongDiff ? '0'.repeat(64) : sha(layer)}`) },
    }),
  );
  const configId = `sha256:${sha(config)}`;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configId, size: config.length },
      layers: Array(count).fill({ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerId, size: blob.length }),
    }),
  );
  const manifestId = `sha256:${sha(manifest)}`;
  const descriptor = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: options.badManifestId ? `sha256:${'a'.repeat(64)}` : manifestId,
    size: manifest.length,
    ...(options.omitArchivePlatform ? {} : { platform: imagePlatform }),
    ...(options.primaryAnnotations ? { annotations: options.primaryAnnotations } : {}),
  };
  const artifacts: Entry[] = [];
  const artifactRoots: Record<string, unknown>[] = [];
  if (options.attestation || options.dockerAttestation) {
    let empty = Buffer.from('{}');
    const statement: Record<string, unknown> = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'pkg:docker/fixture?platform=linux%2Farm64', digest: { sha256: manifestId.slice(7) } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: { fixture: true },
    };
    options.statement?.(statement);
    const payload = Buffer.from(JSON.stringify(statement));
    const artifact: Record<string, unknown> = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: `sha256:${sha(empty)}`, size: empty.length, data: 'e30=' },
      layers: [
        {
          mediaType: 'application/vnd.in-toto+json',
          digest: `sha256:${sha(payload)}`,
          size: payload.length,
          annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1' },
        },
      ],
      subject: { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestId, size: manifest.length },
    };
    if (options.dockerAttestation) {
      empty = Buffer.from(
        JSON.stringify({ architecture: 'unknown', os: 'unknown', config: {}, rootfs: { type: 'layers', diff_ids: [`sha256:${sha(payload)}`] } }),
      );
      delete artifact.artifactType;
      delete artifact.subject;
      artifact.config = { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${sha(empty)}`, size: empty.length };
    }
    options.artifact?.(artifact);
    const artifactBytes = Buffer.from(JSON.stringify(artifact));
    const root: Record<string, unknown> = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${sha(artifactBytes)}`,
      size: artifactBytes.length,
      ...(options.dockerAttestation ? {} : { artifactType: 'application/vnd.docker.attestation.manifest.v1+json' }),
      annotations: { 'io.containerd.manifest.subject': manifestId },
    };
    options.artifactDescriptor?.(root);
    artifactRoots.push(root);
    if (options.duplicateAttestation) artifactRoots.push({ ...root });
    if (options.tooManyAttestations) artifactRoots.push(...Array.from({ length: 16 }, () => ({ ...root })));
    artifacts.push(
      { name: `blobs/sha256/${sha(empty)}`, data: empty },
      { name: `blobs/sha256/${sha(payload)}`, data: options.corruptAttestation ? Buffer.from('changed') : payload },
      { name: `blobs/sha256/${sha(artifactBytes)}`, data: artifactBytes },
    );
  }
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [...(options.multiplePlatforms ? [descriptor, descriptor] : [descriptor]), ...artifactRoots],
      ...(options.taggedIndex ? { annotations: { 'org.opencontainers.image.ref.name': 'app:latest' } } : {}),
    }),
  );
  const archiveRootId = `sha256:${sha(index)}`;
  const sourceId = `sha256:${'e'.repeat(64)}`;
  const name = (id: string) => `blobs/sha256/${id.slice(7)}`;
  const archive = tar([
    { name: name(layerId), data: blob },
    { name: name(configId), data: config },
    { name: name(manifestId), data: manifest },
    ...artifacts,
    { name: 'index.json', data: index },
    { name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    {
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify([{ Config: name(configId), RepoTags: null, Layers: Array(count).fill(name(layerId)) }])),
    },
    ...(options.extra ?? []),
  ]);
  return { archive, sourceId, manifestId, configId, archiveRootId, expandedBytes: layer.length * count, imagePlatform };
}
function ociDocker(value: ReturnType<typeof ociFixture>) {
  const inspect = vi.fn(async (id: string, _signal: AbortSignal, selection?: typeof platform): Promise<RetainedImageInspection> => {
    if (id === value.archiveRootId) throw new Error('Docker HTTP 404: archive index is not an addressable loaded image');
    return selection || id === value.manifestId
      ? {
          Id: value.manifestId,
          Os: value.imagePlatform.os,
          Architecture: value.imagePlatform.architecture,
          ...('variant' in value.imagePlatform ? { Variant: value.imagePlatform.variant } : {}),
        }
      : {
          Id: id,
          RepoDigests: [],
          Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: value.manifestId, platform: value.imagePlatform } }],
        };
  });
  const save = vi.fn(async () => Readable.from([value.archive]));
  const load = vi.fn(async (source: Readable) => {
    for await (const _ of source) {
    }
    return Readable.from(['{"stream":"loaded"}\n']);
  });
  const preflightLoad = vi.fn(async () => undefined);
  return { inspect, save, load, preflightLoad } satisfies RetainedImageDocker;
}
it.each([
  ['per-entry', 5000],
  ['aggregate', 3000],
])('enforces the %s metadata bound for Docker-style attestations', async (_name, padding) => {
  const value = ociFixture({
    dockerAttestation: true,
    statement: (statement) => {
      statement.predicate = { padding: 'x'.repeat(padding) };
    },
  });
  const options = {
    stagingDirectory: await root(),
    docker: ociDocker(value),
    signal: signal(),
    platform,
    bindings: [{ key: 'controller/db', imageId: value.sourceId }],
  };
  await expect(captureRetainedImages({ ...options, limits: { ...limits, metadataBytes: 4096 } })).rejects.toThrow();
  await expect(captureRetainedImages({ ...options, limits: { ...limits, metadataBytes: 16384 } })).resolves.toBeDefined();
});
it('verifies Docker-style attestation subjects and config layer hashes', async () => {
  const value = ociFixture({ dockerAttestation: true });
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: ociDocker(value),
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller/db', imageId: value.sourceId }],
  });
  expect(first(saved.inventory.images).identity.manifestId).toBe(value.manifestId);
});
it.each(['truncated', 'payload', 'config'] as const)('rejects Docker-style attestation %s damage', async (damage) => {
  const value = ociFixture({
    dockerAttestation: true,
    corruptAttestation: damage === 'payload',
    artifact:
      damage === 'config'
        ? (artifact) => {
            artifact.config = { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'b'.repeat(64)}`, size: 10 };
          }
        : undefined,
  });
  if (damage === 'truncated') value.archive = value.archive.subarray(0, Math.floor(value.archive.length / 2));
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: ociDocker(value),
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller/db', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
});
it('rejects Docker-style attestation with a mismatched root subject', async () => {
  const value = ociFixture({
    dockerAttestation: true,
    artifactDescriptor: (root) => {
      root.annotations = { 'io.containerd.manifest.subject': `sha256:${'a'.repeat(64)}` };
    },
  });
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: ociDocker(value),
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller/db', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
});
it('rejects Docker-style attestation with a mismatched statement subject', async () => {
  const value = ociFixture({
    dockerAttestation: true,
    statement: (statement) => {
      statement.subject = [{ name: 'wrong', digest: { sha256: 'a'.repeat(64) } }];
    },
  });
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: ociDocker(value),
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller/db', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
});
it('accepts a Docker 29 single-manifest export without descriptor platform while verifying the config platform', async () => {
  const value = ociFixture({ omitArchivePlatform: true });
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller', imageId: value.sourceId }],
  });
  expect(first(saved.inventory.images).identity.platform).toEqual(platform);
});
it('captures an explicit arm64 v8 image on an arm64 host while retaining its exact platform', async () => {
  const value = ociFixture({ variant: 'v8' });
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller/db', imageId: value.sourceId }],
  });
  expect(first(saved.inventory.images).identity.platform).toEqual({ ...platform, variant: 'v8' });
  expect(engine.save).toHaveBeenCalledExactlyOnceWith(value.sourceId, expect.any(AbortSignal), { ...platform, variant: 'v8' });
});
it.each(['v9', 'v8.1'])('rejects unsupported arm64 variant %s', async (variant) => {
  const value = ociFixture({ variant });
  const engine = ociDocker(value);
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: engine,
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller/db', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(engine.save).not.toHaveBeenCalled();
});
it('keeps Docker29 source index, platform manifest, config and exported index identities separate', async () => {
  const value = ociFixture({ duplicateLayer: true });
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller', imageId: value.sourceId }],
  });
  expect(first(saved.inventory.images).identity).toEqual({
    kind: 'oci',
    configId: value.configId,
    manifestId: value.manifestId,
    archiveRootId: value.archiveRootId,
    platform,
    expandedBytes: value.expandedBytes,
  });
  expect(engine.save).toHaveBeenCalledExactlyOnceWith(value.sourceId, expect.any(AbortSignal), platform);
  expect(new Set([value.sourceId, value.manifestId, value.configId, value.archiveRootId]).size).toBe(4);
  const map = await loadRetainedImages({ stagingDirectory: saved.directory, docker: engine, signal: signal(), limits, inventory: saved.inventory });
  expect(map.get('controller')).toBe(value.manifestId);
  expect(retainedImageCreationId(first(saved.inventory.images).identity)).toBe(value.manifestId);
  expect(engine.inspect).toHaveBeenCalledWith(value.manifestId, expect.any(AbortSignal));
  expect(engine.inspect).not.toHaveBeenCalledWith(value.archiveRootId, expect.any(AbortSignal));
  expect(engine.inspect).toHaveBeenCalledWith(value.manifestId, expect.any(AbortSignal), platform);
});

it('loads Docker29 single-manifest inspection with platform reported in ImageData rather than the descriptor', async () => {
  const value = ociFixture();
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller', imageId: value.sourceId }],
  });
  engine.inspect.mockImplementation(async (id, _signal, selection) => ({
    Id: id,
    Os: platform.os,
    Architecture: platform.architecture,
    RepoDigests: [],
    ...(selection
      ? {}
      : { Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: value.manifestId }, ImageData: { Platform: platform } }] }),
  }));
  const mappings = await loadRetainedImages({
    stagingDirectory: saved.directory,
    docker: engine,
    signal: signal(),
    limits,
    inventory: saved.inventory,
  });
  expect(mappings.get('controller')).toBe(value.manifestId);
});

it.each(['missing platform', 'wrong platform', 'conflicting platform', 'wrong digest', 'duplicate descriptor'])(
  'rejects loaded Docker29 image metadata with %s',
  async (scenario) => {
    const value = ociFixture();
    const engine = ociDocker(value);
    const saved = await captureRetainedImages({
      stagingDirectory: await root(),
      docker: engine,
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller', imageId: value.sourceId }],
    });
    const entry: NonNullable<RetainedImageInspection['Manifests']>[number] = {
      Kind: 'image',
      Available: true,
      Descriptor: { digest: scenario === 'wrong digest' ? `sha256:${'f'.repeat(64)}` : value.manifestId },
      ...(scenario === 'missing platform'
        ? {}
        : { ImageData: { Platform: scenario === 'wrong platform' ? { os: 'linux', architecture: 'amd64' } : platform } }),
    };
    if (scenario === 'conflicting platform') entry.Descriptor.platform = { os: 'linux', architecture: 'amd64' };
    engine.inspect.mockImplementation(async (id, _signal, selection) => ({
      Id: id,
      Os: platform.os,
      Architecture: platform.architecture,
      ...(selection ? {} : { Manifests: scenario === 'duplicate descriptor' ? [entry, entry] : [entry] }),
    }));
    await expect(
      loadRetainedImages({ stagingDirectory: saved.directory, docker: engine, signal: signal(), limits, inventory: saved.inventory }),
    ).rejects.toThrow('Retained container images could not be verified.');
  },
);

it('retains Docker29 OCI artifact attestations byte-for-byte without treating them as image layers or creation identities', async () => {
  const value = ociFixture({
    attestation: true,
    duplicateLayer: true,
    primaryAnnotations: { 'containerd.io/distribution.source.ghcr.io': 'twentylines/orbis' },
  });
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'controller', imageId: value.sourceId }],
  });
  const image = first(saved.inventory.images);
  expect(image.identity).toEqual({
    kind: 'oci',
    configId: value.configId,
    manifestId: value.manifestId,
    archiveRootId: value.archiveRootId,
    platform,
    expandedBytes: value.expandedBytes,
  });
  expect(await fs.readFile(path.join(saved.directory, image.archive))).toEqual(value.archive);
  const mappings = await loadRetainedImages({
    stagingDirectory: saved.directory,
    docker: engine,
    signal: signal(),
    limits,
    inventory: saved.inventory,
  });
  expect(mappings.get('controller')).toBe(value.manifestId);
  expect(retainedImageCreationId(image.identity)).toBe(value.manifestId);
});

const invalidAttestations: [string, NonNullable<Parameters<typeof ociFixture>[0]>][] = [
  [
    'manifest subject',
    {
      artifact: (value) => {
        (value.subject as Record<string, unknown>).digest = `sha256:${'0'.repeat(64)}`;
      },
    },
  ],
  [
    'subject size',
    {
      artifact: (value) => {
        (value.subject as Record<string, unknown>).size = 1;
      },
    },
  ],
  [
    'index subject annotation',
    {
      artifactDescriptor: (value) => {
        value.annotations = { 'io.containerd.manifest.subject': `sha256:${'0'.repeat(64)}` };
      },
    },
  ],
  [
    'statement subject',
    {
      statement: (value) => {
        value.subject = [{ name: 'other', digest: { sha256: '0'.repeat(64) } }];
      },
    },
  ],
  [
    'artifact digest',
    {
      artifactDescriptor: (value) => {
        value.digest = `sha256:${'0'.repeat(64)}`;
      },
    },
  ],
  [
    'artifact size',
    {
      artifactDescriptor: (value) => {
        value.size = Number(value.size) + 1;
      },
    },
  ],
  [
    'payload size',
    {
      artifact: (value) => {
        first(value.layers as Record<string, unknown>[]).size = 1;
      },
    },
  ],
  [
    'empty config size',
    {
      artifact: (value) => {
        (value.config as Record<string, unknown>).size = 3;
      },
    },
  ],
  [
    'inline empty config data',
    {
      artifact: (value) => {
        (value.config as Record<string, unknown>).data = 'AAAA';
      },
    },
  ],
  [
    'artifact URL',
    {
      artifactDescriptor: (value) => {
        value.urls = ['https://example.test/untrusted'];
      },
    },
  ],
  [
    'layer URL',
    {
      artifact: (value) => {
        first(value.layers as Record<string, unknown>[]).urls = ['https://example.test/untrusted'];
      },
    },
  ],
  [
    'subject URL',
    {
      artifact: (value) => {
        (value.subject as Record<string, unknown>).urls = ['https://example.test/untrusted'];
      },
    },
  ],
  [
    'config URL',
    {
      artifact: (value) => {
        (value.config as Record<string, unknown>).urls = ['https://example.test/untrusted'];
      },
    },
  ],
  [
    'runnable artifact config',
    {
      artifact: (value) => {
        (value.config as Record<string, unknown>).mediaType = 'application/vnd.oci.image.config.v1+json';
      },
    },
  ],
  [
    'runnable artifact layer',
    {
      artifact: (value) => {
        first(value.layers as Record<string, unknown>[]).mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
      },
    },
  ],
  [
    'artifact execution field',
    {
      artifact: (value) => {
        value.command = ['not-executable'];
      },
    },
  ],
  [
    'runnable artifact platform',
    {
      artifactDescriptor: (value) => {
        value.platform = platform;
      },
    },
  ],
  ['duplicate artifact root', { duplicateAttestation: true }],
  ['artifact root budget', { tooManyAttestations: true }],
  ['corrupt payload bytes', { corruptAttestation: true }],
  ['unreferenced data', { extra: [{ name: `blobs/sha256/${sha('unreferenced')}`, data: Buffer.from('unreferenced') }] }],
  ['tag-producing primary annotation', { primaryAnnotations: { 'org.opencontainers.image.ref.name': 'mutable:tag' } }],
  ['oversized annotation', { primaryAnnotations: { metadata: 'x'.repeat(4097) } }],
  [
    'predicate annotation mismatch',
    {
      artifact: (value) => {
        first(value.layers as Record<string, unknown>[]).annotations = { 'in-toto.io/predicate-type': 'https://example.test/other' };
      },
    },
  ],
];
it.each(invalidAttestations)('rejects attestation %s before retaining or loading any archive', async (_name, options) => {
  const value = ociFixture({ attestation: true, ...options });
  const engine = ociDocker(value);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'controller', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
  expect(engine.load).not.toHaveBeenCalled();
});
it('charges attestation JSON against the existing aggregate metadata budget without counting it as rootfs expansion', async () => {
  const value = ociFixture({
    attestation: true,
    statement: (value) => {
      value.predicate = { padding: 'x'.repeat(4096) };
    },
  });
  const engine = ociDocker(value);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits: { ...limits, metadataBytes: 4096 },
      platform,
      bindings: [{ key: 'controller', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});
it.each([
  ['invalid gzip', { corruptCompressed: true }],
  ['mismatched inflated diffID', { wrongDiff: true }],
  ['tagged index', { taggedIndex: true }],
  ['multiple platforms', { multiplePlatforms: true }],
  ['config platform mismatch', { wrongPlatform: true }],
  ['manifest hash mismatch', { badManifestId: true }],
  ['unreferenced blob', { extra: [{ name: `blobs/sha256/${sha('other')}`, data: Buffer.from('other') }] }],
] as const)('rejects OCI %s before retaining an archive', async (_, options) => {
  const value = ociFixture(options);
  const engine = ociDocker(value);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'app', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
  expect(engine.load).not.toHaveBeenCalled();
});
it('bounds compressed-layer expansion independently from retained archive bytes', async () => {
  const value = ociFixture();
  const engine = ociDocker(value);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits: { ...limits, imageExpandedBytes: 100 },
      platform,
      bindings: [{ key: 'app', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});
it('requires explicit platform selection and matching source graph before exporting an index', async () => {
  const value = ociFixture();
  const engine = ociDocker(value);
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: engine,
      signal: signal(),
      limits,
      bindings: [{ key: 'app', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(engine.save).not.toHaveBeenCalled();
  engine.inspect.mockImplementation(async (id, _signal, selection) =>
    selection
      ? { Id: `sha256:${'0'.repeat(64)}`, Os: 'linux', Architecture: 'arm64' }
      : { Id: id, Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: value.manifestId, platform } }] },
  );
  await expect(
    captureRetainedImages({
      stagingDirectory: await root(),
      docker: engine,
      signal: signal(),
      limits,
      platform,
      bindings: [{ key: 'app', imageId: value.sourceId }],
    }),
  ).rejects.toThrow();
  expect(engine.save).not.toHaveBeenCalled();
});
it('rejects corrupted retained OCI identity before loading and wrong postload platform identity before returning mappings', async () => {
  const value = ociFixture();
  const engine = ociDocker(value);
  const saved = await captureRetainedImages({
    stagingDirectory: await root(),
    docker: engine,
    signal: signal(),
    limits,
    platform,
    bindings: [{ key: 'app', imageId: value.sourceId }],
  });
  const changed = structuredClone(saved.inventory);
  first(changed.images).identity.configId = `sha256:${'0'.repeat(64)}`;
  await expect(
    loadRetainedImages({ stagingDirectory: saved.directory, docker: engine, signal: signal(), limits, inventory: changed }),
  ).rejects.toThrow();
  expect(engine.load).not.toHaveBeenCalled();
  engine.inspect.mockImplementation(async (id, _signal, selection) =>
    selection
      ? { Id: value.configId, Os: 'linux', Architecture: 'arm64' }
      : { Id: id, Manifests: [{ Kind: 'image', Available: true, Descriptor: { digest: value.manifestId, platform } }] },
  );
  await expect(
    loadRetainedImages({ stagingDirectory: saved.directory, docker: engine, signal: signal(), limits, inventory: saved.inventory }),
  ).rejects.toThrow();
  expect(engine.load).toHaveBeenCalledTimes(1);
});
it('bounds aggregate expanded bytes across distinct source images and cleans the whole failed capture', async () => {
  const value = ociFixture();
  const engine = ociDocker(value);
  const stagingDirectory = await root();
  await expect(
    captureRetainedImages({
      stagingDirectory,
      docker: engine,
      signal: signal(),
      limits: { ...limits, totalExpandedBytes: value.expandedBytes * 2 - 1 },
      platform,
      bindings: [
        { key: 'one', imageId: value.sourceId },
        { key: 'two', imageId: `sha256:${'d'.repeat(64)}` },
      ],
    }),
  ).rejects.toThrow();
  expect(engine.save).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(stagingDirectory)).toEqual([]);
});

it.skipIf(process.platform === 'win32')(
  'rejects an image FIFO before load without a writer and closes its owned descriptor',
  async () => {
    const execute = promisify(execFile);
    if (process.env.ORBIS_RETAINED_IMAGE_FIFO_TEST_WORKER !== '1') {
      const driver = await root();
      const report = path.join(driver, 'fifo-worker.json');
      // A regressed blocking open cannot outlive the externally bounded threads-only child.
      await execute(
        process.execPath,
        [
          path.resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'vitest.backup.config.mts',
          '--pool=threads',
          '--maxWorkers=1',
          'src/modules/system-backups/backup-image-retention.files.test.ts',
          '-t',
          '^rejects an image FIFO before load without a writer and closes its owned descriptor$',
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        {
          cwd: process.cwd(),
          timeout: 8_000,
          killSignal: 'SIGKILL',
          maxBuffer: 128 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ORBIS_RETAINED_IMAGE_FIFO_TEST_WORKER: '1' },
        },
      );
      const result = JSON.parse(await fs.readFile(report, 'utf8'));
      expect(result.success).toBe(true);
      expect(result.numPassedTests).toBe(1);
      return;
    }
    const saved = await capture();
    const selected = path.join(saved.directory, first(saved.inventory.images).archive);
    const marker = path.join(path.dirname(saved.directory), 'caller-marker');
    await fs.writeFile(marker, 'preserve');
    await fs.unlink(selected);
    await execute('mkfifo', [selected], { timeout: 2_000, killSignal: 'SIGKILL' });
    expect((await fs.lstat(selected)).isFIFO()).toBe(true);
    const nativeOpen = fs.open;
    let openedFd: number | undefined;
    const observed = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args);
      if (args[0] === selected) openedFd = handle.fd;
      return handle;
    });
    try {
      const started = performance.now();
      await expect(load(saved)).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(saved.engine.preflightLoad).not.toHaveBeenCalled();
      expect(saved.engine.load).not.toHaveBeenCalled();
      if (openedFd === undefined) throw new Error('The selected FIFO was not opened');
      let closed = false;
      try {
        fstatSync(openedFd);
      } catch (error) {
        closed = (error as NodeJS.ErrnoException).code === 'EBADF';
      }
      expect(closed).toBe(true);
      expect((await fs.lstat(selected)).isFIFO()).toBe(true);
      expect(await fs.readFile(marker, 'utf8')).toBe('preserve');
    } finally {
      observed.mockRestore();
    }
  },
  12_000,
);
