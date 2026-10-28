import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type Dockerode from 'dockerode';
import dotenv from 'dotenv';
import { type } from 'arktype';
import { Connection } from 'rabbitmq-client';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { backupDockerExec } from './backup-docker-exec';
import { BackupRestoreJournal } from './backup-restore-journal';
import { verifyRestoreDatabase } from './backup-restore-database';
import type { RestoreRuntime } from './backup-restore-coordinator';
import { verifyRestoreFiles } from './backup-restore-files';
import { writeRestoreEnvironment } from './backup-restore-environment';
import { deriveRestoreStorageLayout, verifyRestoreStorageMounts } from './backup-restore-storage';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const text = type('string > 0 & string <= 4096').narrow((value) => !/[\r\n\0]/.test(value));
const restart = type({
  '+': 'reject',
  Name: "'no' | 'always' | 'unless-stopped' | 'on-failure'",
  MaximumRetryCount: 'number.integer >= 0 & number <= 1000000',
});
const snapshot = type({ '+': 'reject', id: digest, fingerprint: digest, running: 'boolean', restart });
export const restoreDatabaseConnectionSchema = type({
  '+': 'reject',
  host: text,
  port: 'number.integer > 0 & number <= 65535',
  user: text,
  password: 'string <= 4096',
  database: text,
});
const operationSchema = type({
  '+': 'reject',
  version: '1',
  id: uuid,
  nonce: uuid,
  image: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
  original: snapshot,
  candidate: snapshot,
  verifier: snapshot,
  'worker?': snapshot,
  resumeApps: type({
    '+': 'reject',
    id: 'number.integer > 0',
    appUrn: type('string <= 512').narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value)),
  })
    .array()
    .narrow(
      (items) =>
        items.length <= 1024 &&
        new Set(items.map((item) => item.id)).size === items.length &&
        new Set(items.map((item) => item.appUrn)).size === items.length,
    ),
  apps: type({ '+': 'reject', container: snapshot, project: type('string').narrow((value) => /^[a-zA-Z0-9_-]{1,255}$/.test(value)) })
    .array()
    .narrow((items) => items.length <= 1024),
  queue: type({ '+': 'reject', host: text, username: text, password: 'string <= 4096' }),
  database: type({
    '+': 'reject',
    connection: restoreDatabaseConnectionSchema,
    owner: type({ '+': 'reject', name: text, oid: 'number.integer > 0', marker: text }),
    counts: type({
      '+': 'reject',
      user: 'number.integer >= 0',
      app: 'number.integer >= 0',
      app_store: 'number.integer >= 0',
      link: 'number.integer >= 0',
    }),
  }),
  originalEnvSha256: digest,
  incomingEnvSha256: digest,
  files: type({
    '+': 'reject',
    bytes: 'number.integer >= 0 & number <= 67108864',
    sha256: digest,
    files: 'number.integer >= 0',
    directories: 'number.integer >= 0',
  }),
});
export type RestoreOperation = typeof operationSchema.infer;
export const restoreRuntimeIdentitySchema = operationSchema.pick(
  'version',
  'id',
  'nonce',
  'image',
  'original',
  'candidate',
  'verifier',
  'worker',
  'apps',
  'queue',
);
export type RestoreRuntimeIdentity = typeof restoreRuntimeIdentitySchema.infer;
type Snapshot = typeof snapshot.infer;
const failed = (runtimeCheck = 'runtime') =>
  Object.assign(new BackupRequirementError('The restore runtime could not be verified. Keep apps stopped and retry recovery.'), { runtimeCheck });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
export function snapshotRestoreContainer(container: Dockerode.ContainerInspectInfo): Snapshot {
  const { RestartPolicy: _restart, ...host } = container.HostConfig;
  const byDestination = (a: { Destination: string }, b: { Destination: string }) =>
    a.Destination < b.Destination ? -1 : a.Destination > b.Destination ? 1 : 0;
  const fingerprint = hash(
    JSON.stringify(
      canonical({
        id: container.Id,
        name: container.Name,
        image: container.Image,
        config: container.Config,
        host: { ...host, OomKillDisable: host.OomKillDisable === true },
        mounts: [...container.Mounts].sort(byDestination),
        // Docker leaves endpoint IDs empty until start; network membership is stable across start/stop.
        networks: Object.keys(container.NetworkSettings.Networks).sort(),
      }),
    ),
  );
  return {
    id: container.Id,
    fingerprint,
    running: container.State.Running,
    restart: {
      Name: (container.HostConfig.RestartPolicy?.Name || 'no') as Snapshot['restart']['Name'],
      MaximumRetryCount: container.HostConfig.RestartPolicy?.MaximumRetryCount ?? 0,
    },
  };
}

