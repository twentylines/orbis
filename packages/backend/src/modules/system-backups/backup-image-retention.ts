import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { readTarArchive } from '@/core/archive/tar-metadata';

const imageId = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const failure = () => new Error('Retained container images could not be verified.');
export const retainedImageLimits = {
  images: 256,
  bindings: 4096,
  imageBytes: 16 * 1024 ** 3,
  totalBytes: 64 * 1024 ** 3,
  imageExpandedBytes: 64 * 1024 ** 3,
  totalExpandedBytes: 256 * 1024 ** 3,
  reserveBytes: 256 * 1024 ** 2,
  entries: 100_000,
  metadataBytes: 16 * 1024 * 1024,
  responseBytes: 1024 * 1024,
  operationTimeoutMs: 30 * 60 * 1000,
} as const;
export type RetainedImageLimits = { [K in keyof typeof retainedImageLimits]: number };
export type RetainedImageBinding = { key: string; imageId: string };
export type RetainedImagePlatform = { os: string; architecture: string; variant?: string };
export type RetainedImageIdentity = {
  kind: 'docker' | 'oci';
  configId: string;
  manifestId: string | null;
  archiveRootId: string;
  platform: RetainedImagePlatform | null;
  expandedBytes: number;
};
// A platform-filtered export can have a different index ID from the source container.
export type RetainedImage = {
  imageId: string;
  repoDigests: string[];
  archive: string;
  bytes: number;
  sha256: string;
  identity: RetainedImageIdentity;
};
export type RetainedImageInspection = {
  Id: string;
  RepoDigests?: string[];
  Os?: string;
  Architecture?: string;
  Variant?: string;
  Manifests?: {
    Kind: string;
    Available: boolean;
    Descriptor: { digest: string; platform?: RetainedImagePlatform };
    ImageData?: { Platform: RetainedImagePlatform };
  }[];
};
// Docker loads an untagged single-platform OCI export under its manifest ID, not index.json's hash.
export function retainedImageCreationId(identity: RetainedImageIdentity): string {
  const id = identity.kind === 'oci' ? identity.manifestId : identity.configId;
  if (typeof id !== 'string' || !imageId.test(id)) throw failure();
  return id;
}
export type RetainedImageInventory = { version: 1; images: RetainedImage[]; bindings: RetainedImageBinding[] };

// Adapters must forward cancellation to Docker's request as well as its returned streams.
export type RetainedImageDocker = {
  inspect: (id: string, signal: AbortSignal, platform?: RetainedImagePlatform) => Promise<RetainedImageInspection>;
  save: (id: string, signal: AbortSignal, platform?: RetainedImagePlatform) => Promise<Readable>;
  load: (source: Readable, signal: AbortSignal) => Promise<Readable>;
  preflightLoad: (requiredBytes: number, signal: AbortSignal) => Promise<void>;
};
type Options = {
  stagingDirectory: string;
  docker: RetainedImageDocker;
  signal: AbortSignal;
  limits?: RetainedImageLimits;
  platform?: RetainedImagePlatform;
};
const archiveName = (id: string) => `image-${id.slice(7)}.tar`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const safeKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 512 && /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value);
const safePath = (value: string) =>
  value.length <= 512 && /^[a-zA-Z0-9._/-]+$/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
const sameStat = (first: Awaited<ReturnType<FileHandle['stat']>>, second: Awaited<ReturnType<FileHandle['stat']>>) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));

function platformFor(value: unknown): RetainedImagePlatform {
  if (
    !record(value) ||
    !exactKeys(value, ['os', 'architecture', ...(value.variant === undefined ? [] : ['variant'])]) ||
    Object.values(value).some((part) => typeof part !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(part))
  )
    throw failure();
  return {
    os: value.os as string,
    architecture: value.architecture as string,
    ...(value.variant === undefined ? {} : { variant: value.variant as string }),
  };
}
function identityFor(value: unknown, sourceId: string, limits: RetainedImageLimits): RetainedImageIdentity {
  if (
    !record(value) ||
    !exactKeys(value, ['kind', 'configId', 'manifestId', 'archiveRootId', 'platform', 'expandedBytes']) ||
    !['docker', 'oci'].includes(value.kind as string) ||
    typeof value.configId !== 'string' ||
    !imageId.test(value.configId) ||
    typeof value.archiveRootId !== 'string' ||
    !imageId.test(value.archiveRootId) ||
    typeof value.expandedBytes !== 'number' ||
    !Number.isSafeInteger(value.expandedBytes) ||
    value.expandedBytes < 0 ||
    value.expandedBytes > limits.imageExpandedBytes
  )
    throw failure();
  if (value.kind === 'docker') {
    if (value.configId !== sourceId || value.archiveRootId !== sourceId || value.manifestId !== null || value.platform !== null) throw failure();
    return {
      kind: 'docker',
      configId: value.configId,
      archiveRootId: value.archiveRootId,
      manifestId: null,
      platform: null,
      expandedBytes: value.expandedBytes,
    };
  }
  if (typeof value.manifestId !== 'string' || !imageId.test(value.manifestId)) throw failure();
  return {
    kind: 'oci',
    configId: value.configId,
    manifestId: value.manifestId,
    archiveRootId: value.archiveRootId,
    platform: platformFor(value.platform),
    expandedBytes: value.expandedBytes,
  };
}
const samePlatform = (first: RetainedImagePlatform, second: RetainedImagePlatform) =>
  first.os === second.os && first.architecture === second.architecture && (first.variant ?? '') === (second.variant ?? '');
