import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { readTarArchive } from '@/core/archive/tar-metadata';
import { canonicalPublicationJson as canonical } from '../host-updates/host-controller-publication';
import { inspectDockerVolumeArchive, type BackupVolumeEntry } from './backup-docker-volumes';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { parseFullBackupManifest } from './backup-import';
import { fullBackupLimits } from './backup-limits';
import { backupVolumeContentBudget, verifyBackupVolumeContents } from './backup-volume-contents';
import { readPreparedVolumeRestoreRecord } from './backup-volume-restore-record';

const fail = () => new BackupRequirementError('App data restoration needs recovery. Your original app storage has been preserved.');
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sorted = <T extends { name: string }>(values: readonly T[]) => [...values].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const same = (a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'ctimeMs', 'mtimeMs'] as const).every((key) => a[key] === b[key]);
const empty = (value: unknown) => value == null || (typeof value === 'object' && Object.keys(value).length === 0);
function mounts(raw: Dockerode.ContainerInspectInfo['HostConfig']['Mounts']) {
  return raw?.map((mount) => ({
    ...mount,
    ReadOnly: mount.ReadOnly ?? false,
    VolumeOptions: mount.VolumeOptions
      ? {
          ...mount.VolumeOptions,
          Labels: mount.VolumeOptions.Labels ?? {},
          DriverConfig: mount.VolumeOptions.DriverConfig
            ? { ...mount.VolumeOptions.DriverConfig, Options: mount.VolumeOptions.DriverConfig.Options ?? {} }
            : mount.VolumeOptions.DriverConfig,
        }
      : mount.VolumeOptions,
  }));
}

export type VolumeRestoreIdentity = { restoreId: string; nonce: string; imageId: string; manifestSha256: string };
export type VolumeRestoreObservation = {
  generation: string;
  targetName: string;
  entries: readonly BackupVolumeEntry[];
  availableBytes: number;
  availableInodes: number;
};
export type VolumeRestoreTarget = {
  key: string;
  sourceName: string;
  targetName: string;
  archiveSha256: string;
  inventorySha256: string;
  uploaderName: string;
  uploaderId: string | null;
  state: 'intent' | 'volume-created' | 'holder-intent' | 'holder-created' | 'uploading' | 'uploaded' | 'verified' | 'removing-holder' | 'ready';
  volumeIdentity?: string;
  containerIdentity?: string;
  verificationSha256?: string;
};
export type VolumeRestoreAttempt = {
  version: 1;
  schema: 'orbis.backup-volume-restore.v1';
  identity: VolumeRestoreIdentity;
  generation: string;
  createdAt: number;
  phase: 'preparing' | 'ambiguous' | 'verified';
  targets: VolumeRestoreTarget[];
};

async function bounded<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>, timeout = 30_000): Promise<T> {
  signal.throwIfAborted();
  const timer = new AbortController();
  const combined = AbortSignal.any([signal, timer.signal]);
  const handle = setTimeout(() => timer.abort(fail()), timeout);
  handle.unref();
  let abort: () => void = () => undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) {
        abort();
        return;
      }
      void operation(combined).then((value) => {
        if (combined.aborted && value instanceof Readable) value.destroy();
        resolve(value);
      }, reject);
    });
  } finally {
    clearTimeout(handle);
    combined.removeEventListener('abort', abort);
  }
}

function volumeIdentity(raw: Dockerode.VolumeInspectInfo & { CreatedAt?: unknown }, target: VolumeRestoreTarget, labels: Record<string, string>) {
  if (
    raw.Name !== target.targetName ||
    raw.Driver !== 'local' ||
    raw.Scope !== 'local' ||
    typeof raw.CreatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.CreatedAt)) ||
    typeof raw.Mountpoint !== 'string' ||
    !raw.Mountpoint.startsWith('/') ||
    (raw.Options && Object.keys(raw.Options).length) ||
    canonical(raw.Labels) !== canonical(labels)
  )
    throw fail();
  return sha(
    canonical({
      name: raw.Name,
      createdAt: raw.CreatedAt,
      driver: raw.Driver,
      scope: raw.Scope,
      options: raw.Options ?? {},
      labels: raw.Labels,
      mountpoint: raw.Mountpoint,
    }),
  );
}

