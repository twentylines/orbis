import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { readTarArchive, type TarEntry } from '@/core/archive/tar-metadata';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { fullBackupLimits } from './backup-limits';

export type BackupVolumeMount = {
  containerId: string;
  project: string;
  service: string;
  ordinal: number;
  target: string;
  readOnly: boolean;
};
export type BackupVolume = { key: string; sourceName: string; mounts: readonly BackupVolumeMount[] };
export type BackupVolumeEntry =
  | { name: string; kind: 'directory' | 'socket' }
  | { name: string; kind: 'file'; bytes: number; sha256: string }
  | { name: string; kind: 'symlink'; target: string };
export type BackupVolumeInventory = { key: string; sourceName: string; containerId: string; entries: readonly BackupVolumeEntry[] };
export type BackupVolumeArchive = BackupVolume & {
  archive: { name: string; root: string; bytes: number; sha256: string };
  inventory: { name: string; bytes: number; sha256: string };
  excludedRuntimeSockets: string[];
};
export type BackupVolumePlan = Readonly<{ version: 1; volumes: readonly BackupVolume[] }>;
type Container = Dockerode.ContainerInspectInfo;
const hex = /^[a-f0-9]{64}$/;
const volumeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const serviceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const failed = () => new BackupRequirementError('App volume storage changed or cannot be captured safely. No source volume was changed.');
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export async function requireLegacyBackupVolumePolicy(dataDir: string) {
  if (process.env.ORBIS_APP_VOLUME_AUTHORITY && process.env.ORBIS_APP_VOLUME_AUTHORITY !== 'none')
    throw new BackupRequirementError('This server needs volume-aware backup support before another complete backup can be created.');
  for (const directory of [path.join(dataDir, 'state', 'app-volume-pins'), path.join(dataDir, 'orbis-volumes')]) {
    try {
      await fs.lstat(directory);
      throw new BackupRequirementError('This server needs volume-aware backup support before another complete backup can be created.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
async function engineRead<T>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const bounded = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error('App volume storage did not respond.')), 30_000);
  timer.unref();
  let aborted = false;
  let abort = () => undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => {
        aborted = true;
        reject(bounded.reason);
      };
      bounded.addEventListener('abort', abort, { once: true });
      void read(bounded).then((value) => {
        if (aborted) {
          if (value instanceof Readable) value.destroy();
        } else resolve(value);
      }, reject);
    });
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener('abort', abort);
  }
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item,
  );
const text = (value: string) =>
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\' || character === '\uFFFD',
  ) && !/[\uD800-\uDFFF]/u.test(value);
function target(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value !== '/' &&
    Buffer.byteLength(value) <= 4096 &&
    text(value) &&
    path.posix.normalize(value) === value &&
    !value.endsWith('/') &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function volumeIdentity(raw: Dockerode.VolumeInspectInfo & { CreatedAt?: unknown }, name: string) {
  if (
    !raw ||
    raw.Name !== name ||
    raw.Driver !== 'local' ||
    raw.Scope !== 'local' ||
    typeof raw.CreatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.CreatedAt)) ||
    (raw.Options !== null && (typeof raw.Options !== 'object' || Array.isArray(raw.Options) || Object.keys(raw.Options).length)) ||
    (raw.Labels !== null &&
      (typeof raw.Labels !== 'object' || Array.isArray(raw.Labels) || Object.values(raw.Labels).some((value) => typeof value !== 'string')))
  )
    throw failed();
  const identity = canonical({ name, driver: raw.Driver, scope: raw.Scope, createdAt: raw.CreatedAt, options: raw.Options, labels: raw.Labels });
  if (Buffer.byteLength(identity) > 64 * 1024) throw failed();
  return identity;
}
function containerIdentity(raw: Container) {
  if (!raw || !hex.test(raw.Id) || !Array.isArray(raw.Mounts) || raw.Mounts.length > 256 || !raw.Config || !raw.State) throw failed();
  const identity = canonical({ id: raw.Id, image: raw.Image, startedAt: raw.State.StartedAt, labels: raw.Config.Labels, mounts: raw.Mounts });
  if (Buffer.byteLength(identity) > 256 * 1024) throw failed();
  return identity;
}

