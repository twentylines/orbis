import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { type } from 'arktype';
import { parse } from 'yaml';
import { convertLegacyToYaml, dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import { appImagePinSourceSha256 } from '../docker/app-image-pins';
import { parseFullBackupManifest, type FullBackupManifest } from './backup-import';
import { appRuntimeImageBindings, type decodeAppRuntimeCapture } from './time-machine-app-runtime-capture';
import { fullBackupLimits } from './backup-limits';
import { captureRetainedImages, retainedImageLimits, type RetainedImageDocker, type RetainedImagePlatform } from './backup-image-retention';

export const imageCaptureLimits = { finalizeTimeoutMs: 60_000, metadataBytesPerPass: 32 * 1024 * 1024 } as const;
const fail = () => new Error('Time Machine image capture could not be verified. No exact restore point is available.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const imageId = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
const projectName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/;
const serviceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const appUrn = /^[a-z0-9][a-z0-9_-]{0,127}:[a-z0-9][a-z0-9_-]{0,127}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
export type ImageCaptureContainer = {
  id: string;
  imageId: string;
  reference: string;
  project: string;
  service: string;
  oneOff: boolean;
  running: boolean;
  paused: boolean;
  restarting: boolean;
};
export type ImageCaptureDocker = {
  containers: (project: string, signal: AbortSignal) => Promise<string[]>;
  container: (id: string, signal: AbortSignal) => Promise<ImageCaptureContainer>;
  inspectImage: RetainedImageDocker['inspect'];
  saveImage: RetainedImageDocker['save'];
  inspectControllerSource?: (id: string, signal: AbortSignal) => Promise<unknown>;
};
export type ImageCaptureOptions = {
  snapshotContent: string;
  stagingDirectory: string;
  manifestSha256: string;
  pointId: string;
  platform: RetainedImagePlatform;
  controller: { containerId: string; project: string; service: string };
  databaseId: string;
  apps: readonly { urn: string; userConfigEnabled: boolean; sourceSha256: string; services: readonly string[] }[];
  plannedContainers: readonly { id: string; project: string; running: boolean }[];
  docker: ImageCaptureDocker;
  signal: AbortSignal;
  preflight: (signal: AbortSignal) => Promise<void>;
  readAppSource: (urn: string, signal: AbortSignal) => Promise<{ sourceSha256: string; pinSourceSha256: string | null }>;
  limits?: Parameters<typeof captureRetainedImages>[0]['limits'];
};

export type ImageCapturePrepareOptions = Omit<ImageCaptureOptions, 'snapshotContent' | 'manifestSha256' | 'pointId'> & { snapshotContent?: string };

async function cancellable<T>(operation: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void operation.then(
      (value) => late?.(value),
      () => undefined,
    );
    signal.throwIfAborted();
  }
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
    if (signal.aborted)
      void operation.then(
        (value) => late?.(value),
        () => undefined,
      );
  }
}
async function privateDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.geteuid?.() ||
    stat.mode & 0o077 ||
    (await fs.realpath(directory)) !== directory
  )
    throw fail();
}
async function readBounded(root: string, name: string, maximum: number, signal: AbortSignal) {
  const file = path.join(root, name);
  if ((await fs.realpath(path.dirname(file))) !== path.dirname(file)) throw fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid?.() || before.size > maximum) throw fail();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - bytes));
      const part = await handle.read(buffer, 0, buffer.length, bytes);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
      if (bytes > maximum) throw fail();
      chunks.push(buffer.subarray(0, part.bytesRead));
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      bytes !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}
async function copiedFile(
  options: Pick<ImageCaptureOptions, 'snapshotContent'>,
  manifest: FullBackupManifest,
  name: string,
  signal: AbortSignal,
  required = true,
) {
  const entry = manifest.files.find((item) => item.name === name);
  if (!entry) {
    if (required) throw fail();
    return null;
  }
  const bytes = await readBounded(options.snapshotContent, name, 2 * 1024 * 1024, signal);
  if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw fail();
  return bytes;
}
async function appSources(
  options: Pick<ImageCaptureOptions, 'snapshotContent' | 'apps' | 'readAppSource'>,
  manifest: FullBackupManifest,
  signal: AbortSignal,
) {
  const sources = [];
  let metadataBytes = 0;
  const read = async (name: string, required = true) => {
    metadataBytes += manifest.files.find((entry) => entry.name === name)?.bytes ?? 0;
    if (metadataBytes > imageCaptureLimits.metadataBytesPerPass) throw fail();
    return copiedFile(options, manifest, name, signal, required);
  };
  for (const app of [...options.apps].sort((a, b) => (a.urn < b.urn ? -1 : 1))) {
    const [name, store] = app.urn.split(':');
    const root = `data/apps/${store}/${name}`;
    const config = await read(`${root}/config.json`);
    if (!config || !record(JSON.parse(config.toString('utf8')))) throw fail();
    const yaml = await read(`${root}/docker-compose.yml`, false);
    let source: unknown = yaml ? parse(yaml.toString('utf8')) : null;
    if (!record(source) || !('x-runtipi' in source)) {
      const legacy = await read(`${root}/docker-compose.json`);
      if (!legacy) throw fail();
      source = convertLegacyToYaml(JSON.parse(legacy.toString('utf8')));
    }
    const parsed = dynamicComposeSchemaYaml(source);
    if (parsed instanceof type.errors) throw fail();
    const user = app.userConfigEnabled ? await read(`data/user-config/${store}/${name}/docker-compose.yml`, false) : null;
    const generated = await read(`${root}/docker-compose.generated.yml`);
    if (!generated) throw fail();
    const services = new Set<string>();
    for (const text of [generated.toString('utf8'), user?.toString('utf8')]) {
      if (!text) continue;
      const compose = parse(text);
      if (!record(compose) || compose.include !== undefined || (compose.services !== undefined && !record(compose.services))) throw fail();
      for (const service of Object.keys(compose.services ?? {})) {
        if (!serviceName.test(service)) throw fail();
        services.add(service);
      }
    }
    if (!services.size || services.size > 256) throw fail();
    const sourceSha256 = appImagePinSourceSha256(parsed, user?.toString('utf8') ?? null);
    if (sourceSha256 !== app.sourceSha256 || [...services].sort().join('\0') !== [...app.services].sort().join('\0')) throw fail();
    const live = await cancellable(options.readAppSource(app.urn, signal), signal);
    if (live.sourceSha256 !== sourceSha256 || (live.pinSourceSha256 !== null && live.pinSourceSha256 !== sourceSha256)) throw fail();
    sources.push({
      urn: app.urn,
      project: app.urn.replace(':', '_'),
      userConfigEnabled: app.userConfigEnabled,
      sourceSha256,
      configurationSha256: sha(config),
      services: [...services].sort(),
    });
  }
  return sources;
}
/** Compares authenticated runtime capture to the extracted, checksum-reviewed backup. */
export async function verifyCaptureAgainstBackup(options: {
  capture: Record<string, unknown>;
  content: string;
  manifestSha256: string;
  excludedApps?: readonly string[];
  appRuntime?: ReturnType<typeof decodeAppRuntimeCapture>;
  signal: AbortSignal;
}) {
  await privateDirectory(options.content);
  const bytes = await readBounded(options.content, 'manifest.json', fullBackupLimits.manifestBytes, options.signal);
  if (sha(bytes) !== options.manifestSha256) throw fail();
  const manifest = parseFullBackupManifest(JSON.parse(bytes.toString('utf8')));
  if (options.capture.schema === 'orbis.time-machine-image-capture.v2') {
    if (!options.appRuntime) throw fail();
    await verifyV2CaptureAgainstBackup(
      options.capture,
      options.appRuntime,
      options.content,
      manifest,
      options.manifestSha256,
      options.excludedApps,
      options.signal,
    );
    return;
  }
  if (options.appRuntime) throw fail();
  const capture = options.capture as unknown as {
    createdAt: number;
    backupManifestSha256: string;
    platform: { architecture: string };
    apps: { urn: string; project: string; userConfigEnabled: boolean; sourceSha256: string; configurationSha256: string; services: string[] }[];
    containers: {
      id: string;
      project: string;
      role: string;
      appUrn: string | null;
      service: string;
      imageId: string;
      reference: string;
      wasRunning: boolean;
    }[];
  };
  if (
    manifest.createdAt !== capture.createdAt ||
    manifest.architecture !== capture.platform.architecture ||
    !manifest.exclusions.includes('container-images')
  )
    throw fail();
  const sources = await appSources(
    {
      snapshotContent: options.content,
      apps: capture.apps,
      readAppSource: async (urn) => {
        const app = capture.apps.find((item) => item.urn === urn);
        if (!app) throw fail();
        return { sourceSha256: app.sourceSha256, pinSourceSha256: null };
      },
    },
    manifest,
    options.signal,
  );
  if (canonical(sources) !== canonical(capture.apps) || capture.apps.some((app) => options.excludedApps?.includes(app.urn))) throw fail();
  const appContainers = capture.containers.filter((item) => item.role === 'app');
  const sort = (values: unknown[]) => values.sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  if (
    canonical(sort(appContainers.map(({ id, project, wasRunning }) => ({ id, project, running: wasRunning })))) !==
      canonical(sort([...manifest.containers])) ||
    canonical(sort(appContainers.map(({ project, reference }) => ({ project, image: reference })))) !== canonical(sort([...manifest.images]))
  )
    throw fail();
  const pins = manifest.files.filter((file) => file.name.startsWith('data/state/time-machine/image-pins/'));
  if (pins.length > capture.apps.length) throw fail();
  for (const file of pins) {
    const app = capture.apps.find((item) => file.name === `data/state/time-machine/image-pins/${sha(item.urn)}.json`);
    if (!app) throw fail();
    const raw = await copiedFile({ snapshotContent: options.content }, manifest, file.name, options.signal);
    if (!raw || raw.length > 128 * 1024) throw fail();
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (
      !record(value) ||
      Object.keys(value).sort().join('\0') !== ['services', 'x-orbis-image-pin'].join('\0') ||
      !record(value['x-orbis-image-pin']) ||
      !record(value.services)
    )
      throw fail();
    const pin = value['x-orbis-image-pin'];
    if (
      Object.keys(pin).sort().join('\0') !== ['appUrn', 'pointId', 'project', 'sourceSha256', 'version'].join('\0') ||
      pin.version !== 1 ||
      typeof pin.pointId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(pin.pointId) ||
      pin.appUrn !== app.urn ||
      pin.project !== app.project ||
      pin.sourceSha256 !== app.sourceSha256
    )
      throw fail();
    const expected = Object.fromEntries(
      capture.containers.filter((container) => container.appUrn === app.urn).map((container) => [container.service, container.imageId]),
    );
    const actual: Record<string, unknown> = {};
    for (const [service, entry] of Object.entries(value.services)) {
      if (!record(entry) || Object.keys(entry).sort().join('\0') !== ['image', 'pull_policy'].join('\0') || entry.pull_policy !== 'never')
        throw fail();
      actual[service] = entry.image;
    }
    if (canonical(actual) !== canonical(expected)) throw fail();
  }
}

