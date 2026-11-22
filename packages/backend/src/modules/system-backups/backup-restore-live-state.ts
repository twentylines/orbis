import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { AppUrn } from '@runtipi/common/types';
import { parseRestoreMounts } from '../backups/restore-mounts';
import { installRequestDirectory } from '../app-lifecycle/install-request-receipt';
import type { BackupRestoreJournal, RestoreJournal } from './backup-restore-journal';
import { BackupRequirementError } from './backup-files';

export const restoreStateFailure = () =>
  Object.assign(new BackupRequirementError('Live app install recovery storage could not be verified. Keep apps stopped and retry recovery.'), {
    runtimeCheck: 'live-install-state',
  });

export const restoreInstallHeld = () =>
  Object.assign(new BackupRequirementError('An app scheduled to restart has unfinished install recovery. Review the app install before retrying.'), {
    runtimeCheck: 'live-install-hold',
  });

export function restoreProjectUrns(project: string) {
  // The old runtime records use an ambiguous underscore separator.
  const urns = [...project.matchAll(/_/g)]
    .filter(({ index }) => index > 0 && index < project.length - 1)
    .map(({ index }) => createAppUrn(project.slice(0, index), project.slice(index + 1)));
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(project) || !urns.length) throw restoreStateFailure();
  return urns;
}

export function restoreStateBind(container: Dockerode.ContainerInspectInfo) {
  const mounts = container.Mounts.filter(({ Destination }) => Destination === '/data' || Destination === '/data/state');
  const mount = mounts.find(({ Destination }) => Destination === '/data/state') ?? mounts[0];
  if (
    !mount ||
    new Set(mounts.map(({ Destination }) => Destination)).size !== mounts.length ||
    mount.Type !== 'bind' ||
    !mount.RW ||
    !mount.Source.startsWith('/') ||
    mount.Source === '/' ||
    mount.Source !== path.posix.resolve(mount.Source) ||
    !['', 'private', 'rprivate'].includes(mount.Propagation ?? '') ||
    container.Mounts.some(({ Destination }) => Destination.startsWith('/data/state/')) ||
    Object.keys(container.HostConfig.Tmpfs ?? {}).some((target) => ['/data', '/data/state'].includes(target) || target.startsWith('/data/state/'))
  )
    throw restoreStateFailure();
  return { target: mount.Destination, source: mount.Destination === '/data' ? path.posix.join(mount.Source, 'state') : mount.Source };
}

const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
const owner = (stat: BigIntStats) => process.geteuid !== undefined && stat.uid === BigInt(process.geteuid());
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function mountId(fd: number) {
  const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
  const ids = [...info.matchAll(/^mnt_id:[ \t]+(\d+)$/gm)];
  if (info.length > 4096 || ids.length !== 1) throw restoreStateFailure();
  return ids[0]?.[1];
}

type PinnedDirectory = { fd: number; named: string; reference: string; stat: BigIntStats };