function member(value: string) {
  const name = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!name || !text(name) || Buffer.byteLength(name) > 4096 || path.posix.isAbsolute(name)) throw failed();
  if (name.split('/').some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) throw failed();
  return name;
}

// The archive stays opaque to the host filesystem. Only a verified fresh Docker
// volume may receive it; checking the complete link graph precedes any upload.
export async function inspectDockerVolumeArchive(
  file: string,
  root: string,
  maximumBytes: number,
  signal: AbortSignal,
  expected?: readonly BackupVolumeEntry[],
) {
  if (member(root) !== root || root.includes('/') || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) throw failed();
  const entries = new Map<string, TarEntry>();
  const contents = new Map<string, { bytes: number; sha256: string }>();
  let current: { name: string; bytes: number; hash: ReturnType<typeof createHash> } | undefined;
  let namesBytes = 0;
  await readTarArchive(file, false, signal, {
    strict: true,
    maxEntries: fullBackupLimits.entries,
    maxExpandedBytes: maximumBytes,
    collectEntries: false,
    onEntry: async (entry) => {
      const name = member(entry.path);
      if (
        entries.has(name) ||
        (name !== root && !name.startsWith(`${root}/`)) ||
        !['-', 'd', 'l', 'h'].includes(entry.type) ||
        ((entry.type === 'l' || entry.type === 'h') && entry.size !== 0)
      )
        throw failed();
      namesBytes += Buffer.byteLength(name) + Buffer.byteLength(entry.linkTarget ?? '');
      if (namesBytes > fullBackupLimits.pathBytes) throw failed();
      entries.set(name, { ...entry, path: name });
      if (entry.type === '-') current = { name, bytes: 0, hash: createHash('sha256') };
    },
    onData: async (bytes) => {
      if (!current) throw failed();
      current.bytes += bytes.length;
      current.hash.update(bytes);
    },
    onEntryEnd: async () => {
      if (current) contents.set(current.name, { bytes: current.bytes, sha256: current.hash.digest('hex') });
      current = undefined;
    },
  });
  if (entries.get(root)?.type !== 'd') throw failed();
  const order = new Map([...entries.keys()].map((name, index) => [name, index]));
  const hardTarget = (name: string, entry: TarEntry) => {
    const resolved = member(entry.linkTarget ?? '');
    if (
      !resolved.startsWith(`${root}/`) ||
      entries.get(resolved)?.type !== '-' ||
      (order.get(resolved) ?? Number.POSITIVE_INFINITY) >= (order.get(name) ?? -1)
    )
      throw failed();
    return resolved;
  };
  for (const [name, entry] of entries) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent))
      if (entries.get(parent)?.type !== 'd') throw failed();
    if (entry.type !== 'l' && entry.type !== 'h') continue;
    const link = entry.linkTarget;
    if (!link || !text(link) || path.posix.isAbsolute(link) || Buffer.byteLength(link) > 4096) throw failed();
    const components = path.posix.dirname(name).split('/');
    if (entry.type === 'l')
      for (const part of link.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
          if (components.length <= 1) throw failed();
          components.pop();
        } else components.push(part);
      }
    const resolved = entry.type === 'h' ? hardTarget(name, entry) : components.join('/');
    if (!resolved.startsWith(`${root}/`) || !entries.has(resolved)) throw failed();
    const destination = entries.get(resolved);
    if (!destination || !['-', 'd', 'h'].includes(destination.type)) throw failed();
    if (destination.type === 'h') hardTarget(resolved, destination);
    if (destination.type === 'd' && (path.posix.dirname(name) === resolved || path.posix.dirname(name).startsWith(`${resolved}/`))) throw failed();
    for (let parent = path.posix.dirname(resolved); parent !== '.'; parent = path.posix.dirname(parent))
      if (entries.get(parent)?.type !== 'd') throw failed();
  }
  const excludedRuntimeSockets: string[] = [];
  if (expected !== undefined) {
    if (!Array.isArray(expected) || expected.length > fullBackupLimits.entries) throw failed();
    const names = new Set<string>();
    let paths = 0;
    for (const entry of expected) {
      if (!entry || typeof entry.name !== 'string' || (entry.name !== '.' && member(entry.name) !== entry.name) || names.has(entry.name))
        throw failed();
      names.add(entry.name);
      paths += Buffer.byteLength(entry.name);
      const name = entry.name === '.' ? root : `${root}/${entry.name}`;
      const actual = entries.get(name);
      if (entry.kind === 'file') {
        if (
          Object.keys(entry).sort().join(',') !== 'bytes,kind,name,sha256' ||
          !Number.isSafeInteger(entry.bytes) ||
          entry.bytes < 0 ||
          !hex.test(entry.sha256)
        )
          throw failed();
        const content = actual?.type === 'h' ? contents.get(hardTarget(name, actual)) : contents.get(name);
        if (!actual || !['-', 'h'].includes(actual.type) || !content || content.bytes !== entry.bytes || content.sha256 !== entry.sha256)
          throw failed();
      } else if (entry.kind === 'symlink') {
        if (Object.keys(entry).sort().join(',') !== 'kind,name,target' || typeof entry.target !== 'string' || !text(entry.target)) throw failed();
        paths += Buffer.byteLength(entry.target);
        if (actual?.type !== 'l' || actual.linkTarget !== entry.target) throw failed();
      } else if (entry.kind === 'directory' || entry.kind === 'socket') {
        if (Object.keys(entry).sort().join(',') !== 'kind,name') throw failed();
        if (entry.kind === 'directory' ? actual?.type !== 'd' : actual !== undefined) throw failed();
        if (entry.kind === 'socket') excludedRuntimeSockets.push(entry.name);
      } else throw failed();
    }
    if (!expected.some((entry) => entry.name === '.' && entry.kind === 'directory') || paths > fullBackupLimits.pathBytes) throw failed();
    for (const name of entries.keys()) if (!names.has(name === root ? '.' : name.slice(root.length + 1))) throw failed();
    const kinds = new Map(expected.map((entry) => [entry.name, entry.kind]));
    for (const entry of expected)
      for (let parent = path.posix.dirname(entry.name); entry.name !== '.'; parent = path.posix.dirname(parent)) {
        if (kinds.get(parent) !== 'directory') throw failed();
        if (parent === '.') break;
      }
  }
  return { entries: entries.size, pathBytes: namesBytes, excludedRuntimeSockets: excludedRuntimeSockets.sort(compare) };
}