async function verifyV2CaptureAgainstBackup(
  capture: Record<string, unknown>,
  runtime: ReturnType<typeof decodeAppRuntimeCapture>,
  content: string,
  manifest: FullBackupManifest,
  manifestSha256: string,
  excludedApps: readonly string[] | undefined,
  signal: AbortSignal,
) {
  const bindings = appRuntimeImageBindings(runtime);
  const descriptor = runtime.metadata;
  if (
    capture.pointId !== descriptor.pointId ||
    capture.backupManifestSha256 !== manifestSha256 ||
    capture.createdAt !== manifest.createdAt ||
    !record(capture.platform) ||
    capture.platform.architecture !== manifest.architecture ||
    !manifest.exclusions.includes('container-images') ||
    !Array.isArray(capture.apps) ||
    !Array.isArray(capture.containers) ||
    descriptor.apps.some((app) => excludedApps?.includes(app.urn))
  )
    throw fail();
  const represented = new Set(bindings.map((item) => item.project));
  const expectedApps = descriptor.apps
    .filter((app) => represented.has(app.project))
    .map((app) => ({
      urn: app.urn,
      project: app.project,
      userConfigEnabled: app.userConfigEnabled,
      sourceSha256: app.sourceSha256,
      configurationSha256: app.configurationSha256,
      services: app.services.filter((service) => service.replicas > 0).map((service) => service.name),
    }));
  if (canonical(capture.apps) !== canonical(expectedApps)) throw fail();
  const capturedApps = capture.containers.filter((item) => record(item) && item.role === 'app');
  if (capturedApps.length !== bindings.length) throw fail();
  for (const binding of bindings) {
    const matches = capturedApps.filter((item) => record(item) && item.id === binding.containerId);
    const item = matches[0];
    const historical = descriptor.containers.find((container) => container.inspect.Id === binding.containerId);
    if (
      matches.length !== 1 ||
      !record(item) ||
      !historical ||
      !record(historical.inspect.Config) ||
      typeof historical.inspect.Config.Image !== 'string' ||
      item.reference !== historical.inspect.Config.Image ||
      item.key !== binding.key ||
      item.imageId !== binding.imageId ||
      item.project !== binding.project ||
      item.service !== binding.service ||
      item.ordinal !== binding.ordinal ||
      item.wasRunning !== binding.wasRunning ||
      item.appUrn !== binding.key.split('/')[1]
    )
      throw fail();
  }
  const sort = (values: unknown[]) => values.sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  if (
    canonical(sort(bindings.map(({ containerId, project, wasRunning }) => ({ id: containerId, project, running: wasRunning })))) !==
    canonical(sort([...manifest.containers]))
  )
    throw fail();
  if (
    canonical(
      sort(
        capturedApps.map((item) => {
          if (!record(item) || typeof item.reference !== 'string') throw fail();
          return { project: item.project, image: item.reference };
        }),
      ),
    ) !== canonical(sort([...manifest.images]))
  )
    throw fail();
  let total = 0;
  const members = new Map(manifest.files.map((file) => [file.name, file]));
  for (const app of descriptor.apps) {
    const [name, store] = app.urn.split(':');
    const base = `data/apps/${store}/${name}`;
    const allowed = [
      `${base}/config.json`,
      `${base}/docker-compose.yml`,
      `${base}/docker-compose.json`,
      `${base}/docker-compose.generated.yml`,
      `data/user-config/${store}/${name}/docker-compose.yml`,
      `app-data/${store}/${name}/app.env`,
    ];
    for (const filename of allowed) {
      signal.throwIfAborted();
      const expected = app.savedFiles.find((entry) => entry.name === filename);
      const member = members.get(filename);
      if (!expected) {
        if (member) throw fail();
        continue;
      }
      if (!member || member.bytes !== expected.bytes || member.sha256 !== expected.sha256) throw fail();
      total += member.bytes;
      if (!Number.isSafeInteger(total) || total > imageCaptureLimits.metadataBytesPerPass) throw fail();
      const saved = await readBounded(content, filename, 2 * 1024 * 1024, signal);
      if (saved.length !== expected.bytes || sha(saved) !== expected.sha256) throw fail();
    }
  }
}

