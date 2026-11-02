import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  verifyCaptureAgainstBackup,
  type ImageCaptureContainer,
  type ImageCaptureDocker,
  type VerifiedImageCaptureFile,
} from './backup-image-capture';
import { parseFullBackupManifest } from './backup-import';
import { fullBackupLimits } from './backup-limits';
import {
  captureRetainedImages,
  retainedImageLimits,
  type RetainedImageDocker,
  type RetainedImageInventory,
  type RetainedImagePlatform,
} from './backup-image-retention';
import { appRuntimeImageBindings, type decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import { runtimeV6ImageBytesLimit } from './time-machine-runtime-payload';

const fail = () => new Error('Protected app image capture could not be verified.');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const sameFile = (a: Stats, b: Stats) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameRoot = (a: Stats, b: Stats) =>
  a.isDirectory() && !a.isSymbolicLink() && a.ino === b.ino && a.dev === b.dev && a.uid === b.uid && (a.mode & 0o777) === 0o700;
function checked(value: ImageCaptureContainer) {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/.test(value.project) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value.service) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,2047}$/.test(value.reference) ||
    typeof value.running !== 'boolean' ||
    value.oneOff !== false ||
    value.paused !== false ||
    value.restarting !== false
  )
    throw fail();
  return {
    id: value.id,
    imageId: value.imageId,
    reference: value.reference,
    project: value.project,
    service: value.service,
    oneOff: false as const,
    running: value.running,
    paused: false as const,
    restarting: false as const,
  };
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? fail());
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
async function privateDirectory(directory: string) {
  const value = await fs.lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (process.geteuid && value.uid !== process.geteuid()) ||
    value.mode & 0o077 ||
    (await fs.realpath(directory)) !== directory
  )
    throw fail();
  return value;
}
export type ProtectedImageContainerV2 = ImageCaptureContainer & {
  role: 'controller' | 'database' | 'app' | 'controller-service';
  appUrn: string | null;
  key: string;
  ordinal: number | null;
  wasRunning: boolean;
};
export type ProtectedImageCaptureV2 = Readonly<{
  version: 2;
  pointId: string;
  inventory: Readonly<RetainedImageInventory>;
  inventorySha256: string;
  containers: readonly Readonly<ProtectedImageContainerV2>[];
  files: readonly VerifiedImageCaptureFile[];
  dispose: () => Promise<void>;
  toJSON: () => never;
}>;
type ProtectedImagePreparationContext = {
  runtime: ReturnType<typeof decodeAppRuntimeCapture>;
  collect: (quiesced: boolean) => Promise<ProtectedImageContainerV2[]>;
  preflight: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  platform: RetainedImagePlatform;
  disposed: () => boolean;
};
const contexts = new WeakMap<ProtectedImageCaptureV2, ProtectedImagePreparationContext>();
export type ProtectedImageCaptureV2Options = {
  stagingDirectory: string;
  appRuntime: ReturnType<typeof decodeAppRuntimeCapture>;
  controller: { containerId: string; project: string; service: string };
  databaseId: string;
  platform: RetainedImagePlatform;
  docker: ImageCaptureDocker;
  signal: AbortSignal;
  preflight: (signal: AbortSignal) => Promise<void>;
  limits?: Parameters<typeof captureRetainedImages>[0]['limits'];
};
export async function prepareProtectedImageCaptureV2(options: ProtectedImageCaptureV2Options): Promise<ProtectedImageCaptureV2> {
  const bindings = appRuntimeImageBindings(options.appRuntime);
  const descriptor = options.appRuntime.metadata;
  const controller = Object.freeze({ ...options.controller });
  const databaseId = options.databaseId;
  const platform = Object.freeze({ ...options.platform });
  const engine = Object.freeze({
    containers: options.docker.containers.bind(options.docker),
    container: options.docker.container.bind(options.docker),
    inspectImage: options.docker.inspectImage.bind(options.docker),
    saveImage: options.docker.saveImage.bind(options.docker),
  });
  const stagingDirectory = options.stagingDirectory;
  const configuredLimits = options.limits ?? retainedImageLimits;
  const limits = Object.freeze({ ...configuredLimits, totalBytes: Math.min(configuredLimits.totalBytes, runtimeV6ImageBytesLimit) });
  const preflight = options.preflight;
  if (
    !/^[a-f0-9]{64}$/.test(controller.containerId) ||
    !/^[a-f0-9]{64}$/.test(databaseId) ||
    controller.containerId === databaseId ||
    descriptor.apps.some((app) => app.project === controller.project)
  )
    throw fail();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits?.operationTimeoutMs ?? retainedImageLimits.operationTimeoutMs)]);
  signal.throwIfAborted();
  await privateDirectory(stagingDirectory);
  const collect = async (quiesced = false): Promise<ProtectedImageContainerV2[]> => {
    const projects = [...new Set([controller.project, ...descriptor.apps.map((app) => app.project)])].sort();
    const containers: ReturnType<typeof checked>[] = [];
    for (const project of projects) {
      signal.throwIfAborted();
      const ids = await abortable(engine.containers(project, signal), signal);
      if (!Array.isArray(ids) || ids.length > 1024 || new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw fail();
      for (const id of ids) {
        const actual = checked(await abortable(engine.container(id, signal), signal));
        if (actual.id !== id || actual.project !== project) throw fail();
        containers.push(actual);
        if (containers.length > 1024) throw fail();
      }
    }
    const self = containers.find((item) => item.id === controller.containerId);
    const database = containers.find((item) => item.id === databaseId);
    if (
      !self ||
      !self.running ||
      self.project !== controller.project ||
      self.service !== controller.service ||
      !database ||
      !database.running ||
      !/(?:^|\/)postgres(?:[:@]|$)/.test(database.reference)
    )
      throw fail();
    const appProjects = new Set(descriptor.apps.map((app) => app.project));
    const actualApps = containers.filter((item) => appProjects.has(item.project));
    if (actualApps.length !== bindings.length || new Set(containers.map((item) => item.id)).size !== containers.length) throw fail();
    for (const binding of bindings) {
      const actual = actualApps.find((item) => item.id === binding.containerId);
      const historical = descriptor.containers.find((item) => item.inspect.Id === binding.containerId);
      const reference =
        historical?.inspect.Config && typeof historical.inspect.Config === 'object' ? Reflect.get(historical.inspect.Config, 'Image') : undefined;
      if (
        !actual ||
        !historical ||
        typeof reference !== 'string' ||
        actual.reference !== reference ||
        actual.project !== binding.project ||
        actual.service !== binding.service ||
        actual.imageId !== binding.imageId ||
        actual.running !== (quiesced ? false : binding.wasRunning)
      )
        throw fail();
    }
    return containers
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((item) => {
        const binding = bindings.find((entry) => entry.containerId === item.id);
        return {
          ...item,
          role: item.id === self.id ? 'controller' : item.id === database.id ? 'database' : binding ? 'app' : 'controller-service',
          appUrn: binding ? (descriptor.containers.find((entry) => entry.inspect.Id === item.id)?.appUrn ?? null) : null,
          key: binding?.key ?? `controller/${item.project}/${item.service}`,
          ordinal: binding?.ordinal ?? null,
          wasRunning: binding?.wasRunning ?? item.running,
        };
      });
  };
  await abortable(preflight(signal), signal);
  const containers = await collect();
  const docker: RetainedImageDocker = {
    inspect: engine.inspectImage,
    save: engine.saveImage,
    load: async () => {
      throw fail();
    },
    preflightLoad: async () => {
      throw fail();
    },
  };
  const saved = await captureRetainedImages({
    stagingDirectory: stagingDirectory,
    docker,
    platform: platform,
    signal,
    limits: limits,
    bindings: containers.map(({ key, imageId }) => ({ key, imageId })),
  });
  const root = await privateDirectory(saved.directory);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    if (!sameRoot(await fs.lstat(saved.directory), root)) throw fail();
    await fs.rm(saved.directory, { recursive: true, force: true });
    disposed = true;
  };
  try {
    await abortable(preflight(signal), signal);
    if (canonical(await collect()) !== canonical(containers)) throw fail();
    for (const item of descriptor.containers) {
      const image = saved.inventory.images.find((entry) => entry.imageId === item.image.sourceImageId);
      if (
        !image ||
        (item.image.selection === 'docker29-platform-manifest.v1'
          ? image.identity.kind !== 'oci' ||
            image.identity.manifestId !== item.image.creationReference ||
            canonical(image.identity.platform) !== canonical(item.image.platform)
          : image.identity.kind !== 'docker' || image.identity.configId !== item.image.creationReference)
      )
        throw fail();
      const source = await abortable(engine.inspectImage(item.image.sourceImageId, signal), signal);
      if (source.Id !== item.image.sourceImageId) throw fail();
      const inspected = await abortable(engine.inspectImage(item.image.sourceImageId, signal, item.image.platform), signal);
      if (
        inspected.Id !== item.image.creationReference ||
        inspected.Os !== item.image.platform.os ||
        inspected.Architecture !== item.image.platform.architecture ||
        (inspected.Variant || undefined) !== item.image.platform.variant
      )
        throw fail();
    }
    const files: VerifiedImageCaptureFile[] = [];
    for (const image of saved.inventory.images) {
      const target = path.join(saved.directory, image.archive);
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let seal: Stats;
      try {
        seal = await handle.stat();
        if (
          !seal.isFile() ||
          seal.nlink !== 1 ||
          seal.mode & 0o077 ||
          seal.size !== image.bytes ||
          (process.geteuid && seal.uid !== process.geteuid()) ||
          !sameFile(seal, await fs.lstat(target))
        )
          throw fail();
      } finally {
        await handle.close();
      }
      files.push(
        Object.freeze({
          name: `images/${image.archive}`,
          bytes: image.bytes,
          sha256: image.sha256,
          open: async (callerSignal: AbortSignal) => {
            const readerSignal = AbortSignal.any([signal, callerSignal]);
            readerSignal.throwIfAborted();
            const stream = Readable.from(
              (async function* () {
                const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                let size = 0;
                const digest = createHash('sha256');
                try {
                  if (
                    !sameRoot(await fs.lstat(saved.directory), root) ||
                    !sameFile(await file.stat(), seal) ||
                    !sameFile(await fs.lstat(target), seal)
                  )
                    throw fail();
                  for await (const chunk of file.createReadStream({ autoClose: false, signal: readerSignal })) {
                    size += chunk.length;
                    if (size > image.bytes) throw fail();
                    digest.update(chunk);
                    yield chunk;
                  }
                  if (
                    size !== image.bytes ||
                    digest.digest('hex') !== image.sha256 ||
                    !sameFile(await file.stat(), seal) ||
                    !sameFile(await fs.lstat(target), seal) ||
                    !sameRoot(await fs.lstat(saved.directory), root)
                  )
                    throw fail();
                } finally {
                  await file.close();
                }
              })(),
              { signal: readerSignal },
            );
            stream.on('error', () => undefined);
            return stream;
          },
        }),
      );
    }
    const inventory = frozen(structuredClone(saved.inventory));
    const prepared = {
      version: 2 as const,
      pointId: descriptor.pointId,
      inventory,
      inventorySha256: hash(canonical(inventory)),
      containers: frozen(structuredClone(containers)),
      files: Object.freeze(files),
      dispose,
      toJSON(): never {
        throw fail();
      },
    };
    Object.freeze(prepared);
    contexts.set(prepared, { runtime: options.appRuntime, collect, preflight, signal, platform, disposed: () => disposed });
    return prepared;
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Completes a private v2 image record only after the stopped snapshot matches the protected baseline. */
export async function finalizeProtectedImageCaptureV2(options: {
  prepared: ProtectedImageCaptureV2;
  snapshotContent: string;
  manifestSha256: string;
  signal: AbortSignal;
}) {
  const state = contexts.get(options.prepared);
  if (!state || state.disposed() || !/^[a-f0-9]{64}$/.test(options.manifestSha256)) throw fail();
  const signal = AbortSignal.any([state.signal, options.signal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  await privateDirectory(options.snapshotContent);
  const filename = path.join(options.snapshotContent, 'manifest.json');
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifestBytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      (process.geteuid && before.uid !== process.geteuid()) ||
      before.size < 1 ||
      before.size > fullBackupLimits.manifestBytes ||
      !sameFile(before, await fs.lstat(filename))
    )
      throw fail();
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < before.size) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) throw fail();
      chunks.push(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!sameFile(before, await file.stat()) || !sameFile(before, await fs.lstat(filename))) throw fail();
    manifestBytes = Buffer.concat(chunks);
  } finally {
    await file.close();
  }
  if (hash(manifestBytes) !== options.manifestSha256) throw fail();
  const manifest = parseFullBackupManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
  if (manifest.architecture !== state.platform.architecture) throw fail();
  const baseline = (items: readonly Readonly<ProtectedImageContainerV2>[]) =>
    items.map((item) => ({ ...item, running: item.role === 'app' ? false : item.running }));
  await abortable(state.preflight(signal), signal);
  const stopped = await abortable(state.collect(true), signal);
  if (canonical(baseline(stopped)) !== canonical(baseline(options.prepared.containers))) throw fail();
  const represented = new Set(appRuntimeImageBindings(state.runtime).map((item) => item.project));
  const apps = state.runtime.metadata.apps
    .filter((app) => represented.has(app.project))
    .map((app) => ({
      urn: app.urn,
      project: app.project,
      userConfigEnabled: app.userConfigEnabled,
      sourceSha256: app.sourceSha256,
      configurationSha256: app.configurationSha256,
      services: app.services.filter((service) => service.replicas > 0).map((service) => service.name),
    }));
  const capture = frozen({
    schema: 'orbis.time-machine-image-capture.v2' as const,
    pointId: options.prepared.pointId,
    createdAt: manifest.createdAt,
    backupManifestSha256: options.manifestSha256,
    platform: { ...state.platform },
    apps,
    containers: stopped,
    inventorySha256: options.prepared.inventorySha256,
    inventory: structuredClone(options.prepared.inventory),
    coverage: {
      appData: 'legacy-quiesced-container-copy',
      database: 'legacy-logical-dump',
      controller: 'not-quiesced',
      controllerConfiguration: 'not-captured',
      encryptedEnvelope: 'not-integrated',
      restoreReady: false,
    } as const,
  });
  await verifyCaptureAgainstBackup({
    capture,
    content: options.snapshotContent,
    manifestSha256: options.manifestSha256,
    appRuntime: state.runtime,
    signal,
  });
  for (const item of options.prepared.files) {
    const stream = await item.open(signal);
    for await (const _chunk of stream) {
      signal.throwIfAborted();
    }
  }
  await abortable(state.preflight(signal), signal);
  if (state.disposed() || canonical(await abortable(state.collect(true), signal)) !== canonical(stopped)) throw fail();
  await verifyCaptureAgainstBackup({
    capture,
    content: options.snapshotContent,
    manifestSha256: options.manifestSha256,
    appRuntime: state.runtime,
    signal,
  });
  const bytes = Buffer.from(canonical(capture));
  if (bytes.length < 1 || bytes.length > 4 * 1024 * 1024) throw fail();
  const captureFile: VerifiedImageCaptureFile = Object.freeze({
    name: 'capture.json',
    bytes: bytes.length,
    sha256: hash(bytes),
    open: async (callerSignal) => {
      const readerSignal = AbortSignal.any([state.signal, callerSignal]);
      readerSignal.throwIfAborted();
      if (state.disposed()) throw fail();
      const stream = Readable.from([Buffer.from(bytes)], { signal: readerSignal });
      stream.on('error', () => undefined);
      return stream;
    },
  });
  return Object.freeze({
    version: 2 as const,
    capture,
    sha256: captureFile.sha256,
    files: Object.freeze([captureFile, ...options.prepared.files]),
    dispose: options.prepared.dispose,
    toJSON(): never {
      throw fail();
    },
  });
}