export class BackupDockerVolumes {
  private readonly issued = new WeakMap<BackupVolumePlan, { containers: Map<string, string>; volumes: Map<string, string> }>();
  constructor(private readonly docker: Dockerode) {}

  private async containers(signal: AbortSignal) {
    signal.throwIfAborted();
    const rows = await engineRead(signal, (abortSignal) => this.docker.listContainers({ all: true, abortSignal }));
    if (rows.length > 4096 || new Set(rows.map((row) => row.Id)).size !== rows.length || rows.some((row) => !hex.test(row.Id))) throw failed();
    const result: Container[] = [];
    for (const row of rows) {
      signal.throwIfAborted();
      const raw = await engineRead(signal, (abortSignal) => this.docker.getContainer(row.Id).inspect({ abortSignal }));
      if (raw.Id !== row.Id) throw failed();
      containerIdentity(raw);
      result.push(raw);
    }
    signal.throwIfAborted();
    return result;
  }

  async plan(managed: readonly { id: string; project: string }[], signal: AbortSignal): Promise<BackupVolumePlan> {
    if (
      managed.length > 1024 ||
      new Set(managed.map((item) => item.id)).size !== managed.length ||
      managed.some((item) => !hex.test(item.id) || !/^[a-zA-Z0-9_-]{1,255}$/.test(item.project))
    )
      throw failed();
    const selected = new Map(managed.map((item) => [item.id, item.project]));
    const all = await this.containers(signal);
    const byId = new Map(all.map((item) => [item.Id, item]));
    const volumes = new Map<string, BackupVolumeMount[]>();
    const bindings = new Set<string>();
    const containers = new Map<string, string>();
    const serviceBindings = new Map<string, string>();
    for (const item of managed) {
      const raw = byId.get(item.id);
      if (!raw || raw.Config.Labels?.['com.docker.compose.project'] !== item.project || raw.State.Paused || raw.State.Restarting) throw failed();
      if (raw.HostConfig?.Mounts?.some((mount) => mount.Type === 'volume' && mount.VolumeOptions?.Subpath)) throw failed();
      containers.set(item.id, containerIdentity(raw));
      for (const mount of raw.Mounts) {
        if (mount.Type !== 'volume') continue;
        const labels = raw.Config.Labels;
        const service = labels['com.docker.compose.service'];
        const ordinal = labels['com.docker.compose.container-number'];
        if (
          typeof mount.Name !== 'string' ||
          !volumeName.test(mount.Name) ||
          !target(mount.Destination) ||
          typeof mount.RW !== 'boolean' ||
          typeof service !== 'string' ||
          !serviceName.test(service) ||
          !/^[1-9][0-9]{0,3}$/.test(ordinal ?? '') ||
          labels['runtipi.managed'] !== 'true' ||
          labels['runtipi.appurn']?.replace(':', '_') !== item.project
        )
          throw failed();
        if (raw.Mounts.some((other) => other !== mount && other.Destination?.startsWith(`${mount.Destination}/`))) throw failed();
        const serviceKey = canonical([item.project, service, mount.Destination]);
        const serviceBinding = canonical([mount.Name, !mount.RW]);
        if (serviceBindings.has(serviceKey) && serviceBindings.get(serviceKey) !== serviceBinding) throw failed();
        serviceBindings.set(serviceKey, serviceBinding);
        const key = `${item.id}:${mount.Destination}`;
        if (bindings.has(key)) throw failed();
        bindings.add(key);
        const mounts = volumes.get(mount.Name) ?? [];
        mounts.push({
          containerId: item.id,
          project: item.project,
          service,
          ordinal: Number(ordinal),
          target: mount.Destination,
          readOnly: !mount.RW,
        });
        volumes.set(mount.Name, mounts);
      }
    }
    if (volumes.size > 1024 || bindings.size > 4096) throw failed();
    for (const raw of all)
      if (raw.Mounts.some((mount) => mount.Type === 'volume' && mount.Name && volumes.has(mount.Name)) && !selected.has(raw.Id)) throw failed();
    const identities = new Map<string, string>();
    const records: BackupVolume[] = [];
    for (const [name, mounts] of [...volumes].sort(([a], [b]) => compare(a, b))) {
      signal.throwIfAborted();
      identities.set(name, volumeIdentity(await engineRead(signal, (abortSignal) => this.docker.getVolume(name).inspect({ abortSignal })), name));
      records.push({
        key: sha(`orbis.backup-volume.v1\n${name}`),
        sourceName: name,
        mounts: mounts.sort((a, b) => compare(canonical(a), canonical(b))),
      });
    }
    const plan = freeze({ version: 1 as const, volumes: records });
    this.issued.set(plan, { containers, volumes: identities });
    return plan;
  }