function checkedContainer(value: ImageCaptureContainer) {
  if (
    !value ||
    !containerId.test(value.id) ||
    !imageId.test(value.imageId) ||
    typeof value.project !== 'string' ||
    !projectName.test(value.project) ||
    typeof value.service !== 'string' ||
    !serviceName.test(value.service) ||
    typeof value.reference !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,2047}$/.test(value.reference) ||
    value.oneOff !== false ||
    typeof value.running !== 'boolean' ||
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
    oneOff: false,
    running: value.running,
    paused: false,
    restarting: false,
  };
}
async function runtimeInventory(
  options: ImageCapturePrepareOptions,
  manifest: FullBackupManifest | null,
  sources: readonly { urn: string; project: string; services: readonly string[] }[],
  signal: AbortSignal,
  quiesced: boolean,
) {
  const controller = checkedContainer(await cancellable(options.docker.container(options.controller.containerId, signal), signal));
  if (
    !controller.id.startsWith(options.controller.containerId) ||
    controller.project !== options.controller.project ||
    controller.service !== options.controller.service ||
    !controller.running
  )
    throw fail();
  const projects = [...new Set([controller.project, ...sources.map((app) => app.project)])].sort();
  const containers: ImageCaptureContainer[] = [];
  for (const project of projects) {
    const ids = await cancellable(options.docker.containers(project, signal), signal);
    if (!Array.isArray(ids) || ids.length > 1024 || new Set(ids).size !== ids.length || ids.some((id) => !containerId.test(id))) throw fail();
    for (const id of ids.sort()) {
      const container = checkedContainer(await cancellable(options.docker.container(id, signal), signal));
      if (container.id !== id || container.project !== project) throw fail();
      containers.push(container);
      if (containers.length > 1024) throw fail();
    }
  }
  if (!containers.some((container) => canonical(container) === canonical(controller))) throw fail();
  const database = checkedContainer(await cancellable(options.docker.container(options.databaseId, signal), signal));
  if (database.id !== options.databaseId || !database.running || !/(?:^|\/)postgres(?:[:@]|$)/.test(database.reference)) throw fail();
  if (sources.some((app) => app.project === database.project) || database.id === controller.id) throw fail();
  if (!containers.some((container) => container.id === database.id)) containers.push(database);
  for (const source of sources) {
    const selected = containers.filter((container) => container.project === source.project);
    if (
      (quiesced && selected.some((container) => container.running)) ||
      selected
        .map((container) => container.service)
        .sort()
        .join('\0') !== source.services.join('\0')
    )
      throw fail();
  }
  const appContainers = containers.filter((container) => sources.some((app) => app.project === container.project));
  if (
    canonical(appContainers.map(({ id, project }) => ({ id, project })).sort((a, b) => (a.id < b.id ? -1 : 1))) !==
    canonical((manifest?.containers ?? options.plannedContainers).map(({ id, project }) => ({ id, project })).sort((a, b) => (a.id < b.id ? -1 : 1)))
  )
    throw fail();
  if (
    manifest &&
    canonical(
      appContainers.map(({ project, reference }) => ({ project, image: reference })).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1)),
    ) !== canonical(manifest.images.map((entry) => ({ ...entry })).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1)))
  )
    throw fail();
  return containers
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((container) => {
      const app = sources.find((source) => source.project === container.project);
      return {
        ...container,
        role: container.id === controller.id ? 'controller' : container.id === database.id ? 'database' : app ? 'app' : 'controller-service',
        appUrn: app?.urn ?? null,
        key: app ? `apps/${app.urn}/${container.service}` : `controller/${container.project}/${container.service}`,
        wasRunning: app
          ? ((manifest?.containers ?? options.plannedContainers).find((item) => item.id === container.id)?.running ?? false)
          : container.running,
      };
    });
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
type ArchiveSeal = Stats;
const sameSeal = (a: ArchiveSeal, b: ArchiveSeal) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
export type PreparedTimeMachineImages = Readonly<{ directory: string; preparedAt: number; inventorySha256: string; dispose: () => Promise<void> }>;
export type VerifiedImageCaptureFile = Readonly<{ name: string; bytes: number; sha256: string; open: (signal: AbortSignal) => Promise<Readable> }>;
type PreparedState = {
  options: ImageCapturePrepareOptions;
  signal: AbortSignal;
  containers: Awaited<ReturnType<typeof runtimeInventory>>;
  inventory: Awaited<ReturnType<typeof captureRetainedImages>>['inventory'];
  files: VerifiedImageCaptureFile[];
  seals: ArchiveSeal[];
  root: ArchiveSeal;
};
const preparations = new WeakMap<PreparedTimeMachineImages, PreparedState>();

