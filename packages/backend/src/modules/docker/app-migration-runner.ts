import fs from 'node:fs/promises';
import path from 'node:path';
import type Dockerode from 'dockerode';
import type { ArchiveService } from '@/core/archive/archive.service';
import { BackupDirectorySwap } from '../system-backups/backup-directory-swap';
import {
  AppMigrationJournal,
  migrationFailure,
  migrationHash,
  migrationStorageHash,
  type MigrationJournalState,
  type MigrationRunnerRecord,
} from '../backups/app-migration-journal';
import type { AppStorageObservation, AppStorageWitness } from '../host-updates/app-storage-observation';
import type { AppMigrationDefinition } from './app-migration-plan';
import type { AppMigrationImage } from './app-migration-images';
import {
  inspectMigrationContainer,
  migrationEngineRequest,
  migrationRecord,
  migrationStopped,
  requireMigrationAppStopped,
  requireMigrationRollbackWriters,
} from './app-migration-engine';

const prefix = 'io.orbis.app-migration';
const id = /^[a-f0-9]{64}$/;
const labels = (state: Readonly<MigrationJournalState>, row: Pick<MigrationRunnerRecord, 'nonce' | 'migrationId'>) => ({
  [prefix]: 'v1',
  [`${prefix}.app`]: state.operation.appUrn,
  [`${prefix}.request`]: state.operation.requestId,
  [`${prefix}.stage`]: state.operation.stageId,
  [`${prefix}.migration`]: row.migrationId,
  [`${prefix}.nonce`]: row.nonce,
});
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const environment = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 4096) throw migrationFailure();
  const result: Record<string, string> = {};
  for (const item of value) {
    if (typeof item !== 'string' || item.includes('\0') || item.length > 256 * 1024 || !item.includes('=')) throw migrationFailure();
    const separator = item.indexOf('=');
    Object.defineProperty(result, item.slice(0, separator), { value: item.slice(separator + 1), enumerable: true, configurable: true });
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};
const terminalHash = (value: Record<string, unknown>) => migrationHash({ image: value.Image, state: value.State, restarts: value.RestartCount });

function basic(value: Record<string, unknown>, state: Readonly<MigrationJournalState>, row: MigrationRunnerRecord) {
  const pin = state.operation.images.find((entry) => entry.migrationId === row.migrationId);
  if (!pin || value.Name !== '/' + row.name || value.Image !== pin.imageId || !migrationRecord(value.Config) || !migrationRecord(value.Config.Labels))
    throw migrationFailure();
  if (row.containerId !== null && value.Id !== row.containerId) throw migrationFailure();
  for (const [key, expected] of Object.entries(labels(state, row))) if (value.Config.Labels[key] !== expected) throw migrationFailure();
  const host = value.HostConfig;
  if (
    !migrationRecord(host) ||
    host.AutoRemove !== false ||
    host.NetworkMode !== 'none' ||
    host.Privileged !== false ||
    host.ReadonlyRootfs !== true ||
    !migrationRecord(host.RestartPolicy) ||
    host.RestartPolicy.Name !== 'no'
  )
    throw migrationFailure();
}

async function inventory(docker: Dockerode, state: Readonly<MigrationJournalState>, signal: AbortSignal) {
  const listed = await migrationEngineRequest(
    docker,
    '/containers/json?',
    'GET',
    { all: true, filters: JSON.stringify({ label: [`${prefix}=v1`, `${prefix}.app=${state.operation.appUrn}`] }) },
    signal,
  );
  if (!Array.isArray(listed) || listed.length > 300) throw migrationFailure();
  const result = new Map<string, Record<string, unknown>>();
  for (const item of listed) {
    if (!migrationRecord(item) || typeof item.Id !== 'string' || !id.test(item.Id)) throw migrationFailure();
    const value = await inspectMigrationContainer(docker, item.Id, signal);
    if (!value) throw migrationFailure();
    const row = state.runners.find((entry) => entry.containerId === item.Id || (entry.phase === 'create-intent' && value.Name === '/' + entry.name));
    if (!row || result.has(row.migrationId)) throw migrationFailure();
    basic(value, state, row);
    if (['terminal', 'removed'].includes(row.phase) && (!migrationStopped(value.State) || terminalHash(value) !== row.terminalSha256))
      throw migrationFailure();
    if (row.phase === 'removed') throw migrationFailure();
    result.set(row.migrationId, value);
  }
  for (const row of state.runners) {
    if (row.phase !== 'create-intent' && row.phase !== 'removed' && !result.has(row.migrationId)) throw migrationFailure();
  }
  return result;
}

