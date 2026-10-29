import path from 'node:path';
import fs, { constants } from 'node:fs/promises';
import type Dockerode from 'dockerode';
import { BackupRestoreJournal, restoreControllerRetired } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';
import { readRestoreProgress } from './backup-restore-progress';
import { snapshotRestoreContainer } from './backup-restore-runtime';
import { verifyRestoreStorageMounts } from './backup-restore-storage';
import {
  readTerminalOwnership,
  readLatestTerminalPointer,
  retireTerminalControllers,
  terminalFailure,
  terminalPhase,
  writeTerminalJson,
  type TerminalOwnership,
} from './backup-restore-terminal-record';
import {
  inspectTerminalContainer,
  inspectTerminalImage,
  proveManagedController,
  proveTerminalRoots,
  retainRestoreControllerOwnership,
  terminalHash,
  cleanupTerminalWorkingTrees,
  terminalIdentity,
  type TerminalRecordedIdentity,
} from './backup-restore-terminal-ownership';

type Context = {
  docker: Dockerode;
  journal: BackupRestoreJournal;
  ownership: TerminalOwnership;
  recorded: TerminalRecordedIdentity;
  current: Dockerode.ContainerInspectInfo;
  signal: AbortSignal;
};
const stopped = (value: Dockerode.ContainerInspectInfo) => !value.State.Running && !value.State.Restarting && !value.State.Paused;
async function context(docker: Dockerode, journal: BackupRestoreJournal, controller: string, data: string, signal: AbortSignal): Promise<Context> {
  const state = await journal.refresh();
  if (!terminalPhase(state) || !state.verifierController) throw terminalFailure();
  if (await restoreControllerRetired(path.dirname(journal.directory), controller)) throw terminalFailure();
  let recorded = await terminalIdentity(journal);
  const progress = await readRestoreProgress(journal);
  if (
    (state.phase === 'completed' && progress?.status !== 'succeeded') ||
    (state.phase === 'rolled-back' && progress?.status !== 'rolled-back') ||
    (state.phase === 'discarded' && progress && progress.status !== 'rolled-back')
  )
    throw terminalFailure();
  if (state.phase === 'discarded' && !progress) {
    for (const id of [state.worker, state.verifierController]) {
      const auxiliary = id ? await inspectTerminalContainer(docker, id, signal) : undefined;
      if (
        auxiliary &&
        (auxiliary.State.Running ||
          auxiliary.State.Restarting ||
          auxiliary.State.Paused ||
          auxiliary.RestartCount ||
          !(Date.parse(auxiliary.State.StartedAt) <= 0))
      )
        throw terminalFailure();
    }
  }
  const current = await inspectTerminalContainer(docker, controller, signal);
  if (!current) throw terminalFailure();
  let ownership = await readTerminalOwnership(journal.directory, state);
  if (!ownership) {
    const original = await inspectTerminalContainer(docker, state.originalController, signal);
    if (!original) throw terminalFailure();
    const historical =
      snapshotRestoreContainer(original).fingerprint === recorded?.identity.original.fingerprint ? original : { ...original, Name: current.Name };
    if (snapshotRestoreContainer(historical).fingerprint !== recorded?.identity.original.fingerprint) throw terminalFailure();
    if (!recorded) throw terminalFailure();
    ownership = await retainRestoreControllerOwnership(journal, historical, recorded);
  }
  if (!recorded && state.phase === 'discarded')
    recorded = {
      identity: {
        image: ownership.image,
        original: { id: ownership.original, fingerprint: ownership.fingerprint },
        worker: ownership.worker,
        verifier: ownership.verifier,
        apps: ownership.apps.map((id) => ({ container: { id } })),
      },
      connection: ownership.connection,
      database: ownership.connection.database,
    };
  if (!recorded) throw terminalFailure();
  if (ownership.fingerprint !== recorded.identity.original.fingerprint || ownership.image !== recorded.identity.image) throw terminalFailure();
  await proveTerminalRoots(journal, ownership);
  await proveManagedController(docker, current, ownership, controller, data, recorded.connection, recorded.database, signal);
  return { docker, journal, ownership, recorded, current, signal };
}
async function auxiliary(c: Context, role: 'worker' | 'verifier') {
  const { state } = c.journal;
  const id = role === 'worker' ? state.worker : state.verifierController;
  const snapshot = role === 'worker' ? c.recorded.identity.worker : c.recorded.identity.verifier;
  const protectedIds = [
    state.originalController,
    state.candidateController,
    c.current.Id,
    ...c.recorded.identity.apps.map((app) => app.container.id),
  ];
  if (!id || protectedIds.includes(id)) throw terminalFailure();
  const value = await inspectTerminalContainer(c.docker, id, c.signal);
  if (!value) return undefined;
  if (!snapshot || snapshot.id !== id) throw terminalFailure();
  const h = value.HostConfig;
  const config = value.Config;
  const image = await inspectTerminalImage(c.docker, c.recorded.identity.image, c.signal);
  const labels = {
    ...(image.Config?.Labels ?? {}),
    'io.orbis.restore': state.id,
    'io.orbis.restore.nonce': state.nonce,
    'io.orbis.restore.role': role,
    'traefik.enable': 'false',
  };
  const caps = (items: string[] | null | undefined) => (items ?? []).map((v) => v.toUpperCase().replace(/^CAP_/, '')).sort();
  if (
    value.Id !== id ||
    value.Image !== c.recorded.identity.image ||
    image.Id !== value.Image ||
    snapshotRestoreContainer(value).fingerprint !== snapshot.fingerprint ||
    !stopped(value) ||
    h.RestartPolicy?.Name !== 'no' ||
    (h.RestartPolicy.MaximumRetryCount ?? 0) !== 0 ||
    terminalHash(config.Labels ?? {}) !== terminalHash(labels) ||
    config.User !== '0' ||
    config.WorkingDir !== '/app' ||
    config.Tty ||
    config.OpenStdin ||
    config.AttachStdin ||
    terminalHash(config.Entrypoint) !== terminalHash(['node']) ||
    terminalHash(config.Cmd) !== terminalHash(role === 'worker' ? ['/app/restore-worker.mjs', state.id] : ['/app/main.mjs']) ||
    !h.ReadonlyRootfs ||
    h.Privileged ||
    h.AutoRemove ||
    h.PublishAllPorts ||
    Object.keys(h.PortBindings ?? {}).length ||
    h.NetworkMode !== c.ownership.mainNetwork ||
    h.PidMode === 'host' ||
    h.IpcMode === 'host' ||
    h.UsernsMode ||
    h.Devices?.length ||
    h.DeviceRequests?.length ||
    typeof h.Memory !== 'number' ||
    h.Memory <= 0 ||
    h.Memory > 1024 ** 3 ||
    !h.PidsLimit ||
    h.PidsLimit <= 0 ||
    h.PidsLimit > 256 ||
    terminalHash(caps(h.CapDrop)) !== terminalHash(['ALL']) ||
    terminalHash(caps(h.CapAdd)) !== terminalHash(role === 'worker' ? ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] : []) ||
    terminalHash(h.SecurityOpt ?? []) !== terminalHash(['no-new-privileges:true']) ||
    terminalHash(h.Tmpfs ?? {}) !== terminalHash({ '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' }) ||
    h.LogConfig?.Type !== 'none' ||
    Object.keys(h.LogConfig?.Config ?? {}).length ||
    terminalHash(Object.keys(value.NetworkSettings.Networks).sort()) !== terminalHash(c.ownership.networks)
  )
    throw terminalFailure();
  verifyRestoreStorageMounts(c.current.Mounts, value.Mounts, role);
  return value;
}
async function exclusiveControllers(c: Context, previous: string) {
  const allowed = new Set([c.current.Id, previous, c.journal.state.worker, c.journal.state.verifierController]);
  const rows = await c.docker.listContainers({ all: true, abortSignal: c.signal });
  if (rows.length > 4096) throw terminalFailure();
  const roots = [...Object.values(c.ownership.layout.roots), c.ownership.layout.environment, c.ownership.layout.cache];
  const apps = new Set(c.recorded.identity.apps.map((app) => app.container.id));
  const appData = c.ownership.layout.roots['app-data'];
  const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const row of rows) {
    if (allowed.has(row.Id)) continue;
    const value = await inspectTerminalContainer(c.docker, row.Id, c.signal);
    if (!value || value.Id !== row.Id) throw terminalFailure();
    for (const mount of value.Mounts) {
      if (mount.Type !== 'bind' || mount.RW === false || !roots.some((root) => overlap(mount.Source, root))) continue;
      const liveApp =
        apps.has(value.Id) &&
        mount.Source.startsWith(`${appData}/`) &&
        !path
          .relative(appData, mount.Source)
          .split(path.sep)
          .some((part) => part.startsWith('.orbis-restore-'));
      if (!liveApp) throw terminalFailure();
    }
  }
  if (previous !== c.current.Id) {
    const old = await inspectTerminalContainer(c.docker, previous, c.signal);
    if (old && !stopped(old)) throw terminalFailure();
  }
}
async function removeAuxiliaries(c: Context, previous: string) {
  await auxiliary(c, 'worker');
  await auxiliary(c, 'verifier');
  await exclusiveControllers(c, previous);
  for (const role of ['verifier', 'worker'] as const) {
    c.signal.throwIfAborted();
    await c.journal.refresh();
    await proveTerminalRoots(c.journal, c.ownership);
    const worker = await auxiliary(c, 'worker');
    const verifier = await auxiliary(c, 'verifier');
    await exclusiveControllers(c, previous);
    const selected = role === 'worker' ? worker : verifier;
    if (selected) {
      const current = await auxiliary(c, role);
      if (!current || current.Id !== selected.Id) continue;
      try {
        await c.docker.getContainer(current.Id).remove({ force: false, v: false });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw terminalFailure();
      }
    }
  }
}
async function releaseTerminalBarrier(c: Context, store: string, previous: string) {
  await readLatestTerminalPointer(store);
  await removeAuxiliaries(c, previous);
  await cleanupTerminalWorkingTrees(c.journal, c.ownership);
  await exclusiveControllers(c, previous);
  await c.journal.refresh();
  const state = c.journal.state;
  const survivor = state.phase === 'completed' ? state.candidateController : state.originalController;
  const removed = state.phase === 'completed' ? state.originalController : state.candidateController;
  if (removed !== survivor) await retireTerminalControllers(store, [removed]);
  await writeTerminalJson(path.join(store, 'latest-terminal.json'), { version: 1, id: state.id, nonce: state.nonce, phase: state.phase });
  await exclusiveControllers(c, previous);
  const file = path.join(store, 'active.json');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid()))
      throw terminalFailure();
    const pointer = JSON.parse(await handle.readFile('utf8'));
    if (Object.keys(pointer).sort().join(',') !== 'id,nonce' || pointer.id !== state.id || pointer.nonce !== state.nonce) throw terminalFailure();
    await c.journal.refresh();
    const current = await fs.lstat(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw terminalFailure();
    await fs.unlink(file);
    const parent = await fs.open(store, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle.close();
  }
}
export async function cleanupSettledRestoreAuxiliaries(options: {
  docker: Dockerode;
  store: string;
  controller: string;
  data: string;
  signal: AbortSignal;
}) {
  const active = await BackupRestoreJournal.active(options.store);
  if (!active) return;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10000)]);
  if (
    active.state.phase === 'discarded' &&
    active.state.originalController === active.state.candidateController &&
    !(await readTerminalOwnership(active.directory, active.state)) &&
    !(await terminalIdentity(active)) &&
    !(await readRestoreProgress(active))
  ) {
    const current = await inspectTerminalContainer(options.docker, options.controller, signal);
    const worker = await inspectTerminalContainer(options.docker, active.state.worker, signal);
    const verifier = active.state.verifierController
      ? await inspectTerminalContainer(options.docker, active.state.verifierController, signal)
      : undefined;
    let noRoots = true;
    for (const name of active.state.roots) {
      try {
        await fs.lstat(path.join(active.rootJournal(name), 'swap.json'));
        noRoots = false;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw terminalFailure();
      }
    }
    if (
      current?.Id === active.state.originalController &&
      current.Config.Hostname === options.controller &&
      !(await restoreControllerRetired(options.store, options.controller)) &&
      current.State.Running &&
      !current.State.Restarting &&
      !current.State.Paused &&
      !worker &&
      !verifier &&
      noRoots
    )
      return;
  }
  try {
    await withRestoreLease(options.store, async () => {
      const c = await context(options.docker, active, options.controller, options.data, signal);
      const previous = c.journal.state.phase === 'completed' ? c.journal.state.candidateController : c.journal.state.originalController;
      if (previous !== c.current.Id) throw terminalFailure();
      await releaseTerminalBarrier(c, options.store, previous);
    });
  } catch {
    throw terminalFailure();
  }
}
export async function finalizeTerminalRestoreBeforeStartup(options: {
  docker: Dockerode;
  store: string;
  controller: string;
  data: string;
  signal: AbortSignal;
}) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10000)]);
  try {
    return await withRestoreLease(options.store, async () => {
      const journal = await BackupRestoreJournal.active(options.store);
      if (!journal) return;
      const c = await context(options.docker, journal, options.controller, options.data, signal);
      const previous = journal.state.phase === 'completed' ? journal.state.candidateController : journal.state.originalController;
      await auxiliary(c, 'worker');
      await auxiliary(c, 'verifier');
      await exclusiveControllers(c, previous);
      await releaseTerminalBarrier(c, options.store, previous);
    });
  } catch {
    throw terminalFailure();
  }
}