  async verifyStopped(plan: BackupVolumePlan, signal: AbortSignal) {
    const issued = this.issued.get(plan);
    if (!issued) throw failed();
    const all = await this.containers(signal);
    for (const [id, identity] of issued.containers) {
      const raw = all.find((item) => item.Id === id);
      if (!raw || raw.State.Running || raw.State.Paused || raw.State.Restarting || containerIdentity(raw) !== identity) throw failed();
    }
    for (const raw of all)
      if (raw.Mounts.some((mount) => mount.Type === 'volume' && mount.Name && issued.volumes.has(mount.Name)) && !issued.containers.has(raw.Id))
        throw failed();
    for (const [name, identity] of issued.volumes) {
      signal.throwIfAborted();
      if (volumeIdentity(await engineRead(signal, (abortSignal) => this.docker.getVolume(name).inspect({ abortSignal })), name) !== identity)
        throw failed();
    }
  }

  async capture(options: {
    plan: BackupVolumePlan;
    inventories: readonly BackupVolumeInventory[];
    content: string;
    maximumBytes: number;
    signal: AbortSignal;
    progress: (bytes: number) => void;
    baseline?: { entries: number; pathBytes: number };
  }): Promise<BackupVolumeArchive[]> {
    const { plan, content, maximumBytes, signal } = options;
    const baseline = options.baseline ?? { entries: 0, pathBytes: 0 };
    if (
      !Number.isSafeInteger(baseline.entries) ||
      baseline.entries < 0 ||
      baseline.entries > fullBackupLimits.entries ||
      !Number.isSafeInteger(baseline.pathBytes) ||
      baseline.pathBytes < 0 ||
      baseline.pathBytes > fullBackupLimits.pathBytes
    )
      throw failed();
    if (process.platform !== 'linux' || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) throw failed();
    await this.verifyStopped(plan, signal);
    if (
      !Array.isArray(options.inventories) ||
      options.inventories.length !== plan.volumes.length ||
      options.inventories.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          Object.keys(item).sort().join(',') !== 'containerId,entries,key,sourceName' ||
          !Array.isArray(item.entries) ||
          !item.entries.length,
      ) ||
      new Set(options.inventories.map((item) => item.key)).size !== options.inventories.length
    )
      throw failed();
    const inventories = new Map(options.inventories.map((item) => [item.key, freeze(structuredClone(item))]));
    let expectedEntries = 0;
    for (const volume of plan.volumes) {
      const inventory = inventories.get(volume.key);
      if (!inventory || inventory.sourceName !== volume.sourceName || !volume.mounts.some((mount) => mount.containerId === inventory.containerId))
        throw failed();
      expectedEntries += inventory.entries.length;
      if (expectedEntries + baseline.entries + (plan.volumes.length ? plan.volumes.length * 2 + 1 : 0) > fullBackupLimits.entries) throw failed();
    }
    await privateBackupDirectory(content);
    if (!plan.volumes.length) return [];
    const parent = await fs.open(content, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let directory: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const parentSeal = await parent.stat();
      if (!parentSeal.isDirectory() || parentSeal.mode & 0o077 || (process.getuid && parentSeal.uid !== process.getuid())) throw failed();
      const anchoredParent = `/proc/self/fd/${parent.fd}`;
      await fs.mkdir(`${anchoredParent}/volumes`, { mode: 0o700 });
      directory = await fs.open(`${anchoredParent}/volumes`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const seal = await directory.stat();
      if (!seal.isDirectory() || seal.mode & 0o077 || (process.getuid && seal.uid !== process.getuid())) throw failed();
      const result: BackupVolumeArchive[] = [];
      let completed = 0;
      let metadataBytes = 0;
      let totalEntries = 0;
      let totalPaths = baseline.pathBytes + Buffer.byteLength('volumes');
      for (const volume of plan.volumes)
        totalPaths += Buffer.byteLength(`volumes/${volume.key}.tar`) + Buffer.byteLength(`volumes/${volume.key}.inventory.json`);
      for (const volume of plan.volumes) {
        await this.verifyStopped(plan, signal);
        const mount = volume.mounts[0];
        if (!mount) throw failed();
        const root = path.posix.basename(mount.target);
        const file = `/proc/self/fd/${directory.fd}/${volume.key}.tar`;
        const output = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const digest = createHash('sha256');
        let bytes = 0;
        let stream: Readable | undefined;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => stream?.destroy(new Error('App volume data stopped responding.')), 30_000);
          idle.unref();
        };
        const stop = () => stream?.destroy(new Error('Volume capture cancelled.'));
        signal.addEventListener('abort', stop, { once: true });
        try {
          signal.throwIfAborted();
          const download = await engineRead(signal, (abortSignal) =>
            this.docker.getContainer(mount.containerId).getArchive({ path: mount.target, abortSignal }),
          );
          if (!(download instanceof Readable)) throw failed();
          stream = download;
          signal.throwIfAborted();
          armIdle();
          for await (const raw of stream) {
            signal.throwIfAborted();
            armIdle();
            const chunk = Buffer.from(raw);
            completed += chunk.length;
            bytes += chunk.length;
            if (completed + metadataBytes > maximumBytes) throw failed();
            await output.writeFile(chunk);
            digest.update(chunk);
            options.progress(completed + metadataBytes);
          }
          if (bytes < 1024) throw failed();
          await output.sync();
          const expected = await output.stat();
          const inventory = inventories.get(volume.key);
          if (!inventory) throw failed();
          const inspected = await inspectDockerVolumeArchive(`/proc/self/fd/${output.fd}`, root, bytes, signal, inventory.entries);
          totalEntries += inspected.entries;
          totalPaths += inspected.pathBytes;
          for (const entry of inventory.entries)
            totalPaths += Buffer.byteLength(entry.name) + (entry.kind === 'symlink' ? Buffer.byteLength(entry.target) : 0);
          if (totalEntries > fullBackupLimits.entries || totalPaths > fullBackupLimits.pathBytes) throw failed();
          const after = await output.stat();
          const named = await fs.lstat(file);
          const current = await fs.lstat(path.join(content, 'volumes'));
          const currentParent = await fs.lstat(content);
          if (
            expected.ino !== after.ino ||
            expected.dev !== after.dev ||
            expected.size !== bytes ||
            after.size !== bytes ||
            expected.ctimeMs !== after.ctimeMs ||
            expected.mtimeMs !== after.mtimeMs ||
            named.ino !== after.ino ||
            named.dev !== after.dev ||
            current.ino !== seal.ino ||
            current.dev !== seal.dev ||
            current.isSymbolicLink() ||
            currentParent.ino !== parentSeal.ino ||
            currentParent.dev !== parentSeal.dev ||
            currentParent.isSymbolicLink()
          )
            throw failed();
          const metadata = Buffer.from(
            canonical({ version: 1, ...inventory, entries: [...inventory.entries].sort((a, b) => compare(a.name, b.name)) }),
          );
          metadataBytes += metadata.length;
          if (metadataBytes > fullBackupLimits.manifestBytes || completed + metadataBytes > maximumBytes) throw failed();
          const metadataName = `${volume.key}.inventory.json`;
          const metadataOutput = await fs.open(
            `/proc/self/fd/${directory.fd}/${metadataName}`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await metadataOutput.writeFile(metadata);
            await metadataOutput.sync();
          } finally {
            await metadataOutput.close();
          }
          options.progress(completed + metadataBytes);
          result.push({
            ...volume,
            archive: { name: `volumes/${volume.key}.tar`, root, bytes, sha256: digest.digest('hex') },
            inventory: { name: `volumes/${metadataName}`, bytes: metadata.length, sha256: createHash('sha256').update(metadata).digest('hex') },
            excludedRuntimeSockets: inspected.excludedRuntimeSockets,
          });
        } finally {
          if (idle) clearTimeout(idle);
          signal.removeEventListener('abort', stop);
          stream?.destroy();
          await output.close();
        }
      }
      await this.verifyStopped(plan, signal);
      return result;
    } finally {
      await directory?.close();
      await parent.close();
    }
  }
}