type Plan = { definition: AppMigrationDefinition; image: AppMigrationImage };
type Recipe = {
  body: Record<string, unknown>;
  expectedEnvironment: Record<string, string>;
  entrypoint: readonly string[];
  command: readonly string[];
};

async function recipe(
  docker: Dockerode,
  state: Readonly<MigrationJournalState>,
  plan: Plan,
  row: Pick<MigrationRunnerRecord, 'name' | 'nonce' | 'migrationId'>,
  observed: Readonly<AppStorageObservation>,
  signal: AbortSignal,
  checkSourcePaths = true,
): Promise<Recipe> {
  const { definition, image } = plan;
  if (
    image.migrationId !== definition.id ||
    image.sourceSha256 !== definition.sourceSha256 ||
    image.definitionSha256 !== migrationHash(definition) ||
    !equal(
      state.operation.images.find((entry) => entry.migrationId === definition.id),
      image,
    )
  )
    throw migrationFailure();
  const value = await migrationEngineRequest(docker, `/images/${image.imageId}/json`, 'GET', {}, signal);
  if (
    !migrationRecord(value) ||
    value.Id !== image.imageId ||
    value.Os !== 'linux' ||
    value.Architecture !== image.platform.split('/')[1] ||
    !migrationRecord(value.Config)
  )
    throw migrationFailure();
  const config = value.Config;
  const strings = (input: unknown) => {
    if (input === null || input === undefined) return [];
    if (!Array.isArray(input) || input.length > 256 || input.some((entry) => typeof entry !== 'string' || entry.includes('\0')))
      throw migrationFailure();
    return input as string[];
  };
  const entrypoint = definition.entrypoint ?? strings(config.Entrypoint);
  const command = definition.command ?? (definition.entrypoint === undefined ? strings(config.Cmd) : []);
  if (!entrypoint.length && !command.length) throw migrationFailure();
  const expectedEnvironment = environment([
    ...strings(config.Env),
    ...Object.entries(definition.environment).map(([key, value]) => key + '=' + value),
  ]);
  if (
    config.Volumes !== undefined &&
    config.Volumes !== null &&
    (!migrationRecord(config.Volumes) || Object.keys(config.Volumes).some((target) => !definition.mounts.some((mount) => mount.target === target)))
  )
    throw migrationFailure();
  for (const mount of definition.mounts) {
    if (mount.source !== observed.hostPath && !mount.source.startsWith(observed.hostPath + '/')) throw migrationFailure();
    if (checkSourcePaths) {
      const relative = path.posix.relative(observed.hostPath, mount.source);
      const local = path.join(observed.containerPath, relative);
      if ((await fs.realpath(local)) !== local) throw migrationFailure();
      const actual = await fs.lstat(local);
      if (!actual.isDirectory() && (!actual.isFile() || actual.nlink !== 1)) throw migrationFailure();
    }
  }
  const temporary = Object.fromEntries(
    definition.temporary.map((mount) => [
      mount.target,
      `rw,nosuid,nodev,noexec,size=${mount.sizeBytes},mode=${mount.mode.toString(8)},uid=${mount.uid ?? 0},gid=${mount.gid ?? 0}`,
    ]),
  );
  const body = {
    Image: image.imageId,
    User: definition.user ?? config.User ?? '',
    WorkingDir: definition.workingDirectory ?? config.WorkingDir ?? '',
    Entrypoint: entrypoint.length ? entrypoint : [''],
    Cmd: command,
    Env: Object.entries(expectedEnvironment).map(([key, value]) => key + '=' + value),
    Labels: labels(state, row),
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      PidsLimit: 128,
      Memory: 1024 ** 3,
      MemorySwap: 1024 ** 3,
      NanoCpus: 1_000_000_000,
      PublishAllPorts: false,
      Mounts: definition.mounts.map((mount) => ({
        Type: 'bind',
        Source: mount.source,
        Target: mount.target,
        ReadOnly: mount.readOnly,
        BindOptions: { Propagation: 'rprivate', NonRecursive: true },
      })),
      Tmpfs: temporary,
      LogConfig: { Type: 'none', Config: {} },
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
  if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw migrationFailure();
  return { body, entrypoint, command, expectedEnvironment };
}

function exact(
  value: Record<string, unknown>,
  expected: Recipe,
  state: Readonly<MigrationJournalState>,
  row: MigrationRunnerRecord,
  definition: AppMigrationDefinition,
) {
  basic(value, state, row);
  const config = value.Config;
  const host = value.HostConfig;
  if (!migrationRecord(config) || !migrationRecord(host)) throw migrationFailure();
  const target = expected.body;
  if (
    !equal(environment(config.Env ?? []), expected.expectedEnvironment) ||
    !equal(config.Cmd ?? [], expected.command) ||
    !equal(config.Entrypoint ?? [], expected.entrypoint) ||
    (config.User ?? '') !== target.User ||
    (config.WorkingDir || '/') !== (target.WorkingDir || '/') ||
    config.OpenStdin !== false ||
    config.Tty !== false ||
    !migrationRecord(config.Healthcheck) ||
    !equal(config.Healthcheck.Test, ['NONE'])
  )
    throw migrationFailure();
  if (
    !equal(host.CapDrop, ['ALL']) ||
    (host.CapAdd !== null && host.CapAdd !== undefined && (!Array.isArray(host.CapAdd) || host.CapAdd.length > 0)) ||
    !Array.isArray(host.SecurityOpt) ||
    host.SecurityOpt.length !== 1 ||
    !['no-new-privileges', 'no-new-privileges:true'].includes(host.SecurityOpt[0]) ||
    host.PidMode ||
    host.UTSMode ||
    host.UsernsMode ||
    host.IpcMode !== 'private' ||
    host.Init !== true ||
    host.PidsLimit !== 128 ||
    host.Memory !== 1024 ** 3 ||
    host.MemorySwap !== 1024 ** 3 ||
    host.NanoCpus !== 1_000_000_000 ||
    host.PublishAllPorts !== false ||
    ['VolumesFrom', 'Binds', 'Devices', 'DeviceRequests', 'Links', 'ExtraHosts'].some(
      (key) => host[key] !== null && host[key] !== undefined && (!Array.isArray(host[key]) || host[key].length),
    )
  )
    throw migrationFailure();
  if (
    !migrationRecord(host.LogConfig) ||
    host.LogConfig.Type !== 'none' ||
    !equal(host.Tmpfs ?? {}, (target.HostConfig as Record<string, unknown>).Tmpfs)
  )
    throw migrationFailure();
  if (
    !Array.isArray(value.Mounts) ||
    value.Mounts.length < definition.mounts.length ||
    value.Mounts.length > definition.mounts.length + definition.temporary.length
  )
    throw migrationFailure();
  if (new Set(value.Mounts.map((mount) => (migrationRecord(mount) ? mount.Destination : null))).size !== value.Mounts.length)
    throw migrationFailure();
  const binds = value.Mounts.filter((mount) => migrationRecord(mount) && mount.Type === 'bind');
  if (binds.length !== definition.mounts.length) throw migrationFailure();
  for (const mount of value.Mounts) {
    if (!migrationRecord(mount)) throw migrationFailure();
    if (mount.Type === 'tmpfs' && definition.temporary.some((entry) => entry.target === mount.Destination)) continue;
    if (
      mount.Type !== 'bind' ||
      typeof mount.RW !== 'boolean' ||
      !definition.mounts.some((entry) => entry.source === mount.Source && entry.target === mount.Destination && entry.readOnly === !mount.RW) ||
      mount.Propagation !== 'rprivate'
    )
      throw migrationFailure();
  }
  if (migrationHash(expected.body) !== row.specSha256) throw migrationFailure();
}

/** Executes only a checkpointed, storage-bound operation. The command join remains separate. */
export class AppMigrationRunner {
  constructor(
    private readonly journal: AppMigrationJournal,
    private readonly storage: AppStorageWitness,
  ) {}

  async run(plans: readonly Plan[], cancellation?: AbortSignal) {
    return this.journal.exclusive(() => this.runSelected(plans, cancellation));
  }
  private async runSelected(plans: readonly Plan[], cancellation?: AbortSignal) {
    const selected = structuredClone(plans);
    const byId = new Map(selected.map((plan) => [plan.definition.id, plan]));
    if (byId.size !== selected.length) throw migrationFailure();
    const first = await this.journal.read();
    if (!['ready', 'running', 'migrations-complete'].includes(first.phase)) throw migrationFailure();
    await this.journal.verifyCheckpoint();
    try {
      if (first.phase === 'migrations-complete') {
        await this.storage.use(async (docker, observed) => {
          if (migrationStorageHash(observed) !== first.storageSha256) throw migrationFailure();
          await requireMigrationAppStopped(docker, first, observed);
          await inventory(docker, first, AbortSignal.timeout(30_000));
        });
        return;
      }
      for (const image of first.operation.images) {
        const state = await this.journal.read();
        const previous = state.runners.find((row) => row.migrationId === image.migrationId);
        if (previous && ['terminal', 'removed'].includes(previous.phase)) {
          if (previous.exitCode !== 0) throw migrationFailure();
          await this.storage.use(async (docker, observed) => {
            if (migrationStorageHash(observed) !== state.storageSha256) throw migrationFailure();
            await requireMigrationAppStopped(docker, state, observed);
            await inventory(docker, state, AbortSignal.timeout(30_000));
          });
          continue;
        }
        const plan = byId.get(image.migrationId);
        if (!plan) throw migrationFailure();
        await this.one(plan, cancellation);
      }
      await this.storage.use(async (docker, observed) => {
        const state = await this.journal.read();
        if (migrationStorageHash(observed) !== state.storageSha256) throw migrationFailure();
        await requireMigrationAppStopped(docker, state, observed);
        await inventory(docker, state, AbortSignal.timeout(30_000));
      });
      await this.journal.finishMigrations();
    } catch {
      await this.journal.requireRecovery();
      throw migrationFailure();
    }
  }

  async verifyRollbackWriters(plans: readonly Plan[]) {
    return this.journal.exclusive(async () => {
      const state = await this.journal.read();
      await this.storage.use(async (docker, observed) => {
        if (migrationStorageHash(observed) !== state.storageSha256) throw migrationFailure();
        await requireMigrationRollbackWriters(docker, state, observed);
        const signal = AbortSignal.timeout(30_000);
        const known = await inventory(docker, state, signal);
        for (const row of state.runners) {
          if (row.phase === 'removed' || (row.phase === 'create-intent' && !known.has(row.migrationId))) continue;
          const current = known.get(row.migrationId);
          const plan = plans.find(({ definition }) => definition.id === row.migrationId);
          if (!current || !plan) throw migrationFailure();
          const expected = await recipe(docker, state, plan, row, observed, signal, false);
          exact(current, expected, state, row, plan.definition);
          if (!migrationStopped(current.State)) throw migrationFailure();
        }
      });
    });
  }

  /** Recovery before target activation only. No app start, SQL write or checkpoint deletion. */
  async restoreCheckpoint(plans: readonly Plan[], localDirectory: string, archive: ArchiveService, cancellation?: AbortSignal) {
    return this.journal.exclusive(() => this.restoreSelected(plans, localDirectory, archive, cancellation));
  }
  private async restoreSelected(plans: readonly Plan[], localDirectory: string, archive: ArchiveService, cancellation?: AbortSignal) {
    const selected = structuredClone(plans);
    if (new Set(selected.map(({ definition }) => definition.id)).size !== selected.length) throw migrationFailure();
    const initial = await this.journal.read();
    if (
      initial.targetWritesPossible ||
      initial.commitAttempted ||
      !['ready', 'running', 'migrations-complete', 'recovery-required', 'restoring', 'restored'].includes(initial.phase)
    )
      throw migrationFailure();
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60 * 1000), ...(cancellation ? [cancellation] : [])]);
    try {
      await this.journal.verifyCheckpoint();
      await this.storage.use(async (docker, observed) => {
        if (migrationStorageHash(observed) !== initial.storageSha256 || observed.containerPath !== localDirectory) throw migrationFailure();
        // A terminal phase alone is not evidence that a writer is still stopped.
        const quiescent = async () => {
          const state = await this.journal.read();
          await requireMigrationAppStopped(docker, state, observed);
          const known = await inventory(docker, state, signal);
          for (const row of state.runners) {
            if (row.phase === 'removed' || row.phase === 'terminal') continue;
            let current = known.get(row.migrationId);
            if (!current && row.phase === 'create-intent') continue;
            if (!current || typeof current.Id !== 'string') throw migrationFailure();
            const plan = selected.find(({ definition }) => definition.id === row.migrationId);
            if (!plan) throw migrationFailure();
            // Recovery may have moved children already; matching the retained recipe must not resolve them again.
            const expected = await recipe(docker, state, plan, row, observed, signal, false);
            exact(current, expected, state, row, plan.definition);
            if (!migrationStopped(current.State)) {
              if (row.phase !== 'start-intent') throw migrationFailure();
              const cleanup = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
              // Only this full inspected ID may be terminated; a foreign sibling already refused above.
              await migrationEngineRequest(docker, `/containers/${current.Id}/kill?`, 'POST', { signal: 'KILL' }, cleanup).catch(() => undefined);
              const containerId = current.Id;
              do {
                cleanup.throwIfAborted();
                current = (await inspectMigrationContainer(docker, containerId, cleanup)) ?? undefined;
                if (!current) throw migrationFailure();
                exact(current, expected, state, row, plan.definition);
                if (!migrationStopped(current.State)) await new Promise((resolve) => setTimeout(resolve, 50));
              } while (!migrationStopped(current.State));
            }
          }
          await requireMigrationAppStopped(docker, state, observed);
          await inventory(docker, state, signal);
        };
        await quiescent();
        if (initial.phase === 'restored') return;
        let state = await this.journal.read();
        let attempt = state.restores.at(-1);
        if (attempt && attempt.phase !== 'abandoned') {
          const location = path.join(this.journal.directory, `restore-${attempt.id}`);
          const swap = await BackupDirectorySwap.open(location, { id: attempt.id, root: localDirectory });
          if (attempt.phase === 'committed') {
            await swap.commit();
            return;
          }
          if (attempt.phase === 'promoting') {
            // A lost commit reply is read-only reconciliation; incomplete moves roll back before retry.
            let committed = false;
            try {
              await swap.commit();
              committed = true;
            } catch {
              await swap.rollback();
              await swap.cleanup();
            }
            if (committed) {
              await this.journal.restoreStep(attempt.id, 'committed');
              return;
            }
          } else await swap.discardPrepared();
          await this.journal.restoreStep(attempt.id, 'abandoned');
        }
        attempt = await this.journal.beginRestore();
        const swap = await BackupDirectorySwap.create({
          id: attempt.id,
          root: localDirectory,
          journal: path.join(this.journal.directory, `restore-${attempt.id}`),
        });
        const stagingOwner = await fs.stat(swap.incomingDirectory);
        const output = await archive.extractTarGz(path.join(this.journal.directory, 'before.tar.gz'), swap.incomingDirectory);
        if (output.stderr.trim()) throw migrationFailure();
        await fs.chown(swap.incomingDirectory, stagingOwner.uid, stagingOwner.gid);
        await fs.chmod(swap.incomingDirectory, 0o700);
        await this.journal.verifyCheckpoint();
        await swap.seal(signal, { allowAppDataLinks: true });
        await this.journal.restoreStep(attempt.id, 'staged');
        await quiescent();
        await this.journal.restoreStep(attempt.id, 'promoting');
        await swap.promote(signal);
        await quiescent();
        await swap.commit();
        await this.journal.restoreStep(attempt.id, 'committed');
        state = await this.journal.read();
        if (state.targetWritesPossible) throw migrationFailure();
        // Retain the failed data in the swap until command/SQL reconciliation completes.
      });
      if ((await this.journal.read()).phase !== 'restored') await this.journal.restored();
    } catch {
      await this.journal.requireRecovery();
      throw migrationFailure();
    }
  }

  private async one(plan: Plan, cancellation?: AbortSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60 * 1000), ...(cancellation ? [cancellation] : [])]);
    await this.storage.use(async (docker, observed) => {
      let state = await this.journal.read();
      if (migrationStorageHash(observed) !== state.storageSha256) throw migrationFailure();
      await requireMigrationAppStopped(docker, state, observed);
      await inventory(docker, state, signal);
      let captured: Recipe | undefined;
      const existing = state.runners.find((row) => row.migrationId === plan.definition.id);
      // Resolve the fixed recipe before writing intent; only exact immutable local image IDs are inspected.
      const seed = existing ?? { migrationId: plan.definition.id, name: '', nonce: '' };
      const initial = await recipe(docker, state, plan, seed, observed, signal);
      const row = await this.journal.intent(plan.image, (_name, nonce) => {
        const body = structuredClone(initial.body);
        body.Labels = labels(state, { migrationId: plan.definition.id, nonce });
        captured = { ...initial, body };
        return migrationHash(body);
      });
      if (!captured) throw migrationFailure();
      const expected = captured;
      state = await this.journal.read();
      let current = (await inventory(docker, state, signal)).get(row.migrationId);
      if (row.phase === 'create-intent') {
        if (!current) {
          try {
            await migrationEngineRequest(docker, '/containers/create?', 'POST', { _query: { name: row.name }, _body: expected.body }, signal);
          } catch {
            /* A lost create reply is reconciled by exact name, labels, image and full inspection. */
          }
          current = (await inventory(docker, state, AbortSignal.timeout(30_000))).get(row.migrationId);
        }
        if (!current || typeof current.Id !== 'string' || !id.test(current.Id)) throw migrationFailure();
        exact(current, expected, state, row, plan.definition);
        if (!migrationStopped(current.State) || !migrationRecord(current.State) || current.State.Status !== 'created') throw migrationFailure();
        await this.journal.record(row.migrationId, 'created', current.Id);
      }
      state = await this.journal.read();
      const saved = state.runners.find((item) => item.migrationId === row.migrationId);
      if (!saved?.containerId) throw migrationFailure();
      current = (await inspectMigrationContainer(docker, saved.containerId, signal)) ?? undefined;
      if (!current) throw migrationFailure();
      exact(current, expected, state, saved, plan.definition);
      if (saved.phase === 'created') {
        if (!migrationStopped(current.State) || !migrationRecord(current.State) || current.State.Status !== 'created') throw migrationFailure();
        await requireMigrationAppStopped(docker, state, observed);
        await this.journal.record(saved.migrationId, 'start-intent', saved.containerId);
        try {
          await migrationEngineRequest(docker, `/containers/${saved.containerId}/start?`, 'POST', {}, signal);
        } catch {
          /* Never issue a second start: inspect/wait the same owned process. */
        }
      } else if (saved.phase !== 'start-intent') throw migrationFailure();
      try {
        await migrationEngineRequest(docker, `/containers/${saved.containerId}/wait?`, 'POST', { condition: 'not-running' }, signal);
      } catch {
        const cleanup = AbortSignal.timeout(30_000);
        const beforeKill = await inspectMigrationContainer(docker, saved.containerId, cleanup);
        if (!beforeKill) throw migrationFailure();
        exact(beforeKill, expected, state, saved, plan.definition);
        if (!migrationStopped(beforeKill.State))
          await migrationEngineRequest(docker, `/containers/${saved.containerId}/kill?`, 'POST', { signal: 'KILL' }, cleanup).catch(() => undefined);
      }
      const terminal = await inspectMigrationContainer(docker, saved.containerId, AbortSignal.timeout(30_000));
      if (!terminal) throw migrationFailure();
      exact(terminal, expected, state, saved, plan.definition);
      const end = terminal.State;
      if (
        !migrationStopped(end) ||
        !migrationRecord(end) ||
        end.Status !== 'exited' ||
        typeof end.StartedAt !== 'string' ||
        end.StartedAt.startsWith('0001-') ||
        typeof end.FinishedAt !== 'string' ||
        end.FinishedAt.startsWith('0001-') ||
        end.Error !== '' ||
        !Number.isInteger(end.ExitCode) ||
        Number(end.ExitCode) < 0 ||
        Number(end.ExitCode) > 255
      )
        throw migrationFailure();
      await this.journal.record(saved.migrationId, 'terminal', saved.containerId, Number(end.ExitCode), terminalHash(terminal));
      if (end.ExitCode !== 0 || signal.aborted) throw migrationFailure();
      await inventory(docker, await this.journal.read(), AbortSignal.timeout(30_000));
    });
  }
  toJSON(): never {
    throw migrationFailure();
  }
}