function validateOptions(options: ImageCapturePrepareOptions) {
  if (
    !['linux'].includes(options.platform.os) ||
    !['arm64', 'amd64'].includes(options.platform.architecture) ||
    (options.platform.variant !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.platform.variant)) ||
    !/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(options.controller.containerId) ||
    !containerId.test(options.databaseId) ||
    !projectName.test(options.controller.project) ||
    !serviceName.test(options.controller.service) ||
    options.apps.length > 256 ||
    options.plannedContainers.length > 1024 ||
    options.plannedContainers.some((item) => !containerId.test(item.id) || !projectName.test(item.project) || typeof item.running !== 'boolean') ||
    options.apps.some(
      (app) =>
        !appUrn.test(app.urn) ||
        typeof app.userConfigEnabled !== 'boolean' ||
        app.urn.replace(':', '_') === options.controller.project ||
        !/^[a-f0-9]{64}$/.test(app.sourceSha256) ||
        !app.services.length ||
        app.services.length > 256 ||
        new Set(app.services).size !== app.services.length ||
        app.services.some((service) => !serviceName.test(service)),
    ) ||
    new Set(options.apps.map((app) => app.urn.replace(':', '_'))).size !== options.apps.length
  )
    throw fail();
}
async function liveSources(options: ImageCapturePrepareOptions, signal: AbortSignal) {
  for (const app of options.apps) {
    const current = await cancellable(options.readAppSource(app.urn, signal), signal);
    if (current.sourceSha256 !== app.sourceSha256 || (current.pinSourceSha256 !== null && current.pinSourceSha256 !== app.sourceSha256)) throw fail();
  }
}
const expectedSources = (options: ImageCapturePrepareOptions) => options.apps.map((app) => ({ ...app, project: app.urn.replace(':', '_') }));
async function fileSeal(root: string, name: string, bytes: number, expected?: ArchiveSeal) {
  await privateDirectory(root);
  const target = path.join(root, name);
  if ((await fs.realpath(path.dirname(target))) !== path.dirname(target)) throw fail();
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const current = await fs.lstat(target);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.geteuid?.() ||
      stat.mode & 0o077 ||
      stat.size !== bytes ||
      !sameSeal(stat, current) ||
      (expected && !sameSeal(stat, expected))
    )
      throw fail();
    return stat;
  } finally {
    await handle.close();
  }
}
function verifiedFile(root: string, rootSeal: ArchiveSeal, name: string, bytes: number, hash: string, seal: ArchiveSeal): VerifiedImageCaptureFile {
  return Object.freeze({
    name,
    bytes,
    sha256: hash,
    open: async (callerSignal: AbortSignal) => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(retainedImageLimits.operationTimeoutMs)]);
      signal.throwIfAborted();
      await privateDirectory(root);
      if (!sameSealRoot(await fs.lstat(root), rootSeal)) throw fail();
      await fileSeal(root, name, bytes, seal);
      const target = path.join(root, name);
      const reader = Readable.from(
        (async function* () {
          signal.throwIfAborted();
          const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let input: ReturnType<typeof handle.createReadStream> | undefined;
          const sum = createHash('sha256');
          let read = 0;
          try {
            if (!sameSeal(await handle.stat(), seal) || !sameSealRoot(await fs.lstat(root), rootSeal)) throw fail();
            input = handle.createReadStream({ autoClose: false, signal });
            for await (const chunk of input) {
              signal.throwIfAborted();
              read += chunk.length;
              if (read > bytes) throw fail();
              sum.update(chunk);
              yield chunk;
            }
            if (
              read !== bytes ||
              sum.digest('hex') !== hash ||
              !sameSeal(await handle.stat(), seal) ||
              !sameSeal(await fs.lstat(target), seal) ||
              !sameSealRoot(await fs.lstat(root), rootSeal)
            )
              throw fail();
          } finally {
            input?.destroy();
            await handle.close();
          }
        })(),
        { signal },
      );
      reader.on('error', () => undefined);
      return reader;
    },
  });
}
const sameSealRoot = (a: ArchiveSeal, b: ArchiveSeal) =>
  a.isDirectory() && !a.isSymbolicLink() && a.ino === b.ino && a.dev === b.dev && a.uid === b.uid && (a.mode & 0o777) === 0o700;
