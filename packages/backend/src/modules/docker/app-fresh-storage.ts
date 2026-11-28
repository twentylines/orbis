import { appUpdateStorage } from './app-image-pins';
import { resolvePackageLink } from '../app-stores/app-package-links';
import {
  readAppContainerInventory as containers,
  appContainerMounts as mounts,
  requireAppStorageOwners as noForeignWriters,
} from './app-storage-inventory';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { AppStorageWitness, type AppStorageObservation } from '../host-updates/app-storage-observation';
import { migrationStorageHash } from '../backups/app-migration-journal';
import { AppUpdateStage, type FreshInstallState } from './app-update-stage';
import { MigrationEngineError, migrationEngineRequest, migrationRecord as record, migrationStopped } from './app-migration-engine';

const fail = () => new Error('Fresh app storage could not be verified. Existing data and the saved install were kept.');
const id = /^[a-f0-9]{64}$/;
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  path.posix.normalize(value) === value &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\0\r\n\\]/.test(value);
const neverStarted = (state: unknown) =>
  migrationStopped(state) && record(state) && typeof state.StartedAt === 'string' && /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(state.StartedAt);

async function prepareWritableBind(root: string, relative: string, createHostPath: boolean) {
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let handle = await fs.open(root, directoryFlags);
  let name = root;
  const parts = relative.split('/').filter(Boolean);
  try {
    for (const [index, part] of parts.entries()) {
      name = path.join(name, part);
      // Anchor child operations to the open parent on the Linux host.
      const child = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}/${part}` : name;
      const last = index === parts.length - 1;
      let before = await fs.lstat(child).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && createHostPath) return null;
        throw error;
      });
      if (!before) {
        await fs.mkdir(child, { mode: 0o755 });
        await handle.sync();
        before = await fs.lstat(child);
      }
      if (!before.isDirectory() && !(last && before.isFile())) throw fail();
      const next = await fs.open(child, last ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : directoryFlags);
      const parent = handle;
      handle = next;
      await parent.close();
      const actual = await handle.stat();
      if (before.dev !== actual.dev || before.ino !== actual.ino) throw fail();
    }
    await handle.chmod(0o777);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function empty(directory: string) {
  const entries = await fs.opendir(directory);
  try {
    if (await entries.read()) throw fail();
  } finally {
    await entries.close();
  }
}
export async function freshInstallCandidate(directories: readonly string[]) {
  for (const directory of directories) {
    if (!absolute(directory)) throw fail();
    const before = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!before) continue;
    if (!before.isDirectory() || before.isSymbolicLink()) throw fail();
    const entries = await fs.opendir(directory);
    let present: boolean;
    try {
      present = (await entries.read()) !== null;
    } finally {
      await entries.close();
    }
    const after = await fs.lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs) throw fail();
    if (present) return false;
  }
  return true;
}
async function request(docker: Dockerode, endpoint: string, method = 'GET', options: Record<string, unknown> = {}) {
  return migrationEngineRequest(docker, endpoint, method, options, AbortSignal.timeout(30_000));
}
async function volume(docker: Dockerode, name: string) {
  if (!volumeName.test(name)) throw fail();
  try {
    const value = await request(docker, `/volumes/${name}`);
    if (
      !record(value) ||
      value.Name !== name ||
      value.Driver !== 'local' ||
      !absolute(value.Mountpoint) ||
      (value.Options !== null && value.Options !== undefined && (!record(value.Options) || Object.keys(value.Options).length)) ||
      (value.Labels !== null && value.Labels !== undefined && !record(value.Labels)) ||
      value.Scope !== 'local'
    )
      throw fail();
    return {
      name,
      driver: value.Driver,
      mountpoint: value.Mountpoint,
      options: value.Options ?? null,
      labels: value.Labels ?? {},
      createdAt: value.CreatedAt ?? null,
    };
  } catch (error) {
    if (error instanceof MigrationEngineError && error.statusCode === 404) return null;
    throw error;
  }
}
async function volumes(docker: Dockerode) {
  const value = await request(docker, '/volumes?');
  if (!record(value) || !Array.isArray(value.Volumes) || value.Volumes.length > 4096) throw fail();
  const names = value.Volumes.map((item) => {
    if (!record(item) || typeof item.Name !== 'string' || !volumeName.test(item.Name)) throw fail();
    return item.Name;
  }).sort();
  if (new Set(names).size !== names.length) throw fail();
  return names;
}
/** A live Host/directory/socket witness plus positive pre-allocation emptiness. No supplied metadata can construct it. */
export class FreshAppStorage {
  private constructor(
    private readonly witness: AppStorageWitness,
    readonly initialVolumes: string[],
    readonly storageSha256: string,
    private readonly appUrn: AppUrn,
    private readonly localDirectory: string,
  ) {}
  static async open(input: { appUrn: AppUrn; localDirectory: string; socketPath: string; docker: Dockerode }) {
    const witness = await AppStorageWitness.open(input);
    try {
      return await witness.use(async (docker, observed) => {
        await empty(input.localDirectory);
        if (observed.containerPath !== input.localDirectory) throw fail();
        await noForeignWriters(docker, observed, new Set(), new Set());
        const initial = await volumes(docker);
        await empty(input.localDirectory);
        return new FreshAppStorage(witness, initial, migrationStorageHash(observed), input.appUrn, input.localDirectory);
      });
    } catch (error) {
      await witness.close();
      throw error;
    }
  }
  async capturePreparation() {
    return this.use(async (docker, observed) => {
      await empty(this.localDirectory);
      await noForeignWriters(docker, observed, new Set(), new Set());
      return { storageSha256: this.storageSha256, initialVolumes: [...this.initialVolumes] };
    });
  }
  static async reopenPreparation(
    input: { appUrn: AppUrn; localDirectory: string; socketPath: string; docker: Dockerode },
    stage: AppUpdateStage,
    withContext = false,
  ) {
    const state = await stage.read();
    const preparation = state.freshPreparation;
    if (
      !preparation ||
      Boolean(state.context) !== withContext ||
      (withContext && state.context?.purpose !== 'fresh-install') ||
      state.appUrn !== input.appUrn ||
      state.phase !== 'target-ready' ||
      !state.prepared ||
      state.freshInstall
    )
      throw fail();
    await stage.readTarget();
    const witness = await AppStorageWitness.open(input);
    try {
      return await witness.use(async (docker, observed) => {
        if (observed.containerPath !== input.localDirectory || migrationStorageHash(observed) !== preparation.storageSha256) throw fail();
        await empty(input.localDirectory);
        await noForeignWriters(docker, observed, new Set(), new Set());
        return new FreshAppStorage(witness, [...preparation.initialVolumes], preparation.storageSha256, input.appUrn, input.localDirectory);
      });
    } catch (error) {
      await witness.close();
      throw error;
    }
  }
  static async reopen(input: { appUrn: AppUrn; localDirectory: string; socketPath: string; docker: Dockerode }, stage: AppUpdateStage) {
    const state = await stage.verifyFreshInstall();
    if (state.appUrn !== input.appUrn || !state.freshInstall) throw fail();
    const witness = await AppStorageWitness.open(input);
    try {
      const fresh = state.freshInstall;
      return await witness.use(async (_docker, observed) => {
        if (observed.containerPath !== input.localDirectory || migrationStorageHash(observed) !== fresh.storageSha256) throw fail();
        return new FreshAppStorage(witness, [...fresh.initialVolumes], fresh.storageSha256, input.appUrn, input.localDirectory);
      });
    } catch (error) {
      await witness.close();
      throw error;
    }
  }
  private async use<T>(effect: (docker: Dockerode, observed: Readonly<AppStorageObservation>) => Promise<T>) {
    return this.witness.use(async (docker, observed) => {
      if (observed.appUrn !== this.appUrn || migrationStorageHash(observed) !== this.storageSha256) throw fail();
      return effect(docker, observed);
    });
  }
  async initialize(stage: AppUpdateStage) {
    return this.use(async (docker, observed) => {
      await empty(this.localDirectory);
      await noForeignWriters(docker, observed, new Set(), new Set());
      await stage.beginFreshStorage(this.storageSha256, this.initialVolumes);
    });
  }
  private async seedSnapshot(stage: AppUpdateStage, environment: ReadonlyMap<string, string>) {
    const state = await stage.read();
    const source = await stage.readTarget();
    if (!state.prepared || state.context?.purpose !== 'fresh-install') throw fail();
    const entries = state.prepared.entries
      .filter((row) => row.name === 'data' || row.name.startsWith('data/'))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
    const result: { name: string; directory: boolean; link?: string; bytes?: Buffer }[] = [];
    let total = 0;
    for (const row of entries) {
      const name = row.name.endsWith('.template') && !row.directory && row.symlink === undefined ? row.name.slice(0, -9) : row.name;
      if (!absolute(path.join(this.localDirectory, name)) || !path.join(this.localDirectory, name).startsWith(this.localDirectory + '/'))
        throw fail();
      if (row.directory) {
        result.push({ name, directory: true });
        continue;
      }
      if (row.symlink !== undefined) {
        const current = await fs.readlink(path.join(source.target, row.name));
        if (current !== row.symlink || createHash('sha256').update(current).digest('hex') !== row.sha256) throw fail();
        const resolved = resolvePackageLink(state.prepared.entries, row.name);
        const selected = state.prepared.entries.find((entry) => entry.name === resolved);
        const link =
          selected?.name.startsWith('data/') && !selected.directory && selected.symlink === undefined && selected.name.endsWith('.template')
            ? path.posix.relative(path.posix.dirname(row.name), selected.name.slice(0, -9))
            : row.symlink;
        result.push({ name, directory: false, link });
        continue;
      }
      let bytes = await appUpdateStorage.readOwned(path.join(source.target, row.name), 8 * 1024 * 1024);
      if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw fail();
      if (row.name.endsWith('.template')) {
        let value = bytes.toString('utf8');
        for (const [key, content] of environment) {
          value = value.split('{{' + key + '}}').join(content);
          if (Buffer.byteLength(value) > 8 * 1024 * 1024) throw fail();
        }
        bytes = Buffer.from(value);
      }
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw fail();
      result.push({ name, directory: false, bytes });
    }
    if (new Set(result.map(({ name }) => name)).size !== result.length) throw fail();
    await stage.readTarget();
    return result;
  }
  async seed(stage: AppUpdateStage, environment: ReadonlyMap<string, string>) {
    return this.use(async (docker, observed) => {
      await noForeignWriters(docker, observed, new Set(), new Set());
      await empty(this.localDirectory);
      if (environment.get('APP_DATA_DIR') !== observed.hostPath) throw fail();
      const state = await stage.read();
      if (state.freshInstall?.phase !== 'allocating' || state.freshInstall.createAttempted || state.freshInstall.seed !== 'pending') throw fail();
      const entries = await this.seedSnapshot(stage, environment);
      await stage.beginFreshSeed();
      for (const row of entries) {
        const destination = path.join(this.localDirectory, row.name);
        if (row.directory) {
          await fs.mkdir(destination, { mode: 0o777 });
          await fs.chmod(destination, 0o777);
        } else if (row.link !== undefined) await fs.symlink(row.link, destination);
        else {
          const output = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o777);
          try {
            await output.writeFile(row.bytes ?? Buffer.alloc(0));
            await output.chmod(0o777);
            await output.sync();
          } finally {
            await output.close();
          }
        }
      }
      await stage.readTarget();
      await noForeignWriters(docker, observed, new Set(), new Set());
      for (const name of [
        ...entries
          .filter((row) => row.directory)
          .map((row) => path.join(this.localDirectory, row.name))
          .reverse(),
        this.localDirectory,
      ]) {
        const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await stage.confirmFreshSeed();
    });
  }
  /** Readback before the first create never rewrites or adopts changed seed data. */
  async verifySeed(stage: AppUpdateStage, environment: ReadonlyMap<string, string>) {
    return this.use(async (docker, observed) => {
      const state = await stage.read();
      if (
        environment.get('APP_DATA_DIR') !== observed.hostPath ||
        !['intent', 'ready'].includes(state.freshInstall?.seed ?? '') ||
        state.freshInstall?.createAttempted
      )
        throw fail();
      await noForeignWriters(docker, observed, new Set(), new Set());
      const entries = await this.seedSnapshot(stage, environment);
      const actual = await appUpdateStorage.metadataState(this.localDirectory, path.join(this.localDirectory, 'app.env'));
      const expected: { name: string; directory: boolean; bytes?: number; sha256?: string; symlink?: string }[] = [
        { name: '', directory: true },
        ...entries.map((row) => ({
          name: row.name,
          directory: row.directory,
          ...(row.directory
            ? {}
            : row.link === undefined
              ? {
                  bytes: row.bytes?.length ?? 0,
                  sha256: createHash('sha256')
                    .update(row.bytes ?? Buffer.alloc(0))
                    .digest('hex'),
                }
              : { bytes: Buffer.byteLength(row.link), sha256: createHash('sha256').update(row.link).digest('hex'), symlink: row.link }),
        })),
      ];
      if (actual.entries.some((row) => row.name === 'app.env')) {
        if (state.phase === 'target-ready' || !state.prepared?.envSha256) throw fail();
        const env = actual.entries.find((row) => row.name === 'app.env');
        if (!env || env.directory || env.symlink !== undefined || env.sha256 !== state.prepared.envSha256 || env.mode !== state.prepared.envMode)
          throw fail();
        expected.push({ name: 'app.env', directory: false, bytes: env.bytes, sha256: env.sha256 });
      }
      const content = (rows: typeof actual.entries) =>
        rows
          .map(({ name, directory, bytes, sha256, symlink }) => ({
            name,
            directory,
            ...(directory ? {} : { bytes, sha256, ...(symlink === undefined ? {} : { symlink }) }),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      if (canonical(content(actual.entries)) !== canonical([...expected].sort((a, b) => a.name.localeCompare(b.name)))) throw fail();
      await noForeignWriters(docker, observed, new Set(), new Set());
      await stage.readTarget();
      if (state.freshInstall?.seed === 'intent') await stage.confirmFreshSeed();
    });
  }
  async allocate(stage: AppUpdateStage, effective: unknown) {
    return this.use(async (docker, observed) => {
      const state = await stage.read();
      if (
        !record(effective) ||
        effective.name !== this.appUrn.replace(':', '_') ||
        !record(effective.services) ||
        !state.pulledImages ||
        state.freshInstall?.phase !== 'allocating' ||
        state.freshInstall.createAttempted
      )
        throw fail();
      await noForeignWriters(docker, observed, new Set(), new Set(Object.keys(state.freshInstall.allocations)));
      const declarations = record(effective.volumes) ? effective.volumes : {};
      const selected = new Map<string, Record<string, unknown>>();
      for (const service of Object.values(effective.services)) {
        if (!record(service) || (service.volumes !== undefined && !Array.isArray(service.volumes))) throw fail();
        for (const item of (service.volumes ?? []) as unknown[]) {
          if (!record(item) || !absolute(item.target)) throw fail();
          if (item.type === 'bind') {
            if (
              !absolute(item.source) ||
              (!item.read_only && !(item.source === observed.hostPath || item.source.startsWith(observed.hostPath + '/')))
            )
              throw fail();
          } else if (item.type === 'volume' && item.source !== undefined && item.read_only !== true) {
            if (typeof item.source !== 'string' || !record(declarations[item.source])) throw fail();
            const declaration = declarations[item.source];
            if (!record(declaration)) throw fail();
            if (
              declaration.external ||
              (declaration.driver !== undefined && declaration.driver !== 'local') ||
              (declaration.driver_opts !== undefined && (!record(declaration.driver_opts) || Object.keys(declaration.driver_opts).length)) ||
              typeof declaration.name !== 'string' ||
              !volumeName.test(declaration.name)
            )
              throw fail();
            selected.set(declaration.name, declaration);
          } else if (item.type !== 'volume' && item.type !== 'tmpfs') throw fail();
        }
      }
      if (Object.keys(state.freshInstall.allocations).some((name) => !selected.has(name))) throw fail();
      for (const [name] of selected) {
        if (this.initialVolumes.includes(name) || (await volume(docker, name))) throw fail();
        // Journal before frozen Compose may allocate it; exact project/logical labels and absence bind the readback.
        const retained = state.freshInstall.allocations[name];
        if (retained && retained.phase !== 'create-intent') throw fail();
        if (!retained) await stage.recordFreshVolume(name, null);
      }
      await stage.readTarget();
    });
  }
  async prepared(stage: AppUpdateStage, effective: unknown) {
    return this.use(async (docker, observed) => {
      const state = await stage.read();
      const fresh = state.freshInstall;
      if (
        !fresh ||
        fresh.phase !== 'allocating' ||
        !fresh.createAttempted ||
        !state.pulledImages ||
        !record(effective) ||
        !record(effective.services)
      )
        throw fail();
      const activeServices = effective['x-orbis-fresh-active-services'];
      if (
        !Array.isArray(activeServices) ||
        activeServices.some((name) => typeof name !== 'string' || !Object.hasOwn(state.pulledImages?.imageIds ?? {}, name))
      )
        throw fail();
      const all = await containers(docker);
      const owned = all.filter(
        (value) =>
          record(value.Config) && record(value.Config.Labels) && value.Config.Labels['com.docker.compose.project'] === this.appUrn.replace(':', '_'),
      );
      const ids = new Set<string>();
      const rows: FreshInstallState['containers'] = [];
      const ownVolumes = new Set(Object.keys(fresh.allocations));
      const writableBinds: { relative: string; createHostPath: boolean }[] = [];
      for (const value of owned) {
        if (typeof value.Id !== 'string' || !id.test(value.Id) || !record(value.Config) || !record(value.Config.Labels) || !neverStarted(value.State))
          throw fail();
        const labels = value.Config.Labels;
        const service = labels['com.docker.compose.service'];
        if (
          typeof service !== 'string' ||
          labels['runtipi.managed'] !== 'true' ||
          labels['runtipi.appurn'] !== this.appUrn ||
          labels['io.orbis.app-update.stage'] !== stage.id ||
          state.pulledImages.imageIds[service] !== value.Image
        )
          throw fail();
        const definition = effective.services[service];
        if (!record(definition) || (definition.volumes !== undefined && !Array.isArray(definition.volumes))) throw fail();
        const explicit = new Map<string, Record<string, unknown>>();
        for (const mount of (definition.volumes ?? []) as unknown[]) {
          if (!record(mount) || !absolute(mount.target) || explicit.has(mount.target)) throw fail();
          explicit.set(mount.target, mount);
        }
        const image = await request(docker, `/images/${value.Image}/json`);
        if (
          !record(image) ||
          image.Id !== value.Image ||
          !record(image.Config) ||
          (image.Config.Volumes !== null && image.Config.Volumes !== undefined && !record(image.Config.Volumes))
        )
          throw fail();
        const hidden = record(image.Config.Volumes) ? Object.keys(image.Config.Volumes) : [];
        if (hidden.length > 256 || hidden.some((target) => !absolute(target))) throw fail();
        const actualMounts = mounts(value);
        for (const target of new Set([...explicit.keys(), ...hidden])) {
          if (explicit.get(target)?.type !== 'tmpfs' && !actualMounts.some((mount) => mount.target === target)) throw fail();
        }
        for (const mount of actualMounts) {
          const configured = explicit.get(mount.target);
          if (!configured && !hidden.includes(mount.target)) throw fail();
          if (configured && (configured.type !== mount.type || mount.writable !== (configured.read_only !== true))) throw fail();

          if (mount.type === 'bind') {
            if (
              !configured ||
              mount.source !== configured.source ||
              !absolute(mount.source) ||
              (mount.writable && !(mount.source === observed.hostPath || mount.source.startsWith(observed.hostPath + '/')))
            )
              throw fail();
            if (mount.writable)
              writableBinds.push({
                relative: mount.source.slice(observed.hostPath.length),
                createHostPath: record(configured.bind) && configured.bind.create_host_path === true,
              });
          } else if (mount.type === 'volume') {
            if (typeof mount.name !== 'string' || !volumeName.test(mount.name)) throw fail();
            if (configured?.source !== undefined) {
              if (!record(effective.volumes) || typeof configured.source !== 'string') throw fail();
              const declaration = effective.volumes[configured.source];
              if (!record(declaration) || declaration.name !== mount.name) throw fail();
            }
            if (!mount.writable) continue;
            if (this.initialVolumes.includes(mount.name)) throw fail();
            const actual = await volume(docker, mount.name);
            if (!actual) throw fail();
            const recorded = (await stage.read()).freshInstall?.allocations[mount.name];
            if (configured?.source !== undefined) {
              if (
                !recorded ||
                !record(actual.labels) ||
                actual.labels['com.docker.compose.project'] !== this.appUrn.replace(':', '_') ||
                actual.labels['com.docker.compose.volume'] !== configured.source
              )
                throw fail();
              if (recorded.phase === 'create-intent') await stage.recordFreshVolume(mount.name, hash(actual));
              else if (recorded.sha256 !== hash(actual)) throw fail();
            } else if (recorded) {
              if (recorded.phase !== 'created' || recorded.sha256 !== hash(actual)) throw fail();
            } else {
              await stage.recordFreshVolume(mount.name, null);
              await stage.recordFreshVolume(mount.name, hash(actual));
            }
            ownVolumes.add(mount.name);
          } else if (mount.type !== 'tmpfs') throw fail();
        }
        ids.add(value.Id);
        rows.push({
          id: value.Id,
          imageId: String(value.Image),
          service,
          active: activeServices.includes(service),
          mountsSha256: hash(mounts(value)),
        });
      }
      await noForeignWriters(docker, observed, ids, ownVolumes);
      for (const { relative, createHostPath } of writableBinds) await prepareWritableBind(this.localDirectory, relative, createHostPath);
      await stage.preparedFreshStorage(rows);
    });
  }
  async verify(stage: AppUpdateStage, running: boolean) {
    return this.use(async (docker, observed) => {
      const state = await stage.read();
      const fresh = state.freshInstall;
      if (!fresh || !fresh.containers.length || fresh.storageSha256 !== this.storageSha256) throw fail();
      const own = await noForeignWriters(docker, observed, new Set(fresh.containers.map(({ id }) => id)), new Set(Object.keys(fresh.allocations)));
      for (const expected of fresh.containers) {
        const value = own.find(({ Id }) => Id === expected.id);
        if (
          !value ||
          value.Image !== expected.imageId ||
          !record(value.Config) ||
          !record(value.Config.Labels) ||
          value.Config.Labels['io.orbis.app-update.stage'] !== stage.id ||
          value.Config.Labels['com.docker.compose.service'] !== expected.service ||
          value.Config.Labels['runtipi.managed'] !== 'true' ||
          value.Config.Labels['runtipi.appurn'] !== this.appUrn ||
          hash(mounts(value)) !== expected.mountsSha256 ||
          !record(value.State)
        )
          throw fail();
        const runtime = value.State;
        if (
          running && expected.active
            ? runtime.Running !== true ||
              runtime.Paused !== false ||
              runtime.Restarting !== false ||
              runtime.Dead !== false ||
              !Number.isSafeInteger(runtime.Pid) ||
              Number(runtime.Pid) <= 0 ||
              (record(runtime.Health) && runtime.Health.Status !== 'healthy')
            : !neverStarted(runtime)
        )
          throw fail();
      }
      for (const [name, recorded] of Object.entries(fresh.allocations)) {
        const actual = await volume(docker, name);
        if (!actual || recorded.phase !== 'created' || hash(actual) !== recorded.sha256) throw fail();
      }
      await stage.verifyFreshInstall();
    });
  }
  close() {
    return this.witness.close();
  }
}
