import type Dockerode from 'dockerode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackupRequirementError } from './backup-files';
import { BackupRestoreJournal } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';
import { retainRestoreControllerOwnership } from './backup-restore-terminal-ownership';
import { restoreAuxiliaryContainerPlans } from './backup-restore-containers';
import { writeRestoreBootstrap } from './backup-restore-bootstrap';
import { BackupRestoreDockerRuntime, snapshotRestoreContainer, type RestoreRuntimeIdentity } from './backup-restore-runtime';
import { restoreTargetEnvironmentDigest, type RestorePreparationRuntime } from './backup-restore-preparation';
import { restoreTreeNames } from './backup-restore-materialize';
import type { BackupSourceSeal } from './backup-restore-source';

const failed = () => new BackupRequirementError('Restore preparation could not finish. Your server data and backup have been preserved.');
const neverStarted = (value: Dockerode.ContainerInspectInfo) =>
  !value.State.Running && !value.State.Restarting && !value.State.Paused && !value.RestartCount && Date.parse(value.State.StartedAt) <= 0;

async function unstartedAuxiliary(docker: Dockerode, id: string, role: string, ownership: { id: string; nonce: string; image: string }) {
  let value: Dockerode.ContainerInspectInfo;
  try {
    value = await docker.getContainer(id).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
  if (
    value.Id !== id ||
    value.Image !== ownership.image ||
    value.Config.Labels?.['io.orbis.restore'] !== ownership.id ||
    value.Config.Labels?.['io.orbis.restore.nonce'] !== ownership.nonce ||
    value.Config.Labels?.['io.orbis.restore.role'] !== role ||
    !neverStarted(value)
  )
    throw failed();
  return docker.getContainer(id);
}

// Only inert preparations can be discarded here. A started worker owns all transaction recovery.
export async function discardUnstartedRestoreHandoff(docker: Dockerode, journal: BackupRestoreJournal) {
  await withRestoreLease(path.dirname(journal.directory), async () => {
    const state = await journal.refresh();
    if (!['staging', 'discarded'].includes(state.phase) || !state.verifierController) throw failed();
    const original = await docker.getContainer(state.originalController).inspect();
    const ownership = { id: state.id, nonce: state.nonce, image: original.Image };
    const worker = await unstartedAuxiliary(docker, state.worker, 'worker', ownership);
    const verifier = await unstartedAuxiliary(docker, state.verifierController, 'verifier', ownership);
    // Close the worker's restart policy before settling the journal, including a retry after partial cleanup.
    if (worker) await worker.update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } });
    await journal.advance('discarded');
    if (verifier) await verifier.remove();
    if (worker) await worker.remove();
  });
}

export type RestoreHandoffOptions = {
  docker: Dockerode;
  controller: string;
  ownerId: number;
  connection: RestorePreparationRuntime['connection'];
  queue: RestoreRuntimeIdentity['queue'];
  apps: { id: string; project: string }[];
  directories: { data: string; appData: string; cache: string };
  signal: AbortSignal;
  claimReviewedSource: (
    journal: BackupRestoreJournal,
    accept: (source: { seal: BackupSourceSeal }, signal: AbortSignal) => Promise<void>,
  ) => Promise<void>;
};