export function verifyRestoreVerifierMounts(original: Dockerode.ContainerInspectInfo, verifier: Dockerode.ContainerInspectInfo) {
  try {
    verifyRestoreStorageMounts(original.Mounts, verifier.Mounts, 'verifier');
  } catch {
    throw failed('verifier-mounts');
  }
}

async function readOwned(file: string, maximum = 1024 * 1024) {
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > maximum || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    return await input.readFile();
  } finally {
    await input.close();
  }
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function checkRestoreIdentity(journal: BackupRestoreJournal, value: RestoreRuntimeIdentity) {
  const state = await journal.refresh();
  if (
    value.id !== state.id ||
    value.nonce !== state.nonce ||
    value.original.id !== state.originalController ||
    value.candidate.id !== state.candidateController ||
    value.verifier.id !== state.verifierController ||
    (value.worker && value.worker.id !== state.worker)
  )
    throw failed();
  const ids = [state.worker, value.original.id, value.candidate.id, value.verifier.id, ...value.apps.map((app) => app.container.id)];
  const restartingOriginal = value.original.id === value.candidate.id;
  if (
    new Set(ids).size !== ids.length - (restartingOriginal ? 1 : 0) ||
    (restartingOriginal && JSON.stringify(canonical(value.original)) !== JSON.stringify(canonical(value.candidate)))
  )
    throw failed();
  return value;
}

export async function validateRestoreIdentity(journal: BackupRestoreJournal, input: unknown) {
  const value = restoreRuntimeIdentitySchema(input);
  if (value instanceof type.errors) throw failed();
  return checkRestoreIdentity(journal, value);
}

async function validateRestoreOperation(journal: BackupRestoreJournal, input: unknown) {
  const value = operationSchema(input);
  if (value instanceof type.errors) throw failed();
  await checkRestoreIdentity(journal, value);
  return value;
}

export async function readRestoreOperation(journal: BackupRestoreJournal) {
  await privateBackupDirectory(journal.directory);
  return validateRestoreOperation(journal, JSON.parse((await readOwned(path.join(journal.directory, 'runtime.json'))).toString('utf8')));
}