async function disposeDirectory(directory: string, root: ArchiveSeal) {
  if (!sameSealRoot(await fs.lstat(directory), root)) throw fail();
  await fs.rm(directory, { recursive: true });
}

export async function prepareTimeMachineImages(input: ImageCapturePrepareOptions): Promise<PreparedTimeMachineImages> {
  const options = structuredOptions(input);
  validateOptions(options);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.limits?.operationTimeoutMs ?? retainedImageLimits.operationTimeoutMs)]);
  signal.throwIfAborted();
  await privateDirectory(options.stagingDirectory);
  if (
    options.snapshotContent &&
    (options.stagingDirectory === options.snapshotContent || options.stagingDirectory.startsWith(`${options.snapshotContent}${path.sep}`))
  )
    throw fail();
  await cancellable(options.preflight(signal), signal);
  await liveSources(options, signal);
  const containers = await runtimeInventory(options, null, expectedSources(options), signal, false);
  const directory = await fs.mkdtemp(path.join(options.stagingDirectory, 'time-machine-images-'));
  const root = await fs.lstat(directory);
  try {
    const images: RetainedImageDocker = {
      inspect: options.docker.inspectImage,
      save: options.docker.saveImage,
      load: async () => {
        throw fail();
      },
      preflightLoad: async () => {
        throw fail();
      },
    };
    const saved = await captureRetainedImages({
      stagingDirectory: directory,
      docker: images,
      bindings: containers.map(({ key, imageId }) => ({ key, imageId })),
      platform: options.platform,
      signal,
      limits: options.limits,
    });
    await fs.rename(saved.directory, path.join(directory, 'images'));
    await cancellable(options.preflight(signal), signal);
    await liveSources(options, signal);
    if (canonical(await runtimeInventory(options, null, expectedSources(options), signal, false)) !== canonical(containers)) throw fail();
    const files: VerifiedImageCaptureFile[] = [];
    const seals: ArchiveSeal[] = [];
    for (const image of saved.inventory.images) {
      const name = `images/${image.archive}`;
      const seal = await fileSeal(directory, name, image.bytes);
      const file = verifiedFile(directory, root, name, image.bytes, image.sha256, seal);
      const reader = await file.open(signal);
      for await (const _chunk of reader) {
        /* verify before the outage */
      }
      files.push(file);
      seals.push(seal);
    }
    const prepared = Object.freeze({
      directory,
      preparedAt: Date.now(),
      inventorySha256: sha(canonical(saved.inventory)),
      dispose: async () => {
        await disposeDirectory(directory, root);
        preparations.delete(prepared);
      },
    });
    preparations.set(prepared, { options: structuredOptions(options), signal, containers, inventory: saved.inventory, files, seals, root });
    return prepared;
  } catch (error) {
    await disposeDirectory(directory, root);
    throw error;
  }
}
function structuredOptions(options: ImageCapturePrepareOptions): ImageCapturePrepareOptions {
  return {
    ...options,
    apps: options.apps.map((app) => ({ ...app, services: [...app.services] })),
    plannedContainers: options.plannedContainers.map((item) => ({ ...item })),
    controller: { ...options.controller },
    platform: { ...options.platform },
    limits: options.limits ? { ...options.limits } : undefined,
  };
}
function identityAtBarrier(containers: Awaited<ReturnType<typeof runtimeInventory>>) {
  return containers.map((container) => ({ ...container, running: container.role === 'app' ? false : container.running }));
}