function containerIdentity(raw: Dockerode.ContainerInspectInfo) {
  if (raw.State.Running || raw.State.Paused || raw.State.Restarting || raw.State.Pid || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(raw.State.StartedAt))
    throw fail();
  return sha(
    canonical({
      id: raw.Id,
      name: raw.Name,
      image: raw.Image,
      config: raw.Config,
      host: { ...raw.HostConfig, OomKillDisable: raw.HostConfig.OomKillDisable === true },
      mounts: raw.Mounts,
      networks: Object.keys(raw.NetworkSettings.Networks).sort(),
      startedAt: raw.State.StartedAt,
    }),
  );
}

async function archiveAttributes(file: string, root: string, bytes: number, signal: AbortSignal) {
  type Entry = { name: string; kind: string; uid: number; gid: number; mode: number; mtime: number; target?: string };
  const entries = new Map<string, Entry>();
  await readTarArchive(file, false, signal, {
    strict: true,
    attributes: true,
    collectEntries: false,
    maxEntries: fullBackupLimits.entries,
    maxExpandedBytes: bytes,
    onEntry: async (entry) => {
      if (!entry.attributes) throw fail();
      const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
      if (name !== root && !name.startsWith(`${root}/`)) throw fail();
      entries.set(name, { name, kind: entry.type, ...entry.attributes, ...(entry.linkTarget ? { target: entry.linkTarget } : {}) });
    },
  });
  const resolved = (entry: Entry, seen = new Set<string>()): Entry => {
    if (entry.kind !== 'h') return entry;
    if (!entry.target || seen.has(entry.name)) throw fail();
    seen.add(entry.name);
    const target = entries.get(entry.target.replace(/^\.\//, '').replace(/\/$/, ''));
    if (!target) throw fail();
    return resolved(target, seen);
  };
  return sorted(
    [...entries.values()].map((entry) => {
      const actual = resolved(entry);
      return {
        name: entry.name,
        kind: actual.kind,
        uid: actual.uid,
        gid: actual.gid,
        mode: actual.mode,
        mtime: actual.mtime,
        ...(entry.kind === 'l' ? { target: entry.target } : {}),
      };
    }),
  );
}

/** Prepare fresh storage only. Publishing app bindings belongs to the protected restore transaction. */
export class BackupDockerVolumeRestore {
  constructor(
    private readonly docker: Dockerode,
    private readonly options: {
      directory: string;
      identity: VolumeRestoreIdentity;
      guard: (signal: AbortSignal) => Promise<void>;
      observe: (
        request: { identity: VolumeRestoreIdentity; generation: string; targetName: string; key: string; phase: 'empty' | 'restored' },
        signal: AbortSignal,
      ) => Promise<VolumeRestoreObservation>;
    },
  ) {}

  async prepare(source: { content: string; signal: AbortSignal; progress?: (bytes: number) => void }): Promise<Readonly<VolumeRestoreAttempt>> {
    if (process.platform !== 'linux') throw fail();
    const identity = structuredClone(this.options.identity);
    if (
      Object.keys(identity).sort().join(',') !== 'imageId,manifestSha256,nonce,restoreId' ||
      !uuid.test(identity.restoreId) ||
      !uuid.test(identity.nonce) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.imageId) ||
      !hash.test(identity.manifestSha256)
    )
      throw fail();
    const { signal } = source;
    const directory = this.options.directory;
    if (
      !path.isAbsolute(directory) ||
      path.resolve(directory) !== directory ||
      !path.isAbsolute(source.content) ||
      path.resolve(source.content) !== source.content ||
      directory === source.content ||
      directory.startsWith(`${source.content}/`) ||
      source.content.startsWith(`${directory}/`) ||
      typeof this.options.guard !== 'function' ||
      typeof this.options.observe !== 'function'
    )
      throw fail();
    const content = await fs.lstat(source.content);
    if (
      !content.isDirectory() ||
      content.isSymbolicLink() ||
      content.mode & 0o077 ||
      content.uid !== process.geteuid?.() ||
      (await fs.realpath(source.content)) !== source.content
    )
      throw fail();
    await privateBackupDirectory(directory);
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let database: DatabaseSync | undefined;
    let attempt: VolumeRestoreAttempt | undefined;
    const anchor = `/proc/self/fd/${parent.fd}`;
    const seal = await parent.stat();
    const guard = async () => {
      signal.throwIfAborted();
      const current = await fs.lstat(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        (['dev', 'ino', 'mode', 'uid', 'gid'] as const).some((key) => current[key] !== seal[key])
      )
        throw fail();
      const held: unknown = await this.options.guard(signal);
      if (held === false) throw fail();
      signal.throwIfAborted();
    };
    const write = async (name: string, value: unknown) => {
      const temporary = `${anchor}/.${randomUUID()}.tmp`;
      const bytes = Buffer.from(canonical(value));
      if (bytes.length > 4 * 1024 * 1024) throw fail();
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, `${anchor}/${name}`);
      await parent.sync();
      return sha(bytes);
    };
    const save = async () => {
      if (!attempt) throw fail();
      const digest = await write(`${attempt.generation}.json`, attempt);
      await write('current.json', { version: 1, identity, generation: attempt.generation, attemptSha256: digest });
    };
    const read = async (file: string, maximum: number) => {
      const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await input.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.mode & 0o077 ||
          before.uid !== process.geteuid?.() ||
          before.size < 1 ||
          before.size > maximum
        )
          throw fail();
        const bytes = await input.readFile();
        if (bytes.length !== before.size || !same(before, await input.stat())) throw fail();
        return bytes;
      } finally {
        await input.close();
      }
    };
    const blob = async (input: Readable, maximum: number, expected?: string) => {
      const free = await fs.statfs(anchor);
      if (!Number.isSafeInteger(maximum) || maximum < 1 || free.bavail * free.bsize < maximum + fullBackupLimits.reserveBytes) throw fail();
      const name = `${anchor}/.${randomUUID()}.blob`;
      let output: FileHandle | undefined = await fs.open(name, 'wx+', 0o600);
      let bytes = 0;
      const digest = createHash('sha256');
      const own = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => input.destroy(fail()), 30_000);
        idle.unref();
      };
      const stop = () => input.destroy(fail());
      own.addEventListener('abort', stop, { once: true });
      try {
        await fs.unlink(name);
        own.throwIfAborted();
        arm();
        for await (const block of input) {
          own.throwIfAborted();
          arm();
          bytes += block.byteLength;
          if (bytes > maximum) throw fail();
          await output.writeFile(block);
          digest.update(block);
        }
        if ((expected && digest.digest('hex') !== expected) || !bytes) throw fail();
        await output.sync();
        const readonly = await fs.open(`/proc/self/fd/${output.fd}`, constants.O_RDONLY);
        await output.close();
        output = undefined;
        return { handle: readonly, bytes, path: `/proc/self/fd/${readonly.fd}` };
      } finally {
        if (idle) clearTimeout(idle);
        own.removeEventListener('abort', stop);
        if (!input.readableEnded) input.destroy();
        await output?.close();
      }
    };
    const io = async <T>(operation: (signal: AbortSignal) => Promise<T>, timeout?: number) => {
      await guard();
      const value = await bounded(signal, operation, timeout);
      await guard();
      return value;
    };
    try {
      if ((seal.mode & 0o7777) !== 0o700 || seal.uid !== process.geteuid?.()) throw fail();
      await guard();
      try {
        const handle = await fs.open(`${anchor}/lease.sqlite`, 'wx', 0o600);
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const lock = await fs.lstat(`${anchor}/lease.sqlite`);
      if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || lock.mode & 0o077 || lock.uid !== process.geteuid?.() || lock.size > 65536)
        throw fail();
      database = new DatabaseSync(`${anchor}/lease.sqlite`);
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw fail();
      database.exec('CREATE TABLE IF NOT EXISTS volume_restore_lock (id INTEGER PRIMARY KEY CHECK (id=1));');
      try {
        const previous = await read(`${anchor}/origin.json`, 4096);
        if (!previous.equals(Buffer.from(canonical({ version: 1, identity })))) throw fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await write('origin.json', { version: 1, identity });
      }
      const manifestFile = path.join(source.content, 'manifest.json');
      if ((await fs.realpath(source.content)) !== source.content) throw fail();
      const manifestBytes = await read(manifestFile, fullBackupLimits.manifestBytes);
      if (manifestBytes.length > fullBackupLimits.manifestBytes || sha(manifestBytes) !== identity.manifestSha256) throw fail();
      const manifest = parseFullBackupManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)));
      if (manifest.version !== 3 || !manifest.volumes.length) throw fail();
      await verifyBackupVolumeContents(source.content, manifest.volumes, signal, backupVolumeContentBudget(manifest));
      const image = await io(() => this.docker.getImage(identity.imageId).inspect());
      if (image.Id !== identity.imageId || image.Os !== 'linux' || (image.Config.Volumes && Object.keys(image.Config.Volumes).length)) throw fail();
      const engine = await io(() => this.docker.info());
      if (typeof engine.ID !== 'string' || !engine.ID) throw fail();
      const generation = randomUUID();
      attempt = {
        version: 1,
        schema: 'orbis.backup-volume-restore.v1',
        identity,
        generation,
        createdAt: Date.now(),
        phase: 'preparing',
        targets: manifest.volumes.map((volume) => ({
          key: volume.key,
          sourceName: volume.sourceName,
          targetName: `orbis-restore-${generation}-${volume.key}`,
          archiveSha256: volume.archive.sha256,
          inventorySha256: volume.inventory.sha256,
          uploaderName: `orbis-volume-restore-${randomUUID()}`,
          uploaderId: null,
          state: 'intent',
        })),
      };
      if (attempt.targets.some((target) => manifest.volumes.some((original) => original.sourceName === target.targetName))) throw fail();
      await save();
      for (const [index, volume] of manifest.volumes.entries()) {
        const target = attempt.targets[index];
        if (!target) throw fail();
        const labels = {
          'org.orbis.role': 'volume-restore',
          'org.orbis.restore': identity.restoreId,
          'org.orbis.generation': generation,
          'org.orbis.volume-key': volume.key,
        };
        const inspectVolume = async () => {
          const raw = await io((abortSignal) => this.docker.getVolume(target.targetName).inspect({ abortSignal }));
          const observed = volumeIdentity(raw, target, labels);
          if (target.volumeIdentity && target.volumeIdentity !== observed) throw fail();
          return { raw, observed };
        };
        const exclusive = async (allowUploader = true) => {
          const { raw } = await inspectVolume();
          if ((await io(() => this.docker.info())).ID !== engine.ID) throw fail();
          const all = await io(() => this.docker.listContainers({ all: true }));
          if (all.length > 4096) throw fail();
          for (const item of all) {
            const container = await io((abortSignal) => this.docker.getContainer(item.Id).inspect({ abortSignal }));
            for (const mount of container.Mounts) {
              if (mount.Type === 'volume' && mount.Name === target.targetName && (!allowUploader || container.Id !== target.uploaderId)) throw fail();
              if (
                mount.Type === 'bind' &&
                (mount.Source === raw.Mountpoint || mount.Source.startsWith(`${raw.Mountpoint}/`) || raw.Mountpoint.startsWith(`${mount.Source}/`))
              )
                throw fail();
            }
          }
        };
        const observe = async (phase: 'empty' | 'restored', expected: readonly BackupVolumeEntry[]) => {
          const result = await io(
            (own) => this.options.observe({ identity, generation, targetName: target.targetName, key: target.key, phase }, own),
            330_000,
          );
          if (
            result.generation !== generation ||
            result.targetName !== target.targetName ||
            canonical(sorted(result.entries)) !== canonical(sorted(expected)) ||
            !Number.isSafeInteger(result.availableBytes) ||
            !Number.isSafeInteger(result.availableInodes) ||
            result.availableBytes < 0 ||
            result.availableInodes < 0
          )
            throw fail();
          return result;
        };
        try {
          await io((abortSignal) => this.docker.getVolume(target.targetName).inspect({ abortSignal }));
          throw fail();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
        await io((abortSignal) =>
          this.docker.createVolume({ Name: target.targetName, Driver: 'local', DriverOpts: {}, Labels: labels, abortSignal }),
        );
        target.volumeIdentity = (await inspectVolume()).observed;
        target.state = 'volume-created';
        await save();
        const space = await observe('empty', [{ name: '.', kind: 'directory' }]);
        const inventoryFile = await read(path.join(source.content, volume.inventory.name), fullBackupLimits.manifestBytes);
        if (inventoryFile.length !== volume.inventory.bytes || sha(inventoryFile) !== volume.inventory.sha256) throw fail();
        const expected = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventoryFile)).entries as BackupVolumeEntry[]).filter(
          (entry) => entry.kind !== 'socket',
        );
        const logicalBytes = expected.reduce((total, entry) => total + (entry.kind === 'file' ? entry.bytes : 0) + 4096, volume.archive.bytes);
        if (
          !Number.isSafeInteger(logicalBytes) ||
          space.availableBytes < logicalBytes + fullBackupLimits.reserveBytes ||
          space.availableInodes < expected.length + fullBackupLimits.reserveInodes
        )
          throw fail();
        const mountTarget = `/orbis-restore/${volume.archive.root}`;
        const specification: Dockerode.ContainerCreateOptions = {
          name: target.uploaderName,
          Image: identity.imageId,
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['-e', 'process.exit(0)'],
          User: '0:0',
          WorkingDir: '/',
          Env: [],
          Volumes: {},
          Healthcheck: { Test: ['NONE'] },
          Labels: { ...labels, 'com.docker.compose.service': 'orbis-volume-restore' },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: false,
            CapDrop: ['ALL'],
            CapAdd: [],
            SecurityOpt: ['no-new-privileges'],
            Memory: 128 * 1024 * 1024,
            PidsLimit: 32,
            RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
            AutoRemove: false,
            Privileged: false,
            PublishAllPorts: false,
            Mounts: [
              {
                Type: 'volume',
                Source: target.targetName,
                Target: mountTarget,
                ReadOnly: false,
                VolumeOptions: { NoCopy: true, Labels: {}, DriverConfig: { Name: 'local', Options: {} } },
              },
            ],
          },
        };
        target.state = 'holder-intent';
        await save();
        const uploader = await io((abortSignal) => this.docker.createContainer({ ...specification, abortSignal }));
        if (!hash.test(uploader.id)) throw fail();
        target.uploaderId = uploader.id;
        await save();
        const owned = async () => {
          const raw = await io((abortSignal) => uploader.inspect({ abortSignal }));
          if (
            raw.Id !== target.uploaderId ||
            raw.Name !== `/${target.uploaderName}` ||
            raw.Image !== identity.imageId ||
            raw.Mounts.length !== 1 ||
            raw.Mounts[0]?.Name !== target.targetName ||
            raw.Mounts[0]?.Destination !== mountTarget ||
            raw.Mounts[0]?.RW !== true ||
            canonical(raw.Config.Entrypoint) !== canonical(specification.Entrypoint) ||
            canonical(raw.Config.Cmd) !== canonical(specification.Cmd) ||
            raw.HostConfig.Privileged ||
            raw.HostConfig.NetworkMode !== 'none' ||
            raw.HostConfig.ReadonlyRootfs ||
            canonical(mounts(raw.HostConfig.Mounts)) !== canonical(mounts(specification.HostConfig?.Mounts ?? [])) ||
            (raw.Config.Volumes && Object.keys(raw.Config.Volumes).length) ||
            ['Binds', 'VolumesFrom', 'Devices', 'DeviceRequests', 'Links', 'Tmpfs'].some((key) =>
              Boolean(
                (raw.HostConfig as unknown as Record<string, unknown>)[key] &&
                  Object.keys((raw.HostConfig as unknown as Record<string, object>)[key] ?? {}).length,
              ),
            )
          )
            throw fail();
          if (
            raw.Config.User !== specification.User ||
            raw.Config.WorkingDir !== '/' ||
            canonical(raw.Config.Healthcheck) !== canonical(specification.Healthcheck) ||
            canonical(raw.Config.Labels) !== canonical({ ...(image.Config.Labels ?? {}), ...specification.Labels }) ||
            raw.Config.OpenStdin ||
            raw.Config.Tty ||
            raw.HostConfig.Memory !== 128 * 1024 * 1024 ||
            raw.HostConfig.PidsLimit !== 32 ||
            canonical(raw.HostConfig.CapDrop) !== canonical(['ALL']) ||
            !empty(raw.HostConfig.CapAdd) ||
            canonical(raw.HostConfig.SecurityOpt) !== canonical(['no-new-privileges']) ||
            raw.HostConfig.RestartPolicy?.Name !== 'no' ||
            raw.HostConfig.RestartPolicy.MaximumRetryCount !== 0 ||
            raw.HostConfig.AutoRemove ||
            raw.HostConfig.PublishAllPorts ||
            !empty(raw.HostConfig.PortBindings) ||
            Object.keys(raw.NetworkSettings.Networks).some((name) => name !== 'none') ||
            ['ExtraHosts', 'GroupAdd', 'Sysctls'].some((key) => !empty((raw.HostConfig as unknown as Record<string, unknown>)[key])) ||
            ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode'].some(
              (key) => ![undefined, null, '', 'private'].includes((raw.HostConfig as unknown as Record<string, unknown>)[key] as string),
            )
          )
            throw fail();
          const observed = containerIdentity(raw);
          if (target.containerIdentity && observed !== target.containerIdentity) throw fail();
          return observed;
        };
        target.containerIdentity = await owned();
        target.state = 'holder-created';
        await save();
        await exclusive();
        const sourceFile = await fs.open(path.join(source.content, volume.archive.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        let upload: Awaited<ReturnType<typeof blob>> | undefined;
        let readback: Awaited<ReturnType<typeof blob>> | undefined;
        try {
          const before = await sourceFile.stat();
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.mode & 0o077 ||
            before.uid !== process.geteuid?.() ||
            before.size !== volume.archive.bytes
          )
            throw fail();
          const sourceStream = sourceFile.createReadStream({ autoClose: false, signal });
          try {
            upload = await blob(sourceStream, volume.archive.bytes, volume.archive.sha256);
          } finally {
            if (!sourceStream.readableEnded) sourceStream.destroy();
          }
          if (!same(before, await sourceFile.stat())) throw fail();
          await inspectDockerVolumeArchive(upload.path, volume.archive.root, upload.bytes, signal, expected);
          const originalAttributes = await archiveAttributes(upload.path, volume.archive.root, upload.bytes, signal);
          target.state = 'uploading';
          await save();
          let bytes = 0;
          const input = upload.handle.createReadStream({ autoClose: false, signal });
          const stream = Readable.from(
            (async function* () {
              for await (const chunk of input) {
                bytes += chunk.length;
                source.progress?.(bytes);
                yield chunk;
              }
            })(),
          );
          try {
            await io(
              (abortSignal) => uploader.putArchive(stream, { path: '/orbis-restore', noOverwriteDirNonDir: true, copyUIDGID: false, abortSignal }),
              30 * 60_000,
            );
          } finally {
            stream.destroy();
            input.destroy();
          }
          if (bytes !== volume.archive.bytes) throw fail();
          await owned();
          await exclusive();
          target.state = 'uploaded';
          await save();
          const actual = await observe('restored', expected);
          const readbackStream = await io((abortSignal) => uploader.getArchive({ path: mountTarget, abortSignal }));
          if (!(readbackStream instanceof Readable)) throw fail();
          const maximum = volume.archive.bytes + 64 * 1024 * 1024 + expected.length * 8192;
          try {
            readback = await blob(readbackStream, maximum);
          } finally {
            readbackStream.destroy();
          }
          await inspectDockerVolumeArchive(readback.path, volume.archive.root, readback.bytes, signal, expected);
          const restoredAttributes = await archiveAttributes(readback.path, volume.archive.root, readback.bytes, signal);
          if (
            originalAttributes.length !== restoredAttributes.length ||
            originalAttributes.some((entry, item) => {
              const restored = restoredAttributes[item];
              return (
                !restored ||
                canonical({ ...entry, mtime: 0 }) !== canonical({ ...restored, mtime: 0 }) ||
                Math.abs(entry.mtime - restored.mtime) > Math.max(0.000001, Math.abs(entry.mtime) * Number.EPSILON * 2)
              );
            })
          )
            throw fail();
          await owned();
          await exclusive();
          target.verificationSha256 = sha(canonical({ entries: sorted(actual.entries), attributes: restoredAttributes }));
          target.state = 'verified';
          await save();
        } finally {
          await sourceFile.close();
          await upload?.handle.close();
          await readback?.handle.close();
        }
        await owned();
        target.state = 'removing-holder';
        await save();
        await io((abortSignal) => uploader.remove({ v: false, force: false, abortSignal }));
        try {
          await io((abortSignal) => uploader.inspect({ abortSignal }));
          throw fail();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
        await exclusive(false);
        target.state = 'ready';
        await save();
      }
      await guard();
      attempt.phase = 'verified';
      await save();
      const prepared = await readPreparedVolumeRestoreRecord({ directory, identity, parsedFullBackupManifest: manifest });
      await guard();
      if (prepared.generation !== attempt.generation) throw fail();
      return prepared;
    } catch (error) {
      // A disconnected PUT may still be extracting. Never delete or retry its target.
      if (attempt) {
        attempt.phase = 'ambiguous';
        await save();
      }
      signal.throwIfAborted();
      throw error instanceof BackupRequirementError ? error : new BackupRequirementError(fail().message, { cause: error });
    } finally {
      database?.close();
      await parent.close();
    }
  }
}