export async function writeRestoreOperation(journal: BackupRestoreJournal, operation: RestoreOperation) {
  await privateBackupDirectory(journal.directory);
  if (!['staging', 'preparing'].includes((await journal.refresh()).phase)) throw failed('preparation-phase');
  const value = await validateRestoreOperation(journal, operation);
  const temporary = path.join(journal.directory, `.${randomUUID()}.runtime`);
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.link(temporary, path.join(journal.directory, 'runtime.json'));
    await fs.rm(temporary);
    await syncDirectory(journal.directory);
    return await readRestoreOperation(journal);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class BackupRestoreDockerRuntime implements RestoreRuntime {
  private readonly data: string;
  private readonly cache: string;
  constructor(
    private readonly docker: Dockerode,
    private readonly journal: BackupRestoreJournal,
    private readonly operation: RestoreOperation | RestoreRuntimeIdentity,
    private readonly roots = { data: '/data', appData: '/app-data', cache: '/cache' },
  ) {
    this.data = roots.data;
    this.cache = roots.cache;
  }
  private preparedOperation(): RestoreOperation {
    if (!('database' in this.operation)) throw failed('not-prepared');
    return this.operation;
  }
  private async owned(record: Snapshot) {
    const inspect = await this.docker.getContainer(record.id).inspect();
    if (snapshotRestoreContainer(inspect).fingerprint !== record.fingerprint) throw failed('container-snapshot');
    const policy = inspect.HostConfig.RestartPolicy ?? { Name: 'no', MaximumRetryCount: 0 };
    if (
      (this.journal.state.phase === 'staging' ||
        (record.id === this.journal.state.worker && !['completed', 'rolled-back', 'discarded'].includes(this.journal.state.phase))) &&
      (policy.Name !== record.restart.Name || (policy.MaximumRetryCount ?? 0) !== record.restart.MaximumRetryCount)
    )
      throw failed('initial-restart-policy');
    const activePolicy =
      record.id === this.operation.candidate.id && this.journal.state.decision === 'commit' ? this.operation.original.restart : record.restart;
    if (policy.Name !== 'no' && (policy.Name !== activePolicy.Name || (policy.MaximumRetryCount ?? 0) !== activePolicy.MaximumRetryCount))
      throw failed('restart-policy');
    return inspect;
  }
  private async role(record: Snapshot, role: 'candidate' | 'verifier') {
    const inspect = await this.owned(record);
    const labels = inspect.Config.Labels;
    const env = new Map(
      (inspect.Config.Env ?? []).map((entry) => {
        const split = entry.indexOf('=');
        return [entry.slice(0, split), entry.slice(split + 1)];
      }),
    );
    // Restarting the original container preserves Compose ownership, proxy labels and network aliases for later OTA updates.
    const restartingOriginal = role === 'candidate' && record.id === this.operation.original.id;
    if (
      inspect.Image !== this.operation.image ||
      (!restartingOriginal &&
        (labels?.['io.orbis.restore'] !== this.operation.id ||
          labels['io.orbis.restore.nonce'] !== this.operation.nonce ||
          labels['io.orbis.restore.role'] !== role)) ||
      (role === 'verifier'
        ? env.get('ORBIS_INSTALLER_TRANSACTION') !== this.operation.id || env.get('ORBIS_INSTALLER_PHASE') !== 'hold'
        : env.has('ORBIS_INSTALLER_TRANSACTION') || env.has('ORBIS_INSTALLER_PHASE'))
    )
      throw failed();
    return inspect;
  }
  async verifyWorker(hostname: string, options: { preparing?: boolean } = {}) {
    const state = await this.journal.refresh();
    const worker = await this.docker.getContainer(hostname).inspect();
    if (
      worker.Id !== state.worker ||
      worker.Image !== this.operation.image ||
      worker.Config.Labels?.['io.orbis.restore'] !== state.id ||
      worker.Config.Labels?.['io.orbis.restore.nonce'] !== state.nonce ||
      worker.Config.Labels?.['io.orbis.restore.role'] !== 'worker'
    )
      throw failed('worker-identity');
    if (this.operation.worker) await this.owned(this.operation.worker);
    const original = await this.owned(this.operation.original);
    if (original.Image !== this.operation.image) throw failed('original-image');
    const candidate = await this.role(this.operation.candidate, 'candidate');
    const verifier = await this.role(this.operation.verifier, 'verifier');
    if (
      JSON.stringify(canonical(original.HostConfig.PortBindings ?? {})) !== JSON.stringify(canonical(candidate.HostConfig.PortBindings ?? {})) ||
      original.HostConfig.NetworkMode !== candidate.HostConfig.NetworkMode ||
      candidate.HostConfig.Privileged !== original.HostConfig.Privileged
    )
      throw failed('candidate-network');
    if (Object.keys(verifier.HostConfig.PortBindings ?? {}).length || verifier.HostConfig.NetworkMode === 'host' || verifier.HostConfig.Privileged)
      throw failed('verifier-network');
    if ([original, candidate, verifier].some((container) => container.HostConfig.AutoRemove)) throw failed('container-auto-remove');
    const mountIdentity = (mounts: Dockerode.ContainerInspectInfo['Mounts']) =>
      mounts
        .map((mount) => ({ type: mount.Type, source: mount.Source, destination: mount.Destination, rw: mount.RW }))
        .sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
    if (JSON.stringify(mountIdentity(original.Mounts)) !== JSON.stringify(mountIdentity(candidate.Mounts))) throw failed('candidate-mounts');
    try {
      verifyRestoreStorageMounts(original.Mounts, worker.Mounts, 'worker');
    } catch {
      throw failed('worker-mounts');
    }
    if (
      !worker.HostConfig.ReadonlyRootfs ||
      worker.HostConfig.Privileged ||
      worker.HostConfig.AutoRemove ||
      Object.keys(worker.HostConfig.PortBindings ?? {}).length ||
      worker.HostConfig.NetworkMode === 'host' ||
      worker.HostConfig.PidMode === 'host' ||
      worker.HostConfig.Devices?.length ||
      worker.HostConfig.DeviceRequests?.length
    )
      throw failed('worker-sandbox');
    if (options.preparing) {
      if (!['staging', 'preparing', 'discarded'].includes(state.phase)) throw failed('preparation-phase');
    } else await this.fileRoots();
    if (!verifier.HostConfig.ReadonlyRootfs) throw failed('verifier-filesystem');
    verifyRestoreVerifierMounts(original, verifier);
    if (verifier.HostConfig.Devices?.length || verifier.HostConfig.DeviceRequests?.length || verifier.HostConfig.PidMode === 'host')
      throw failed('verifier-devices');
    return worker.Id;
  }
  private async fileRoots() {
    const roots: Record<string, string> = {};
    for (const name of this.journal.state.roots) {
      const target =
        name === 'app-data'
          ? this.roots.appData
          : ['state', 'apps', 'repos', 'media', 'user-config', 'traefik'].includes(name)
            ? path.join(this.data, name)
            : undefined;
      const value = JSON.parse((await readOwned(path.join(this.journal.rootJournal(name), 'swap.json'), 64 * 1024 * 1024)).toString('utf8'));
      if (!target || value.root !== target || value.id !== this.operation.id) throw failed();
      roots[name] = target;
    }
    return roots;
  }
  private async stop(record: Snapshot, signal: AbortSignal) {
    signal.throwIfAborted();
    const container = this.docker.getContainer(record.id);
    const inspect = await this.owned(record);
    if (inspect.State.Paused) throw failed();
    await container.update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } });
    if (inspect.State.Running || inspect.State.Restarting) await container.stop({ t: 30 });
    const stopped = await this.owned(record);
    if (stopped.State.Running || stopped.State.Restarting || stopped.State.Paused) throw failed();
    signal.throwIfAborted();
  }
  private async idleQueues() {
    const queue = new Connection({
      hostname: this.operation.queue.host,
      username: this.operation.queue.username,
      password: this.operation.queue.password,
      connectionTimeout: 10_000,
    });
    queue.on('error', () => undefined);
    try {
      for (const name of ['app-events-queue', 'repo-queue', 'system-events-queue']) {
        const current = await queue.queueDeclare({ queue: name, durable: true, autoDelete: false });
        if (current.consumerCount || current.messageCount) throw failed();
      }
    } finally {
      await queue.close();
    }
  }
  async preflightWriters() {
    await this.noOtherWriters(true);
  }
  private async noOtherWriters(allowKnownRunning = false) {
    const original = await this.owned(this.operation.original);
    const layout = deriveRestoreStorageLayout(original.Mounts);
    const sources = [...Object.values(layout.roots), layout.environment, layout.cache];
    const known = new Set([
      this.journal.state.worker,
      this.operation.original.id,
      this.operation.candidate.id,
      this.operation.verifier.id,
      ...this.operation.apps.map((app) => app.container.id),
    ]);
    const allowedRunning = new Set([this.operation.original.id, this.operation.candidate.id, ...this.operation.apps.map((app) => app.container.id)]);
    for (const current of await this.docker.listContainers({ all: true })) {
      if (current.Id === this.journal.state.worker) continue;
      const inspect = await this.docker.getContainer(current.Id).inspect();
      const overlap = inspect.Mounts.some(
        (item) =>
          item.RW &&
          item.Type === 'bind' &&
          sources.some((source) => item.Source === source || item.Source.startsWith(`${source}/`) || source.startsWith(`${item.Source}/`)),
      );
      const active = inspect.State.Running || inspect.State.Restarting || inspect.State.Paused;
      if (overlap && (!known.has(inspect.Id) || (active && (!allowKnownRunning || !allowedRunning.has(inspect.Id))))) throw failed('other-writer');
    }
  }
  async stopWriters(signal: AbortSignal) {
    await this.stop(this.operation.verifier, signal);
    await this.stop(this.operation.candidate, signal);
    await this.stop(this.operation.original, signal);
    for (const app of this.operation.apps) await this.stop(app.container, signal);
    await this.noOtherWriters();
    if (this.journal.state.phase !== 'rolling-back') await this.idleQueues();
  }
  private async clearCache() {
    if ((await fs.realpath(this.cache)) !== path.resolve(this.cache)) throw failed();
    for (const name of ['cache.sqlite', 'cache.sqlite-wal', 'cache.sqlite-shm', 'cache.sqlite-journal']) {
      const file = path.join(this.cache, name);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw failed();
      await fs.rm(file);
    }
    await syncDirectory(this.cache);
  }
  private async environment(kind: 'original' | 'incoming') {
    const operation = this.preparedOperation();
    const bytes = await readOwned(path.join(this.journal.directory, `${kind}.env`));
    const expected = kind === 'original' ? operation.originalEnvSha256 : operation.incomingEnvSha256;
    if (hash(bytes) !== expected) throw failed();
    const env = dotenv.parse(bytes);
    const db = operation.database;
    if (
      env.POSTGRES_HOST !== db.connection.host ||
      env.POSTGRES_USERNAME !== db.connection.user ||
      env.POSTGRES_PASSWORD !== db.connection.password ||
      Number(env.POSTGRES_PORT ?? 5432) !== db.connection.port ||
      env.POSTGRES_DBNAME !== (kind === 'original' ? db.connection.database : db.owner.name)
    )
      throw failed();
    return bytes;
  }
  private async setEnvironment(kind: 'original' | 'incoming') {
    const state = await this.journal.refresh();
    const allowed = kind === 'incoming' ? ['promoting', 'verifying', 'committing', 'completed'] : ['rolling-back', 'rolled-back'];
    if (!allowed.includes(state.phase)) throw failed('environment-phase');
    const [original, incoming] = await Promise.all([this.environment('original'), this.environment('incoming')]);
    await writeRestoreEnvironment({
      file: path.join(this.data, '.env'),
      journal: path.join(this.journal.directory, 'environment-pointer.json'),
      id: state.id,
      nonce: state.nonce,
      original,
      incoming,
      target: kind,
    });
  }
  async installDatabasePointer(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.idleQueues();
    await this.clearCache();
    await this.setEnvironment('incoming');
  }
  private async health(record: Snapshot, phase: 'hold' | 'resume' | 'normal', signal: AbortSignal) {
    const deadline = Date.now() + (phase === 'resume' ? 20 * 60_000 : 90_000);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const inspect = await this.owned(record);
      if (!inspect.State.Running || inspect.State.Restarting || inspect.State.Paused) throw failed();
      let output = '';
      try {
        await backupDockerExec({
          container: this.docker.getContainer(record.id),
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
          maxOutputBytes: 8192,
          command: [
            'node',
            '--input-type=module',
            '-e',
            "const h=await fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(1500)});if(!h.ok)process.exit(2);const r=await fetch('http://127.0.0.1:3000/api/installation/status',{signal:AbortSignal.timeout(1500)});if(!r.ok)process.exit(3);console.log(JSON.stringify(await r.json()));",
          ],
          stdout: async (chunk) => {
            output += chunk.toString('utf8');
          },
        });
        const status = JSON.parse(output);
        if (
          status.schema !== 'orbis.installation-state.v1' ||
          status.phase !== phase ||
          status.transactionId !== (phase === 'normal' ? null : this.operation.id)
        )
          throw failed();
        return;
      } catch {
        signal.throwIfAborted();
      }
      await delay(500, undefined, { signal });
    }
    throw failed();
  }
  async verify(signal: AbortSignal) {
    const operation = this.preparedOperation();
    const files = {
      ledger: path.join(this.journal.directory, 'applied-files.ndjson'),
      expected: operation.files,
      roots: await this.fileRoots(),
      signal,
    };
    await verifyRestoreFiles(files);
    await verifyRestoreDatabase({ id: operation.id, nonce: operation.nonce, ...operation.database, signal });
    await this.role(this.operation.verifier, 'verifier');
    const before = hash(await readOwned(path.join(this.data, '.env')));
    const container = this.docker.getContainer(this.operation.verifier.id);
    try {
      await container.start();
      await this.health(this.operation.verifier, 'hold', signal);
    } finally {
      await this.stop(this.operation.verifier, new AbortController().signal);
    }
    if (hash(await readOwned(path.join(this.data, '.env'))) !== before) throw failed();
    await this.idleQueues();
    await verifyRestoreDatabase({ id: operation.id, nonce: operation.nonce, ...operation.database, signal });
    await verifyRestoreFiles(files);
  }
  async activate() {
    this.preparedOperation();
    const current = await this.role(this.operation.candidate, 'candidate');
    if (!current.State.Running) await this.clearCache();
    const container = this.docker.getContainer(current.Id);
    await container.update({ RestartPolicy: this.operation.original.restart });
    if (!current.State.Running) await container.start();
    await this.health(this.operation.candidate, 'resume', AbortSignal.timeout(20 * 60_000));
  }
  async restoreDatabasePointer() {
    await this.setEnvironment('original');
    await this.clearCache();
  }
  async resumeOriginal() {
    for (const record of [...this.operation.apps.map((app) => app.container), this.operation.original]) {
      const current = await this.owned(record);
      const container = this.docker.getContainer(record.id);
      await container.update({ RestartPolicy: record.restart });
      if (record.running && !current.State.Running) await container.start();
    }
    await this.health(this.operation.original, 'normal', AbortSignal.timeout(120_000));
  }
}