export async function captureTimeMachineImages(input: {
  preparation: PreparedTimeMachineImages;
  snapshotContent: string;
  manifestSha256: string;
  pointId: string;
  signal: AbortSignal;
}) {
  const prepared = preparations.get(input.preparation);
  if (!prepared) throw fail();
  const options = { ...prepared.options, snapshotContent: input.snapshotContent, manifestSha256: input.manifestSha256, pointId: input.pointId };
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.pointId) ||
    !/^[a-f0-9]{64}$/.test(options.manifestSha256)
  )
    throw fail();
  if (input.preparation.directory === input.snapshotContent || input.preparation.directory.startsWith(`${input.snapshotContent}${path.sep}`))
    throw fail();
  const signal = AbortSignal.any([prepared.signal, input.signal, AbortSignal.timeout(imageCaptureLimits.finalizeTimeoutMs)]);
  signal.throwIfAborted();
  await privateDirectory(options.snapshotContent);
  await cancellable(options.preflight(signal), signal);
  const manifestBytes = await readBounded(options.snapshotContent, 'manifest.json', fullBackupLimits.manifestBytes, signal);
  if (sha(manifestBytes) !== options.manifestSha256) throw fail();
  const manifest = parseFullBackupManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (
    manifest.architecture !== options.platform.architecture ||
    !manifest.exclusions.includes('container-images') ||
    canonical([...options.plannedContainers].sort((a, b) => (a.id < b.id ? -1 : 1))) !==
      canonical([...manifest.containers].sort((a, b) => (a.id < b.id ? -1 : 1)))
  )
    throw fail();
  const sources = await appSources(options, manifest, signal);
  const containers = await runtimeInventory(options, manifest, sources, signal, true);
  if (canonical(identityAtBarrier(containers)) !== canonical(identityAtBarrier(prepared.containers))) throw fail();
  for (const [index, file] of prepared.files.entries()) await fileSeal(input.preparation.directory, file.name, file.bytes, prepared.seals[index]);
  await cancellable(options.preflight(signal), signal);
  if (
    canonical(await appSources(options, manifest, signal)) !== canonical(sources) ||
    canonical(await runtimeInventory(options, manifest, sources, signal, true)) !== canonical(containers) ||
    sha(await readBounded(options.snapshotContent, 'manifest.json', fullBackupLimits.manifestBytes, signal)) !== options.manifestSha256
  )
    throw fail();
  for (const [index, file] of prepared.files.entries()) await fileSeal(input.preparation.directory, file.name, file.bytes, prepared.seals[index]);
  const capture = {
    schema: 'orbis.time-machine-image-capture.v1' as const,
    pointId: options.pointId,
    createdAt: manifest.createdAt,
    backupManifestSha256: options.manifestSha256,
    platform: { ...options.platform },
    apps: sources,
    containers,
    inventorySha256: input.preparation.inventorySha256,
    inventory: structuredClone(prepared.inventory),
    coverage: {
      appData: 'legacy-quiesced-container-copy',
      database: 'legacy-logical-dump',
      controller: 'not-quiesced',
      controllerConfiguration: 'not-captured',
      encryptedEnvelope: 'not-integrated',
      restoreReady: false,
    } as const,
  };
  frozen(capture);
  const bytes = Buffer.from(canonical(capture));
  if (bytes.length > 4 * 1024 * 1024) throw fail();
  signal.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(options.stagingDirectory, 'time-machine-image-record-'));
  const root = await fs.lstat(directory);
  try {
    const output = await fs.open(
      path.join(directory, 'capture.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await output.writeFile(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameSealRoot(await parent.stat(), root)) throw fail();
      await parent.sync();
    } finally {
      await parent.close();
    }
    const seal = await fileSeal(directory, 'capture.json', bytes.length);
    return {
      directory,
      capture,
      sha256: sha(bytes),
      files: Object.freeze([verifiedFile(directory, root, 'capture.json', bytes.length, sha(bytes), seal), ...prepared.files]),
      dispose: () => disposeDirectory(directory, root),
    };
  } catch (error) {
    await disposeDirectory(directory, root);
    throw error;
  }
}