export async function prepareRestoreHandoff(options: RestoreHandoffOptions) {
  const { docker, signal } = options;
  signal.throwIfAborted();
  if (!Number.isSafeInteger(options.ownerId) || options.ownerId <= 0 || options.apps.length > 1024) throw failed();
  const original = await docker.getContainer(options.controller).inspect();
  if (
    new Set(options.apps.map((app) => app.id)).size !== options.apps.length ||
    options.apps.some((app) => !/^[a-f0-9]{64}$/.test(app.id) || app.id === original.Id)
  )
    throw failed();
  const id = randomUUID();
  const nonce = randomUUID();
  const plans = restoreAuxiliaryContainerPlans(original, id, nonce);
  const environment = path.join(options.directories.data, '.env');
  const environmentSha256 = await restoreTargetEnvironmentDigest(environment, options);
  const apps: RestoreRuntimeIdentity['apps'] = [];
  for (const expected of options.apps) {
    signal.throwIfAborted();
    const value = await docker.getContainer(expected.id).inspect();
    if (
      value.Id !== expected.id ||
      !/^[a-zA-Z0-9_-]{1,255}$/.test(expected.project) ||
      value.Config.Labels?.['com.docker.compose.project'] !== expected.project ||
      value.State.Restarting ||
      value.State.Paused
    )
      throw failed();
    apps.push({ container: snapshotRestoreContainer(value), project: expected.project });
  }
  let verifier: Dockerode.Container | undefined;
  let worker: Dockerode.Container | undefined;
  let journal: BackupRestoreJournal | undefined;
  try {
    signal.throwIfAborted();
    verifier = await docker.createContainer(plans.verifier);
    worker = await docker.createContainer(plans.worker);
    const snapshot = snapshotRestoreContainer(original);
    const identity: RestoreRuntimeIdentity = {
      version: 1,
      id,
      nonce,
      image: original.Image,
      original: snapshot,
      candidate: snapshot,
      verifier: snapshotRestoreContainer(await verifier.inspect()),
      worker: snapshotRestoreContainer(await worker.inspect()),
      apps,
      queue: options.queue,
    };
    journal = await BackupRestoreJournal.create(path.join(options.directories.data, 'backups', 'restores'), {
      id,
      nonce,
      originalController: original.Id,
      candidateController: original.Id,
      verifierController: verifier.id,
      worker: worker.id,
      roots: [...restoreTreeNames],
    });
    await withRestoreLease(path.dirname(journal.directory), () =>
      retainRestoreControllerOwnership(journal as BackupRestoreJournal, original, {
        identity,
        connection: options.connection,
        database: options.connection.database,
      }),
    );
    const runtime = new BackupRestoreDockerRuntime(docker, journal, identity, options.directories);
    await runtime.verifyWorker(worker.id, { preparing: true });
    await runtime.preflightWriters();
    let accepted = false;
    // The import service owns disk/restore leases inside this callback; never reacquire either here.
    await options.claimReviewedSource(journal, async (source, claimedSignal) => {
      if (accepted) throw failed();
      claimedSignal.throwIfAborted();
      signal.throwIfAborted();
      if ((await restoreTargetEnvironmentDigest(environment, options)) !== environmentSha256) throw failed();
      await writeRestoreBootstrap(journal as BackupRestoreJournal, {
        version: 1,
        ownerId: options.ownerId,
        identity,
        connection: options.connection,
        source: source.seal,
        environmentSha256,
      });
      accepted = true;
    });
    signal.throwIfAborted();
    if (!accepted || (await restoreTargetEnvironmentDigest(environment, options)) !== environmentSha256) throw failed();
    await runtime.verifyWorker(worker.id, { preparing: true });
    await runtime.preflightWriters();
    for (const [handle, role] of [
      [worker, 'worker'],
      [verifier, 'verifier'],
    ] as const) {
      if (!(await unstartedAuxiliary(docker, handle.id, role, identity))) throw failed();
    }
    return { journal, identity };
  } catch (error) {
    for (const [role, plan] of [
      ['worker', plans.worker],
      ['verifier', plans.verifier],
    ] as const) {
      if ((role === 'worker' && worker) || (role === 'verifier' && verifier)) continue;
      try {
        const value = await docker.getContainer(plan.name as string).inspect();
        const owned = await unstartedAuxiliary(docker, value.Id, role, { id, nonce, image: original.Image });
        if (role === 'worker') worker = owned;
        else verifier = owned;
      } catch (inspectionError) {
        if ((inspectionError as { statusCode?: number }).statusCode !== 404) throw inspectionError;
      }
    }
    if (!journal && worker && verifier) {
      const active = await BackupRestoreJournal.active(path.join(options.directories.data, 'backups', 'restores'));
      if (active?.state.id === id && active.state.nonce === nonce) journal = active;
    }
    if (journal) await discardUnstartedRestoreHandoff(docker, journal);
    else {
      for (const [handle, role] of [
        [worker, 'worker'],
        [verifier, 'verifier'],
      ] as const) {
        if (!handle) continue;
        const owned = await unstartedAuxiliary(docker, handle.id, role, { id, nonce, image: original.Image });
        if (owned) await owned.remove();
      }
    }
    throw error;
  }
}