function limitsFor(value: RetainedImageLimits = retainedImageLimits): RetainedImageLimits {
  if (!exactKeys(value, Object.keys(retainedImageLimits)) || Object.values(value).some((limit) => !Number.isSafeInteger(limit) || limit <= 0))
    throw failure();
  return value;
}
function bindingsFor(value: unknown, limits: RetainedImageLimits): RetainedImageBinding[] {
  if (!Array.isArray(value) || value.length > limits.bindings) throw failure();
  const keys = new Set<string>();
  return value.map((item) => {
    if (
      !record(item) ||
      !exactKeys(item, ['key', 'imageId']) ||
      !safeKey(item.key) ||
      typeof item.imageId !== 'string' ||
      !imageId.test(item.imageId) ||
      keys.has(item.key)
    )
      throw failure();
    keys.add(item.key);
    return { key: item.key, imageId: item.imageId };
  });
}
export function validateRetainedImageInventory(value: unknown, customLimits?: RetainedImageLimits): RetainedImageInventory {
  const limits = limitsFor(customLimits);
  if (
    !record(value) ||
    !exactKeys(value, ['version', 'images', 'bindings']) ||
    value.version !== 1 ||
    !Array.isArray(value.images) ||
    value.images.length > limits.images
  )
    throw failure();
  const bindings = bindingsFor(value.bindings, limits);
  const ids = new Set<string>();
  let bytes = 0;
  let expandedBytes = 0;
  const images = value.images.map((item): RetainedImage => {
    if (
      !record(item) ||
      !exactKeys(item, ['imageId', 'repoDigests', 'archive', 'bytes', 'sha256', 'identity']) ||
      typeof item.imageId !== 'string' ||
      !imageId.test(item.imageId) ||
      ids.has(item.imageId) ||
      item.archive !== archiveName(item.imageId) ||
      !Array.isArray(item.repoDigests) ||
      item.repoDigests.length > 256 ||
      item.repoDigests.some((entry) => !digest(entry)) ||
      new Set(item.repoDigests).size !== item.repoDigests.length ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      item.bytes > limits.imageBytes ||
      typeof item.sha256 !== 'string' ||
      !hash.test(item.sha256)
    )
      throw failure();
    const identity = identityFor(item.identity, item.imageId, limits);
    expandedBytes += identity.expandedBytes;
    if (expandedBytes > limits.totalExpandedBytes) throw failure();
    ids.add(item.imageId);
    bytes += item.bytes;
    if (bytes > limits.totalBytes) throw failure();
    return {
      imageId: item.imageId,
      repoDigests: [...item.repoDigests],
      archive: item.archive as string,
      bytes: item.bytes,
      sha256: item.sha256,
      identity,
    };
  });
  if (bindings.some((binding) => !ids.has(binding.imageId)) || images.some((image) => !bindings.some((binding) => binding.imageId === image.imageId)))
    throw failure();
  return { version: 1, images, bindings };
}
async function privateDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== path.resolve(directory)
  )
    throw failure();
}
async function available(directory: string, bytes: number, limits: RetainedImageLimits) {
  const stat = await fs.statfs(directory, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(bytes) + BigInt(limits.reserveBytes) || (stat.ffree !== 0n && stat.ffree < 64n)) throw failure();
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  let aborted = false;
  let cancel: () => void = () => undefined;
  const interruption = new Promise<never>((_, reject) => {
    cancel = () => {
      aborted = true;
      reject(failure());
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  operation.then(
    (value) => {
      if (aborted) late?.(value);
    },
    () => undefined,
  );
  try {
    return await Promise.race([operation, interruption]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
async function inspect(docker: RetainedImageDocker, id: string, signal: AbortSignal) {
  const value = await abortable(docker.inspect(id, signal), signal);
  if (
    value.Id !== id ||
    !Array.isArray(value.RepoDigests ?? []) ||
    (value.RepoDigests?.length ?? 0) > 256 ||
    value.RepoDigests?.some((entry) => !digest(entry))
  )
    throw failure();
  return value;
}
async function capturePlatform(
  docker: RetainedImageDocker,
  inspected: RetainedImageInspection,
  requested: RetainedImagePlatform | undefined,
  signal: AbortSignal,
): Promise<RetainedImagePlatform | undefined> {
  if (!requested || requested.os !== 'linux' || requested.architecture !== 'arm64' || requested.variant) return requested;
  const selected = await abortable(docker.inspect(inspected.Id, signal, requested), signal);
  if (selected.Os === 'linux' && selected.Architecture === 'arm64' && selected.Variant === 'v8')
    return { os: 'linux', architecture: 'arm64', variant: 'v8' };
  return requested;
}
async function selectedManifest(
  docker: RetainedImageDocker,
  inspected: RetainedImageInspection,
  platform: RetainedImagePlatform | undefined,
  signal: AbortSignal,
) {
  if (!platform) {
    if (inspected.Manifests?.length) throw failure();
    return inspected.Id;
  }
  const selected = await abortable(docker.inspect(inspected.Id, signal, platform), signal);
  if (
    !imageId.test(selected.Id) ||
    selected.Os !== platform.os ||
    selected.Architecture !== platform.architecture ||
    (selected.Variant ?? '') !== (platform.variant ?? '')
  )
    throw failure();
  if (inspected.Manifests?.length) {
    const descriptors = inspected.Manifests.filter((entry) => {
      if (entry.Kind !== 'image' || !entry.Available) return false;
      const descriptorPlatform = entry.Descriptor.platform;
      const imagePlatform = entry.ImageData?.Platform;
      if (descriptorPlatform === undefined && imagePlatform === undefined) throw failure();
      if (
        descriptorPlatform !== undefined &&
        imagePlatform !== undefined &&
        !samePlatform(platformFor(descriptorPlatform), platformFor(imagePlatform))
      )
        throw failure();
      return samePlatform(platformFor(descriptorPlatform ?? imagePlatform), platform);
    });
    if (descriptors.length !== 1 || descriptors[0]?.Descriptor.digest !== selected.Id) throw failure();
  } else if (selected.Id !== inspected.Id) throw failure();
  return selected.Id;
}
async function openImage(file: string, limit: number) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size <= 0 ||
      stat.size > limit
    )
      throw failure();
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function checksum(handle: FileHandle, signal: AbortSignal) {
  const sum = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) sum.update(chunk);
  return sum.digest('hex');
}

type ArchiveMember = { sha256: string; bytes: number; data?: Buffer; directory?: boolean };
const blobName = (id: string) => `blobs/sha256/${id.slice(7)}`;
const ociIndexType = 'application/vnd.oci.image.index.v1+json';
const ociManifestType = 'application/vnd.oci.image.manifest.v1+json';
const attestationType = 'application/vnd.docker.attestation.manifest.v1+json';
const emptyConfigType = 'application/vnd.oci.empty.v1+json';
const attestationLayerType = 'application/vnd.in-toto+json';
const jsonMember = (entries: Map<string, ArchiveMember>, name: string): unknown => {
  const data = entries.get(name)?.data;
  if (!data) throw failure();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    throw failure();
  }
};
function descriptor(value: unknown, mediaTypes: string[]) {
  if (
    !record(value) ||
    !exactKeys(value, ['mediaType', 'digest', 'size']) ||
    typeof value.digest !== 'string' ||
    !imageId.test(value.digest) ||
    typeof value.mediaType !== 'string' ||
    !mediaTypes.includes(value.mediaType) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  )
    throw failure();
  return { digest: value.digest, size: value.size, mediaType: value.mediaType };
}

function annotations(value: unknown): Record<string, string> {
  if (
    !record(value) ||
    Object.keys(value).length > 64 ||
    Object.entries(value).some(([key, item]) => !key.length || key.length > 256 || typeof item !== 'string' || item.length > 4096) ||
    Buffer.byteLength(JSON.stringify(value)) > 16384 ||
    Object.hasOwn(value, 'org.opencontainers.image.ref.name') ||
    Object.hasOwn(value, 'io.containerd.image.name')
  )
    throw failure();
  return value as Record<string, string>;
}

function metadataDescriptor(value: unknown, mediaTypes: string[], extras: string[] = []) {
  if (!record(value) || !exactKeys(value, ['mediaType', 'digest', 'size', ...extras.filter((key) => Object.hasOwn(value, key))])) throw failure();
  if (value.annotations !== undefined) annotations(value.annotations);
  return descriptor({ mediaType: value.mediaType, digest: value.digest, size: value.size }, mediaTypes);
}

function referencedMetadata(entries: Map<string, ArchiveMember>, value: ReturnType<typeof descriptor>, limit: number) {
  const name = blobName(value.digest);
  const entry = entries.get(name);
  if (!entry?.data || entry.bytes !== value.size || entry.sha256 !== value.digest.slice(7) || entry.bytes > limit) throw failure();
  return { name, entry, value: jsonMember(entries, name) };
}

function validateAttestation(
  raw: unknown,
  primary: ReturnType<typeof descriptor>,
  entries: Map<string, ArchiveMember>,
  allowed: Set<string>,
  limits: RetainedImageLimits,
) {
  if (!record(raw)) throw failure();
  const dockerForm = raw.artifactType === undefined;
  if (!dockerForm && raw.artifactType !== attestationType) throw failure();
  const root = metadataDescriptor(raw, [ociManifestType], ['artifactType', 'annotations', 'platform']);
  if (
    raw.platform !== undefined &&
    (!record(raw.platform) ||
      !exactKeys(raw.platform, ['os', 'architecture']) ||
      raw.platform.os !== 'unknown' ||
      raw.platform.architecture !== 'unknown')
  )
    throw failure();
  const rootAnnotations = raw.annotations === undefined ? {} : annotations(raw.annotations);
  for (const key of ['io.containerd.manifest.subject', 'vnd.docker.reference.digest'])
    if (rootAnnotations[key] !== undefined && rootAnnotations[key] !== primary.digest) throw failure();
  if (dockerForm && rootAnnotations['io.containerd.manifest.subject'] !== primary.digest) throw failure();
  if (rootAnnotations['vnd.docker.reference.type'] !== undefined && rootAnnotations['vnd.docker.reference.type'] !== 'attestation-manifest')
    throw failure();
  const artifact = referencedMetadata(entries, root, limits.metadataBytes);
  const manifest = artifact.value;
  if (
    !record(manifest) ||
    !exactKeys(manifest, [
      'schemaVersion',
      'mediaType',
      ...(dockerForm ? [] : ['artifactType']),
      'config',
      'layers',
      ...(dockerForm ? [] : ['subject']),
      ...(Object.hasOwn(manifest, 'annotations') ? ['annotations'] : []),
    ]) ||
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== ociManifestType ||
    (!dockerForm && manifest.artifactType !== attestationType) ||
    !Array.isArray(manifest.layers) ||
    !manifest.layers.length ||
    manifest.layers.length > 64
  )
    throw failure();
  if (manifest.annotations !== undefined) annotations(manifest.annotations);
  let dockerDiffIds: unknown[] | undefined;
  if (dockerForm) {
    const config = metadataDescriptor(manifest.config, ['application/vnd.oci.image.config.v1+json'], ['annotations']);
    const configMember = referencedMetadata(entries, config, limits.metadataBytes);
    const data = configMember.value;
    if (
      !record(data) ||
      !exactKeys(data, ['architecture', 'os', 'config', 'rootfs']) ||
      data.architecture !== 'unknown' ||
      data.os !== 'unknown' ||
      !record(data.config) ||
      Object.keys(data.config).length !== 0 ||
      !record(data.rootfs) ||
      !exactKeys(data.rootfs, ['type', 'diff_ids']) ||
      data.rootfs.type !== 'layers' ||
      !Array.isArray(data.rootfs.diff_ids) ||
      data.rootfs.diff_ids.length !== manifest.layers.length
    )
      throw failure();
    dockerDiffIds = data.rootfs.diff_ids;
    allowed.add(configMember.name);
  } else {
    const subject = metadataDescriptor(manifest.subject, [ociManifestType], ['annotations']);
    if (subject.digest !== primary.digest || subject.size !== primary.size) throw failure();
    const config = metadataDescriptor(manifest.config, [emptyConfigType], ['data', 'annotations']);
    const empty = referencedMetadata(entries, config, limits.metadataBytes);
    const emptyBytes = empty.entry.data;
    if (config.size !== 2 || !emptyBytes || emptyBytes.toString('utf8') !== '{}') throw failure();
    if (record(manifest.config) && manifest.config.data !== undefined) {
      if (
        typeof manifest.config.data !== 'string' ||
        manifest.config.data !== 'e30=' ||
        !Buffer.from(manifest.config.data, 'base64').equals(emptyBytes)
      )
        throw failure();
    }
    allowed.add(empty.name);
  }
  allowed.add(artifact.name);
  for (const [index, rawLayer] of manifest.layers.entries()) {
    const layer = metadataDescriptor(rawLayer, [attestationLayerType], ['annotations']);
    if (dockerDiffIds && dockerDiffIds[index] !== layer.digest) throw failure();
    const payload = referencedMetadata(entries, layer, limits.metadataBytes);
    const statement = payload.value;
    if (
      !record(statement) ||
      !exactKeys(statement, ['_type', 'subject', 'predicateType', 'predicate']) ||
      !['https://in-toto.io/Statement/v1', 'https://in-toto.io/Statement/v0.1'].includes(String(statement._type)) ||
      typeof statement.predicateType !== 'string' ||
      !statement.predicateType.length ||
      statement.predicateType.length > 2048 ||
      !record(statement.predicate) ||
      !Array.isArray(statement.subject) ||
      !statement.subject.length ||
      statement.subject.length > 64
    )
      throw failure();
    const layerAnnotations = record(rawLayer) && rawLayer.annotations !== undefined ? annotations(rawLayer.annotations) : {};
    if (layerAnnotations['in-toto.io/predicate-type'] !== undefined && layerAnnotations['in-toto.io/predicate-type'] !== statement.predicateType)
      throw failure();
    for (const rawSubject of statement.subject) {
      if (
        !record(rawSubject) ||
        !exactKeys(rawSubject, ['name', 'digest']) ||
        typeof rawSubject.name !== 'string' ||
        !rawSubject.name.length ||
        rawSubject.name.length > 2048 ||
        !record(rawSubject.digest) ||
        !exactKeys(rawSubject.digest, ['sha256']) ||
        rawSubject.digest.sha256 !== primary.digest.slice(7)
      )
        throw failure();
    }
    allowed.add(payload.name);
  }
}

// Hash graph members and bounded inflated layers without extracting any image paths.
async function validateDockerArchive(
  file: string,
  expectedId: string,
  bytes: number,
  limits: RetainedImageLimits,
  signal: AbortSignal,
  platform: RetainedImagePlatform | null,
): Promise<RetainedImageIdentity> {
  const entries = new Map<string, ArchiveMember>();
  let metadataBytes = 0;
  let current: { name: string; hash: ReturnType<typeof createHash>; bytes: number; parts?: Buffer[]; candidate: boolean } | undefined;
  await readTarArchive(file, false, signal, {
    strict: true,
    maxEntries: limits.entries,
    maxExpandedBytes: bytes,
    collectEntries: false,
    onEntry: async (entry) => {
      const name = entry.type === 'd' ? entry.path.replace(/\/$/, '') : entry.path;
      if (!safePath(name) || entries.has(name) || !['-', 'd'].includes(entry.type)) throw failure();
      if (entry.type === 'd') {
        entries.set(name, { sha256: '', bytes: 0, directory: true });
        current = undefined;
        return;
      }
      const required = ['index.json', 'manifest.json', 'oci-layout', `${expectedId.slice(7)}.json`].includes(name);
      if (required && entry.size > limits.metadataBytes) throw failure();
      current = {
        name,
        hash: createHash('sha256'),
        bytes: entry.size,
        candidate: required || (name.startsWith('blobs/sha256/') && entry.size <= limits.metadataBytes),
      };
    },
    onData: async (chunk) => {
      if (!current) throw failure();
      current.hash.update(chunk);
      if (current.candidate) {
        current.candidate = false;
        if (chunk[0] === 123 || chunk[0] === 91) current.parts = [];
      }
      if (current.parts) {
        metadataBytes += chunk.length;
        if (metadataBytes > limits.metadataBytes) throw failure();
        current.parts.push(Buffer.from(chunk));
      }
    },
    onEntryEnd: async () => {
      if (current) {
        const sha256 = current.hash.digest('hex');
        if (/^blobs\/sha256\/[a-f0-9]{64}$/.test(current.name) && sha256 !== current.name.slice(13)) throw failure();
        entries.set(current.name, { sha256, bytes: current.bytes, ...(current.parts ? { data: Buffer.concat(current.parts) } : {}) });
      }
      current = undefined;
    },
  });
  const compat = jsonMember(entries, 'manifest.json');
  if (!Array.isArray(compat) || compat.length !== 1 || !record(compat[0])) throw failure();
  const item = compat[0];
  if (
    !exactKeys(item, ['Config', 'RepoTags', 'Layers']) ||
    typeof item.Config !== 'string' ||
    !safePath(item.Config) ||
    (item.RepoTags !== null && (!Array.isArray(item.RepoTags) || item.RepoTags.length !== 0)) ||
    !Array.isArray(item.Layers) ||
    item.Layers.length > limits.entries ||
    item.Layers.some((layer) => typeof layer !== 'string' || !safePath(layer))
  )
    throw failure();
  const configEntry = entries.get(item.Config);
  if (!configEntry?.data) throw failure();
  const configId = `sha256:${configEntry.sha256}`;
  if (![`${configEntry.sha256}.json`, blobName(configId)].includes(item.Config)) throw failure();
  const config = jsonMember(entries, item.Config);
  if (
    !record(config) ||
    !record(config.rootfs) ||
    config.rootfs.type !== 'layers' ||
    !Array.isArray(config.rootfs.diff_ids) ||
    config.rootfs.diff_ids.length !== item.Layers.length ||
    config.rootfs.diff_ids.some((id) => typeof id !== 'string' || !imageId.test(id))
  )
    throw failure();
  const allowed = new Set<string>(['manifest.json', item.Config, ...(item.Layers as string[])]);
  const layers = new Map<string, { gzip: boolean; diffId: string }>();
  let identity: Omit<RetainedImageIdentity, 'expandedBytes'>;
  if (entries.has('index.json') || entries.has('oci-layout')) {
    if (!platform) throw failure();
    const layout = jsonMember(entries, 'oci-layout');
    const index = jsonMember(entries, 'index.json');
    if (
      !record(layout) ||
      !exactKeys(layout, ['imageLayoutVersion']) ||
      layout.imageLayoutVersion !== '1.0.0' ||
      !record(index) ||
      !exactKeys(index, ['schemaVersion', 'mediaType', 'manifests']) ||
      index.schemaVersion !== 2 ||
      index.mediaType !== ociIndexType ||
      !Array.isArray(index.manifests) ||
      !index.manifests.length ||
      index.manifests.length > 17
    )
      throw failure();
    const roots = index.manifests.filter((value) => record(value) && value.digest === expectedId);
    const root = roots[0];
    if (
      roots.length !== 1 ||
      !record(root) ||
      !exactKeys(root, [
        'mediaType',
        'digest',
        'size',
        ...(Object.hasOwn(root, 'platform') ? ['platform'] : []),
        ...(Object.hasOwn(root, 'annotations') ? ['annotations'] : []),
      ]) ||
      (Object.hasOwn(root, 'platform') && !samePlatform(platformFor(root.platform), platform))
    )
      throw failure();
    if (root.annotations !== undefined) annotations(root.annotations);
    const manifestDescriptor = descriptor({ mediaType: root.mediaType, digest: root.digest, size: root.size }, [ociManifestType]);
    if (manifestDescriptor.digest !== expectedId || entries.get(blobName(expectedId))?.bytes !== manifestDescriptor.size) throw failure();
    const manifest = jsonMember(entries, blobName(expectedId));
    if (
      !record(manifest) ||
      !exactKeys(manifest, ['schemaVersion', 'mediaType', 'config', 'layers', ...(Object.hasOwn(manifest, 'annotations') ? ['annotations'] : [])]) ||
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== ociManifestType ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length !== item.Layers.length
    )
      throw failure();
    if (manifest.annotations !== undefined) annotations(manifest.annotations);
    const configDescriptor = descriptor(manifest.config, ['application/vnd.oci.image.config.v1+json']);
    if (
      configDescriptor.digest !== configId ||
      configDescriptor.size !== configEntry.bytes ||
      config.architecture !== platform.architecture ||
      config.os !== platform.os ||
      (config.variant ?? '') !== (platform.variant ?? '')
    )
      throw failure();
    for (const [index, raw] of manifest.layers.entries()) {
      const layer = descriptor(raw, ['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip']);
      const name = blobName(layer.digest);
      const diffId = config.rootfs.diff_ids[index] as string;
      if (item.Layers[index] !== name || entries.get(name)?.bytes !== layer.size || (layers.has(name) && layers.get(name)?.diffId !== diffId))
        throw failure();
      layers.set(name, { gzip: layer.mediaType.endsWith('+gzip'), diffId });
    }
    allowed.add('index.json');
    allowed.add('oci-layout');
    allowed.add(blobName(expectedId));
    const referenced = new Set([expectedId]);
    for (const artifact of index.manifests) {
      if (artifact === root) continue;
      if (!record(artifact) || typeof artifact.digest !== 'string' || referenced.has(artifact.digest)) throw failure();
      referenced.add(artifact.digest);
      validateAttestation(artifact, manifestDescriptor, entries, allowed, limits);
    }
    identity = { kind: 'oci', configId, manifestId: expectedId, archiveRootId: `sha256:${entries.get('index.json')?.sha256}`, platform };
  } else {
    if (configId !== expectedId) throw failure();
    for (const [index, name] of (item.Layers as string[]).entries()) {
      const diffId = config.rootfs.diff_ids[index] as string;
      if (entries.get(name)?.sha256 !== diffId.slice(7)) throw failure();
      layers.set(name, { gzip: false, diffId });
      if (/^[a-f0-9]{64}\/layer\.tar$/.test(name)) {
        allowed.add(`${path.posix.dirname(name)}/VERSION`);
        allowed.add(`${path.posix.dirname(name)}/json`);
      }
    }
    identity = { kind: 'docker', configId, manifestId: null, archiveRootId: expectedId, platform: null };
  }
  for (const [name, entry] of entries)
    if (entry.directory ? ![...allowed].some((member) => member.startsWith(`${name}/`)) : !allowed.has(name)) throw failure();
  const expanded = new Map<string, number>();
  let inflatedBytes = 0;
  let inflation:
    | { name: string; gunzip: ReturnType<typeof createGunzip>; done: Promise<void>; hash: ReturnType<typeof createHash>; bytes: number }
    | undefined;
  const abortInflation = () => inflation?.gunzip.destroy(failure());
  signal.addEventListener('abort', abortInflation, { once: true });
  try {
    await readTarArchive(file, false, signal, {
      strict: true,
      maxEntries: limits.entries,
      maxExpandedBytes: bytes,
      collectEntries: false,
      onEntry: async (entry) => {
        const layer = layers.get(entry.path);
        if (!layer) return;
        if (!layer.gzip) {
          if (`sha256:${entries.get(entry.path)?.sha256}` !== layer.diffId) throw failure();
          expanded.set(entry.path, entry.size);
          return;
        }
        const gunzip = createGunzip();
        const hash = createHash('sha256');
        const state = { name: entry.path, gunzip, hash, bytes: 0, done: Promise.resolve() };
        state.done = new Promise<void>((resolve, reject) => {
          gunzip.on('data', (chunk: Buffer) => {
            state.bytes += chunk.length;
            inflatedBytes += chunk.length;
            if (inflatedBytes > limits.imageExpandedBytes) gunzip.destroy(failure());
            else hash.update(chunk);
          });
          gunzip.once('error', reject);
          gunzip.once('end', resolve);
        });
        state.done.catch(() => undefined);
        inflation = state;
      },
      onData: async (chunk) => {
        if (inflation) {
          const state = inflation;
          await Promise.race([
            new Promise<void>((resolve, reject) => state.gunzip.write(chunk, (error) => (error ? reject(error) : resolve()))),
            state.done,
          ]);
        }
      },
      onEntryEnd: async () => {
        if (inflation) {
          const state = inflation;
          state.gunzip.end();
          await state.done;
          if (`sha256:${state.hash.digest('hex')}` !== layers.get(state.name)?.diffId) throw failure();
          expanded.set(state.name, state.bytes);
          inflation = undefined;
        }
      },
    });
  } finally {
    signal.removeEventListener('abort', abortInflation);
    inflation?.gunzip.destroy();
  }
  const expandedBytes = (item.Layers as string[]).reduce((total, name) => total + (expanded.get(name) ?? 0), 0);
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.imageExpandedBytes) throw failure();
  return { ...identity, expandedBytes };
}

export async function captureRetainedImages(options: Options & { bindings: RetainedImageBinding[] }) {
  const { docker } = options;
  const limits = limitsFor(options.limits);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.operationTimeoutMs)]);
  const bindings = bindingsFor(options.bindings, limits);
  const platform = options.platform === undefined ? undefined : platformFor(options.platform);
  const ids = [...new Set(bindings.map((binding) => binding.imageId))].sort();
  if (ids.length > limits.images) throw failure();
  signal.throwIfAborted();
  await privateDirectory(options.stagingDirectory);
  const directory = await fs.mkdtemp(path.join(options.stagingDirectory, 'retained-images-'));
  const images: RetainedImage[] = [];
  let total = 0;
  let totalExpanded = 0;
  try {
    for (const id of ids) {
      signal.throwIfAborted();
      await available(directory, 0, limits);
      const inspected = await inspect(docker, id, signal);
      const repoDigests = [...new Set(inspected.RepoDigests ?? [])].sort();
      const imagePlatform = await capturePlatform(docker, inspected, platform, signal);
      const manifestId = await selectedManifest(docker, inspected, imagePlatform, signal);
      const archive = archiveName(id);
      const file = path.join(directory, archive);
      const output = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let stream: Readable | undefined;
      let bytes = 0;
      const sum = createHash('sha256');
      try {
        stream = await abortable(docker.save(id, signal, imagePlatform), signal, (late) => late.destroy());
        await pipeline(
          stream,
          async (chunks: AsyncIterable<Buffer>) => {
            for await (const chunk of chunks) {
              signal.throwIfAborted();
              bytes += chunk.length;
              if (bytes > limits.imageBytes || bytes > limits.totalBytes - total) throw failure();
              await available(directory, chunk.length, limits);
              sum.update(chunk);
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw failure();
                offset += bytesWritten;
              }
            }
          },
          { signal },
        );
        if (!bytes) throw failure();
        await output.sync();
      } finally {
        stream?.destroy();
        await output.close();
      }
      const identity = await validateDockerArchive(file, manifestId, bytes, limits, signal, imagePlatform ?? null);
      totalExpanded += identity.expandedBytes;
      if (totalExpanded > limits.totalExpandedBytes) throw failure();
      if ((await selectedManifest(docker, await inspect(docker, id, signal), imagePlatform, signal)) !== manifestId) throw failure();
      images.push({ imageId: id, repoDigests, archive, bytes, sha256: sum.digest('hex'), identity });
      total += bytes;
    }
    signal.throwIfAborted();
    return { directory, inventory: validateRetainedImageInventory({ version: 1, images, bindings }, limits) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRetainedImageArchives(options: {
  inventory: RetainedImageInventory;
  files: ReadonlyMap<string, string>;
  signal: AbortSignal;
}) {
  const limits = limitsFor(undefined);
  const inventory = validateRetainedImageInventory(options.inventory, limits);
  for (const image of inventory.images) {
    options.signal.throwIfAborted();
    const file = options.files.get(`image-capture/images/${image.archive}`);
    if (!file) throw failure();
    const opened = await openImage(file, limits.imageBytes);
    try {
      if (opened.stat.size !== image.bytes || (await checksum(opened.handle, options.signal)) !== image.sha256) throw failure();
      const identity = await validateDockerArchive(
        file,
        image.identity.manifestId ?? image.imageId,
        image.bytes,
        limits,
        options.signal,
        image.identity.platform,
      );
      if (
        JSON.stringify(identityFor(identity, image.imageId, limits)) !== JSON.stringify(image.identity) ||
        !sameStat(opened.stat, await opened.handle.stat()) ||
        !sameStat(opened.stat, await fs.lstat(file))
      )
        throw failure();
    } finally {
      await opened.handle.close();
    }
  }
}

export async function loadRetainedImages(options: Options & { inventory: unknown }) {
  const { docker } = options;
  const limits = limitsFor(options.limits);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.operationTimeoutMs)]);
  const inventory = validateRetainedImageInventory(options.inventory, limits);
  signal.throwIfAborted();
  await privateDirectory(options.stagingDirectory);
  if (
    (await fs.readdir(options.stagingDirectory)).sort().join('\0') !==
    inventory.images
      .map((image) => image.archive)
      .sort()
      .join('\0')
  )
    throw failure();
  const verified: { image: RetainedImage; handle: FileHandle; stat: Awaited<ReturnType<FileHandle['stat']>> }[] = [];
  try {
    for (const image of inventory.images) {
      signal.throwIfAborted();
      const file = path.join(options.stagingDirectory, image.archive);
      const opened = await openImage(file, limits.imageBytes);
      verified.push({ image, ...opened });
      if (opened.stat.size !== image.bytes || (await checksum(opened.handle, signal)) !== image.sha256) throw failure();
      const identity = await validateDockerArchive(
        file,
        image.identity.manifestId ?? image.imageId,
        image.bytes,
        limits,
        signal,
        image.identity.platform,
      );
      if (JSON.stringify(identityFor(identity, image.imageId, limits)) !== JSON.stringify(image.identity)) throw failure();
      if (!sameStat(opened.stat, await opened.handle.stat()) || !sameStat(opened.stat, await fs.lstat(file))) throw failure();
    }
    await available(
      options.stagingDirectory,
      inventory.images.reduce((sum, image) => sum + image.bytes, 0),
      limits,
    );
    const requiredBytes = inventory.images.reduce((sum, image) => sum + image.bytes + image.identity.expandedBytes * 2, limits.reserveBytes);
    if (!Number.isSafeInteger(requiredBytes)) throw failure();
    await abortable(docker.preflightLoad(requiredBytes, signal), signal);
    for (const { image, handle, stat } of verified) {
      signal.throwIfAborted();
      if (!sameStat(stat, await handle.stat())) throw failure();
      const source = handle.createReadStream({ autoClose: false, start: 0, signal });
      source.on('error', () => undefined);
      let response: Readable | undefined;
      const abort = () => {
        source.destroy(failure());
        response?.destroy(failure());
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        response = await abortable(docker.load(source, signal), signal, (late) => late.destroy());
        let bytes = 0;
        let pending = '';
        for await (const chunk of response) {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > limits.responseBytes) throw failure();
          pending += Buffer.from(chunk).toString('utf8');
        }
        if (!source.readableEnded || !sameStat(stat, await handle.stat())) throw failure();
        for (const line of pending.split('\n').filter((line) => line.trim())) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw failure();
          }
          if (!record(value) || value.error || value.errorDetail) throw failure();
        }
        const restored = await inspect(docker, retainedImageCreationId(image.identity), signal);
        if (
          (await selectedManifest(docker, restored, image.identity.platform ?? undefined, signal)) !==
          (image.identity.manifestId ?? image.identity.configId)
        )
          throw failure();
      } finally {
        signal.removeEventListener('abort', abort);
        response?.destroy();
        source.destroy();
      }
    }
    signal.throwIfAborted();
    return new Map(
      inventory.bindings.map((binding) => {
        const image = inventory.images.find((candidate) => candidate.imageId === binding.imageId);
        if (!image) throw failure();
        return [binding.key, retainedImageCreationId(image.identity)];
      }),
    );
  } finally {
    await Promise.all(verified.map(({ handle }) => handle.close()));
  }
}