// Installed Dockerode image.get/inspect do not forward platform and cancellation together.
export function imageCaptureDocker(docker: Dockerode): ImageCaptureDocker {
  const stream = (route: string, options: Record<string, unknown>, signal: AbortSignal) =>
    cancellable(
      new Promise<Readable>((resolve, reject) => {
        signal.throwIfAborted();
        docker.modem.dial(
          {
            path: route,
            method: 'GET',
            options,
            abortSignal: signal,
            isStream: true,
            statusCodes: { 200: true, 400: 'Image capture unavailable', 404: 'Image capture unavailable', 500: 'Image capture unavailable' },
          },
          (error, value) => {
            if (error) reject(fail());
            else if (value instanceof Readable) {
              const abort = () => value.destroy(fail());
              value.on('error', () => undefined);
              signal.addEventListener('abort', abort, { once: true });
              value.once('close', () => signal.removeEventListener('abort', abort));
              if (signal.aborted) {
                value.destroy();
                reject(fail());
              } else resolve(value);
            } else reject(fail());
          },
        );
      }),
      signal,
      (late) => late.destroy(),
    );
  const json = async (route: string, options: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const input = await stream(route, options, signal);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const abort = () => input.destroy(fail());
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      for await (const chunk of input) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw fail();
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      signal.removeEventListener('abort', abort);
      input.destroy();
    }
  };
  return {
    containers: async (project, signal) => {
      if (!projectName.test(project)) throw fail();
      const rows = await json(
        '/containers/json?',
        { all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) },
        signal,
      );
      if (!Array.isArray(rows) || rows.length > 1024) throw fail();
      return rows.map((row) => {
        if (!record(row) || typeof row.Id !== 'string' || !containerId.test(row.Id)) throw fail();
        return row.Id;
      });
    },
    container: async (id, signal) => {
      if (!/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(id)) throw fail();
      const value = await json(`/containers/${id}/json?`, {}, signal);
      if (!record(value) || !record(value.Config) || !record(value.Config.Labels) || !record(value.State)) throw fail();
      const labels = value.Config.Labels;
      return checkedContainer({
        id: value.Id,
        imageId: value.Image,
        reference: value.Config.Image,
        project: labels['com.docker.compose.project'],
        service: labels['com.docker.compose.service'],
        oneOff: typeof labels['com.docker.compose.oneoff'] !== 'string' || labels['com.docker.compose.oneoff'].toLowerCase() !== 'false',
        running: value.State.Running,
        paused: value.State.Paused,
        restarting: value.State.Restarting,
      } as ImageCaptureContainer);
    },
    inspectImage: async (id, signal, platform) => {
      if (!imageId.test(id)) throw fail();
      const value = await json(
        `/images/${encodeURIComponent(id)}/json?`,
        platform ? { platform: JSON.stringify(platform) } : { manifests: true },
        signal,
      );
      if (!record(value)) throw fail();
      return {
        Id: value.Id,
        RepoDigests: value.RepoDigests,
        Os: value.Os,
        Architecture: value.Architecture,
        Variant: value.Variant,
        Manifests: value.Manifests,
      } as Awaited<ReturnType<RetainedImageDocker['inspect']>>;
    },
    saveImage: async (id, signal, platform) => {
      if (!imageId.test(id)) throw fail();
      return stream(`/images/${encodeURIComponent(id)}/get?`, platform ? { platform: JSON.stringify(platform) } : {}, signal);
    },
    inspectControllerSource: async (id, signal) => {
      if (!imageId.test(id)) throw fail();
      const value = await json(`/images/${encodeURIComponent(id)}/json?`, { manifests: true }, signal);
      if (!record(value) || !record(value.Config) || !record(value.Config.Labels)) throw fail();
      const labels = value.Config.Labels;
      return {
        Id: value.Id,
        RepoDigests: value.RepoDigests,
        Os: value.Os,
        Architecture: value.Architecture,
        Variant: value.Variant,
        Labels: Object.fromEntries(
          [
            'org.opencontainers.image.source',
            'org.opencontainers.image.version',
            'org.opencontainers.image.revision',
            'io.orbis.installation-protocol',
          ]
            .filter((key) => Object.hasOwn(labels, key))
            .map((key) => [key, labels[key]]),
        ),
      };
    },
  };
}
