import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import dotenv from 'dotenv';
import { type } from 'arktype';
import { BackupDirectorySwap } from './backup-directory-swap';
import type { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreBootstrap } from './backup-restore-bootstrap';
import { readRestoreOperation, snapshotRestoreContainer, restoreRootPlanMatchesPolicy } from './backup-restore-runtime';
import { deriveRestoreStorageLayout } from './backup-restore-storage';
import {
  terminalFailure,
  terminalOwnershipSchema,
  readTerminalJson,
  readTerminalOwnership,
  writeTerminalJson,
  type TerminalOwnership,
} from './backup-restore-terminal-record';

export function terminalHash(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function mountBinding(value: Dockerode.ContainerInspectInfo) {
  return terminalHash(
    value.Mounts.map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, writable: m.RW, propagation: m.Propagation ?? '' })).sort(
      (a, b) => a.destination.localeCompare(b.destination),
    ),
  );
}
function securityBinding(value: Dockerode.ContainerInspectInfo) {
  const h = value.HostConfig;
  return terminalHash({
    privileged: h.Privileged === true,
    capAdd: (h.CapAdd ?? []).slice().sort(),
    capDrop: (h.CapDrop ?? []).slice().sort(),
    userns: h.UsernsMode ?? '',
    pid: h.PidMode ?? '',
    ipc: h.IpcMode ?? '',
    devices: h.Devices ?? [],
    deviceRequests: h.DeviceRequests ?? [],
    security: (h.SecurityOpt ?? []).slice().sort(),
    readonly: h.ReadonlyRootfs === true,
  });
}
export type TerminalRecordedIdentity = {
  identity: {
    image: string;
    original: { id: string; fingerprint: string };
    worker?: { id: string; fingerprint: string };
    verifier: { id: string; fingerprint: string };
    apps: { container: { id: string } }[];
  };
  connection: { host: string; port: number; user: string };
  database: string;
};
export function controllerOwnership(
  journal: BackupRestoreJournal,
  original: Dockerode.ContainerInspectInfo,
  recorded: TerminalRecordedIdentity,
): TerminalOwnership {
  const physical = deriveRestoreStorageLayout(original.Mounts);
  const root = path.dirname(physical.environment);
  const labels = original.Config.Labels ?? {};
  const files = (labels['com.docker.compose.project.config_files'] ?? '').split(',').sort();
  const networks = Object.keys(original.NetworkSettings.Networks).sort();
  const mode = original.HostConfig.NetworkMode;
  const mainNetwork = networks.includes(mode ?? '') ? mode : networks.find((name) => original.NetworkSettings.Networks[name]?.NetworkID === mode);
  const raw = {
    version: 1,
    id: journal.state.id,
    nonce: journal.state.nonce,
    original: original.Id,
    fingerprint: snapshotRestoreContainer(original).fingerprint,
    image: original.Image,
    name: original.Name,
    worker: recorded.identity.worker ? { id: recorded.identity.worker.id, fingerprint: recorded.identity.worker.fingerprint } : undefined,
    verifier: { id: recorded.identity.verifier.id, fingerprint: recorded.identity.verifier.fingerprint },
    apps: recorded.identity.apps.map((app) => app.container.id),
    connection: { host: recorded.connection.host, user: recorded.connection.user, port: recorded.connection.port, database: recorded.database },
    project: labels['com.docker.compose.project'],
    root,
    configFiles: files,
    layout: { roots: physical.roots, backups: physical.backups, logs: physical.logs, environment: physical.environment, cache: physical.cache },
    networks,
    mainNetwork,
    mountsHash: mountBinding(original),
    securityHash: securityBinding(original),
    workingDirectory: original.Config.WorkingDir || '/app',
    command: original.Config.Cmd ?? [],
    entrypoint: original.Config.Entrypoint ?? [],
    protocol: labels['io.orbis.installation-protocol'],
  };
  const value = terminalOwnershipSchema(raw);
  if (
    value instanceof type.errors ||
    original.Id !== journal.state.originalController ||
    labels['com.docker.compose.service'] !== 'runtipi' ||
    labels['com.docker.compose.oneoff']?.toLowerCase() !== 'false' ||
    labels['com.docker.compose.project.working_dir'] !== root ||
    !files.includes(path.join(root, 'docker-compose.yml'))
  )
    throw terminalFailure();
  return value;
}
export async function retainRestoreControllerOwnership(
  journal: BackupRestoreJournal,
  original: Dockerode.ContainerInspectInfo,
  metadata?: TerminalRecordedIdentity,
) {
  const recorded = metadata ?? (await terminalIdentity(journal));
  if (!recorded) throw terminalFailure();
  const value = controllerOwnership(journal, original, recorded);
  const existing = await readTerminalOwnership(journal.directory, journal.state);
  if (existing) {
    if (terminalHash(existing) !== terminalHash(value)) throw terminalFailure();
    return existing;
  }
  await writeTerminalJson(path.join(journal.directory, 'controller-ownership.json'), value, true);
  return value;
}
export async function terminalIdentity(journal: BackupRestoreJournal): Promise<TerminalRecordedIdentity | undefined> {
  try {
    const value = await readRestoreOperation(journal);
    return {
      identity: value,
      connection: value.database.connection,
      database: journal.state.phase === 'completed' ? value.database.owner.name : value.database.connection.database,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (journal.state.phase !== 'discarded' && journal.state.phase !== 'staging') throw terminalFailure();
    try {
      const value = await readRestoreBootstrap(journal);
      return { identity: value.identity, connection: value.connection, database: value.connection.database };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
const containerRoots = {
  state: '/data/state',
  apps: '/data/apps',
  repos: '/data/repos',
  media: '/data/media',
  'user-config': '/data/user-config',
  traefik: '/data/traefik',
  'app-data': '/app-data',
} as const;
export async function proveTerminalRoots(journal: BackupRestoreJournal, ownership: TerminalOwnership) {
  const expected = journal.state.phase === 'completed' ? 'committed' : 'rolled-back';
  const record = await terminalIdentity(journal);
  const preservedTraefik = !!record && 'preservedTraefik' in record.identity && record.identity.preservedTraefik === 1;
  const bootstrapDiscard = journal.state.phase === 'discarded' && !!record && !Object.hasOwn(record.identity, 'database');
  for (const name of journal.state.roots) {
    const source = ownership.layout.roots[name as keyof typeof ownership.layout.roots];
    const root = containerRoots[name as keyof typeof containerRoots];
    if (!source || !root) throw terminalFailure();
    const raw = (await readTerminalJson(path.join(journal.rootJournal(name), 'swap.json'), 64 * 1024 * 1024)) as
      | { id?: unknown; root?: unknown; phase?: unknown; version?: unknown }
      | undefined;
    if (!raw && journal.state.phase === 'discarded') continue;
    if (
      !raw ||
      raw.id !== journal.state.id ||
      raw.root !== root ||
      raw.phase !== expected ||
      !restoreRootPlanMatchesPolicy(name, raw, preservedTraefik || (bootstrapDiscard && name === 'traefik' && raw.version === 2))
    )
      throw terminalFailure();
    if (bootstrapDiscard && name === 'traefik' && raw.version === 2) {
      try {
        await fs.lstat(path.join(journal.rootJournal(name), 'incoming'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw terminalFailure();
        const wal = await fs.open(path.join(journal.rootJournal(name), 'moves.ndjson'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const ownerId = process.getuid?.();
          if (ownerId === undefined) throw terminalFailure();
          const before = await wal.stat();
          if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== ownerId || before.size !== 0) throw terminalFailure();
          if ((await wal.read(Buffer.alloc(1), 0, 1, 0)).bytesRead !== 0) throw terminalFailure();
          const after = await wal.stat();
          if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== 0 ||
            after.nlink !== 1 ||
            after.uid !== ownerId ||
            after.mode & 0o077 ||
            after.ctimeMs !== before.ctimeMs ||
            after.mtimeMs !== before.mtimeMs
          )
            throw terminalFailure();
        } finally {
          await wal.close();
        }
        const retained = await (await BackupDirectorySwap.open(journal.rootJournal(name))).retainedDirectories();
        if (retained.id !== journal.state.id || retained.root !== root || retained.directories.length) throw terminalFailure();
        continue;
      }
      throw terminalFailure();
    }
    const retained = await (await BackupDirectorySwap.open(journal.rootJournal(name))).retainedDirectories();
    if (retained.id !== journal.state.id || retained.root !== root) throw terminalFailure();
  }
}
export async function inspectTerminalContainer(docker: Dockerode, id: string, signal: AbortSignal) {
  try {
    return await docker.getContainer(id).inspect({ abortSignal: signal });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw terminalFailure();
  }
}
export async function proveManagedController(
  docker: Dockerode,
  current: Dockerode.ContainerInspectInfo,
  ownership: TerminalOwnership,
  controller: string,
  data: string,
  connection: { host: string; port: number; user: string },
  database: string,
  signal: AbortSignal,
) {
  const labels = current.Config.Labels ?? {};
  const layout = deriveRestoreStorageLayout(current.Mounts);
  const bound = { roots: layout.roots, backups: layout.backups, logs: layout.logs, environment: layout.environment, cache: layout.cache };
  if (
    !/^[a-f0-9]{12,64}$/.test(controller) ||
    !current.Id.startsWith(controller) ||
    current.Name !== ownership.name ||
    current.Config.Hostname !== controller ||
    !current.State.Running ||
    current.State.Restarting ||
    current.State.Paused ||
    current.HostConfig.Privileged ||
    current.HostConfig.AutoRemove ||
    current.HostConfig.PidMode === 'host' ||
    !['', '0', 'root'].includes(current.Config.User ?? '') ||
    current.Config.Env?.some((value) => value.startsWith('HOSTNAME=')) ||
    labels['com.docker.compose.project'] !== ownership.project ||
    labels['com.docker.compose.service'] !== 'runtipi' ||
    labels['com.docker.compose.oneoff']?.toLowerCase() !== 'false' ||
    labels['com.docker.compose.project.working_dir'] !== ownership.root ||
    terminalHash((labels['com.docker.compose.project.config_files'] ?? '').split(',').sort()) !== terminalHash(ownership.configFiles) ||
    terminalHash(bound) !== terminalHash(ownership.layout) ||
    mountBinding(current) !== ownership.mountsHash ||
    securityBinding(current) !== ownership.securityHash ||
    current.Config.WorkingDir !== ownership.workingDirectory ||
    terminalHash(Object.keys(current.NetworkSettings.Networks).sort()) !== terminalHash(ownership.networks) ||
    terminalHash(current.Config.Cmd ?? []) !== terminalHash(ownership.command) ||
    terminalHash(current.Config.Entrypoint ?? []) !== terminalHash(ownership.entrypoint) ||
    labels['io.orbis.installation-protocol'] !== ownership.protocol ||
    !current.Mounts.some(
      (m) =>
        m.Type === 'bind' &&
        m.Source === path.join(ownership.root, 'docker-compose.yml') &&
        m.Destination === '/data/docker-compose.yml' &&
        m.RW === false,
    )
  )
    throw terminalFailure();
  const image = await inspectTerminalImage(docker, current.Image, signal);
  if (image.Id !== current.Image || image.Config?.Labels?.['io.orbis.installation-protocol'] !== ownership.protocol) throw terminalFailure();
  const endpoint = current.NetworkSettings.Networks[ownership.mainNetwork];
  if (!endpoint || !/^[a-f0-9]{64}$/.test(endpoint.NetworkID) || !endpoint.EndpointID) throw terminalFailure();
  const network = await new Promise<Dockerode.NetworkInspectInfo>((resolve, reject) =>
    docker.modem.dial(
      {
        path: `/networks/${endpoint.NetworkID}`,
        method: 'GET',
        options: {},
        abortSignal: signal,
        statusCodes: { 200: true, 404: 'Network unavailable', 500: 'Network unavailable' },
      },
      (error, value) => (error ? reject(error) : resolve(value as Dockerode.NetworkInspectInfo)),
    ),
  );
  const member = network.Containers?.[current.Id];
  if (
    network.Id !== endpoint.NetworkID ||
    network.Driver !== 'bridge' ||
    network.Scope !== 'local' ||
    network.Labels?.['com.docker.compose.project'] !== ownership.project ||
    network.Labels?.['com.docker.compose.network'] !== 'tipi_main_network' ||
    member?.EndpointID !== endpoint.EndpointID ||
    member.IPv4Address?.split('/')[0] !== endpoint.IPAddress
  )
    throw terminalFailure();
  const handle = await fs.open(path.join(data, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw terminalFailure();
    const env = dotenv.parse(await handle.readFile('utf8'));
    if (
      env.ROOT_FOLDER_HOST !== ownership.root ||
      env.RUNTIPI_APP_DATA_PATH !== path.dirname(ownership.layout.roots['app-data']) ||
      env.POSTGRES_HOST !== connection.host ||
      env.POSTGRES_USERNAME !== connection.user ||
      Number(env.POSTGRES_PORT ?? 5432) !== connection.port ||
      env.POSTGRES_DBNAME !== database
    )
      throw terminalFailure();
  } finally {
    await handle.close();
  }
  return current;
}

export async function inspectTerminalImage(docker: Dockerode, id: string, signal: AbortSignal): Promise<Dockerode.ImageInspectInfo> {
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw terminalFailure();
  return new Promise((resolve, reject) =>
    docker.modem.dial(
      {
        path: `/images/${id}/json`,
        method: 'GET',
        options: {},
        abortSignal: signal,
        statusCodes: { 200: true, 404: 'Image unavailable', 500: 'Image unavailable' },
      },
      (error, value) => (error ? reject(terminalFailure()) : resolve(value as Dockerode.ImageInspectInfo)),
    ),
  );
}

export async function cleanupTerminalWorkingTrees(journal: BackupRestoreJournal, ownership: TerminalOwnership) {
  await proveTerminalRoots(journal, ownership);
  for (const name of journal.state.roots) {
    const raw = await readTerminalJson(path.join(journal.rootJournal(name), 'swap.json'), 64 * 1024 * 1024);
    if (raw === undefined && journal.state.phase === 'discarded') continue;
    await (await BackupDirectorySwap.open(journal.rootJournal(name))).cleanup();
  }
}