function readRecord(parent: PinnedDirectory, name: string, limit: number) {
  const named = path.join(parent.reference, name);
  const fd = fs.openSync(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.mode & 0o077n || !owner(before) || before.size > BigInt(limit)) throw restoreStateFailure();
    const bytes = fs.readFileSync(fd);
    if (
      BigInt(bytes.byteLength) !== before.size ||
      identity(fs.fstatSync(fd, { bigint: true })) !== identity(before) ||
      identity(fs.lstatSync(named, { bigint: true })) !== identity(before)
    )
      throw restoreStateFailure();
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export type RestoreStateIdentity = { value?: string };
export type RestoreMutation = 'start' | { Name: string; MaximumRetryCount: number };

type EngineRequest = { path: string; method: string; socketPath?: string; agent?: unknown; maxRedirects?: number };
type EngineReply = (error: unknown, result?: unknown) => void;
type ResumeModem = {
  protocol: string;
  version?: string;
  buildRequest: (options: EngineRequest, context: unknown, body: unknown, reply: EngineReply) => void;
};

/** Scope the hook to one container request. Modem resolves the Unix socket before calling buildRequest. */
export async function dispatchRestoreMutation(
  docker: Dockerode,
  id: string,
  mutation: RestoreMutation,
  verifyAndDispatch: (dispatch: () => void) => void,
) {
  const container = docker.getContainer(id);
  const modem = docker.modem as unknown as ResumeModem;
  if (!modem || container.modem !== modem || modem.protocol !== 'http' || typeof modem.buildRequest !== 'function') throw restoreStateFailure();
  const scopedModem: ResumeModem = Object.create(modem);
  const scopedContainer: Dockerode.Container = Object.create(container);
  scopedContainer.modem = scopedModem;
  const expectedPath = `${modem.version ? `/${modem.version}` : ''}/containers/${id}/${mutation === 'start' ? 'start' : 'update'}`;
  const expectedBody = mutation === 'start' ? undefined : JSON.stringify({ RestartPolicy: mutation });
  const buildRequest = modem.buildRequest;
  let dispatched = false;
  scopedModem.buildRequest = function (options, context, body, reply) {
    try {
      if (
        dispatched ||
        options.method !== 'POST' ||
        options.path !== expectedPath ||
        options.socketPath !== '/var/run/docker.sock' ||
        options.agent ||
        body !== expectedBody
      )
        throw restoreStateFailure();
      verifyAndDispatch(() => {
        dispatched = true;
        // docker-modem's HTTP wrapper otherwise follows redirects outside this
        // checked Unix request. Keep refusal local to the original callback.
        buildRequest.call(this, { ...options, maxRedirects: 0 }, context, body, reply);
      });
    } catch (error) {
      // Modem calls this from a promise continuation, so report refusal through Dockerode's callback.
      reply(error);
    }
  };
  if (mutation === 'start') await scopedContainer.start();
  else await scopedContainer.update({ RestartPolicy: mutation });
  if (!dispatched) throw restoreStateFailure();
}

/** Runs the dispatch in the same turn as the final check, while the checked directory descriptors remain open. */
export function withVerifiedRestoreState<T>(options: {
  data: string;
  journal: BackupRestoreJournal;
  state: Readonly<RestoreJournal>;
  mount: string;
  urns: readonly AppUrn[];
  unpreparedIdentity?: RestoreStateIdentity;
  standaloneCandidate?: boolean;
  effect: (held: boolean) => T;
}): T {
  const { data, journal, state, mount, urns, effect } = options;
  const pinned: PinnedDirectory[] = [];
  const absent: string[] = [];
  const pin = (named: string, parent?: PinnedDirectory, mode?: 'private' | 'state', optional = false) => {
    const reference = parent ? path.join(parent.reference, path.basename(named)) : named;
    let fd: number;
    try {
      fd = fs.openSync(reference, directoryFlags);
    } catch (error) {
      if (!optional || !missing(error)) throw error;
      absent.push(named);
      return undefined;
    }
    let stat: BigIntStats;
    try {
      stat = fs.fstatSync(fd, { bigint: true });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    const result = { fd, named, stat, reference: process.platform === 'linux' ? `/proc/self/fd/${fd}` : named };
    pinned.push(result);
    if ((mode && (!owner(stat) || stat.mode & (mode === 'private' ? 0o077n : 0o022n))) || stat.nlink === 0n) throw restoreStateFailure();
    return result;
  };
  const required = (named: string, parent?: PinnedDirectory, mode?: 'private' | 'state') => {
    const directory = pin(named, parent, mode);
    if (!directory) throw restoreStateFailure();
    return directory;
  };
  let held = false;
  let unpreparedIdentity: string | undefined;
  try {
    if (!state.roots.includes('state') || !['/data', '/data/state'].includes(mount) || fs.realpathSync(data) !== data) throw restoreStateFailure();
    const dataDir = required(data);
    const stateDir = required(path.join(data, 'state'), dataDir, 'state');
    const mountsBefore = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    const destinations = parseRestoreMounts(mountsBefore);
    const stateMount = mountId(stateDir.fd);
    if (
      destinations.filter((name) => name === mount).length !== 1 ||
      destinations.some((name) => (mount === '/data' && name === '/data/state') || name.startsWith('/data/state/')) ||
      !mountsBefore.split('\n').some((line) => {
        const fields = line.split(' ');
        return fields[0] === stateMount && fields[4] === mount && fields[5]?.split(',').includes('rw');
      })
    )
      throw restoreStateFailure();
    const backups = required(path.join(data, 'backups'), dataDir);
    const store = required(path.join(backups.named, 'restores'), backups, 'private');
    if (journal.directory !== path.join(store.named, state.id)) throw restoreStateFailure();
    const transaction = required(journal.directory, store, 'private');
    if (options.standaloneCandidate) absent.push(path.join(transaction.named, 'retained-root-request.json'));
    const roots = required(path.join(transaction.named, 'roots'), transaction, 'private');
    const statePlan = pin(journal.rootJournal('state'), roots, 'private', !!options.unpreparedIdentity);
    if (statePlan) {
      try {
        const swap = readRecord(statePlan, 'swap.json', 64 * 1024 * 1024);
        if (
          swap?.version !== 1 ||
          'mode' in swap ||
          swap.id !== state.id ||
          swap.root !== stateDir.named ||
          swap.phase !== (state.decision === 'commit' ? 'committed' : 'rolled-back') ||
          swap.device !== String(stateDir.stat.dev) ||
          swap.inode !== String(stateDir.stat.ino)
        )
          throw restoreStateFailure();
      } catch (error) {
        if (!options.unpreparedIdentity || !missing(error)) throw error;
        absent.push(path.join(statePlan.named, 'swap.json'));
      }
    }
    if (options.unpreparedIdentity) {
      // Discard can predate the durable swap plan. Keep the first verified directory
      // identity for this replay, even when later guards observe a clear receipt store.
      unpreparedIdentity = [dataDir.stat.dev, dataDir.stat.ino, stateDir.stat.dev, stateDir.stat.ino, stateDir.stat.birthtimeNs, stateMount].join(
        ':',
      );
      if (options.unpreparedIdentity.value !== undefined && options.unpreparedIdentity.value !== unpreparedIdentity) throw restoreStateFailure();
    }
    const namespace = pin(path.join(stateDir.named, 'orbis-install-requests'), stateDir, 'private', true);
    if (namespace) {
      if (mountId(namespace.fd) !== stateMount) throw restoreStateFailure();
      for (const urn of new Set(urns)) {
        const receipt = pin(installRequestDirectory(data, urn), namespace, 'private', true);
        if (!receipt) continue;
        if (mountId(receipt.fd) !== stateMount) throw restoreStateFailure();
        const children = fs.opendirSync(receipt.reference);
        try {
          held = children.readSync() !== null || held;
        } finally {
          children.closeSync();
        }
      }
    }
    const active = readRecord(store, 'active.json', 16 * 1024);
    const current = readRecord(transaction, 'restore.json', 16 * 1024);
    if (active?.id !== state.id || active?.nonce !== state.nonce || JSON.stringify(current) !== JSON.stringify(state)) throw restoreStateFailure();

    // A rename, mount shadow or late write must invalidate the observation.
    if (fs.readFileSync('/proc/self/mountinfo', 'utf8') !== mountsBefore) throw restoreStateFailure();
    for (const named of absent) {
      try {
        fs.lstatSync(named);
        throw restoreStateFailure();
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    for (const entry of pinned) {
      const expected = identity(entry.stat);
      if (identity(fs.fstatSync(entry.fd, { bigint: true })) !== expected || identity(fs.lstatSync(entry.named, { bigint: true })) !== expected)
        throw restoreStateFailure();
    }
  } catch {
    for (const { fd } of pinned.reverse()) fs.closeSync(fd);
    throw restoreStateFailure();
  }
  try {
    if (options.unpreparedIdentity) options.unpreparedIdentity.value = unpreparedIdentity;
    return effect(held);
  } finally {
    for (const { fd } of pinned.reverse()) fs.closeSync(fd);
  }
}
