import path from 'node:path';
import fs, { constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { type } from 'arktype';
import dotenv from 'dotenv';
import type Dockerode from 'dockerode';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { canonicalPublicationJson } from '@/modules/host-updates/host-controller-publication';
import { BackupRestoreJournal, restoreControllerRetired } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';
import { readRestoreProgress } from './backup-restore-progress';
import { readRestoreOperation, snapshotRestoreContainer } from './backup-restore-runtime';
import { verifyRestoreStorageMounts } from './backup-restore-storage';
import {
  readTerminalOwnership,
  readTerminalJson,
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
import { RetainedRootTransaction } from './time-machine-retained-root-client';
import { readRetainedBoundRecord } from './time-machine-retained-bootstrap';
import { restoreBootstrapSchema } from './backup-restore-bootstrap';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';

type Context = {
  docker: Dockerode;
  journal: BackupRestoreJournal;
  ownership: TerminalOwnership;
  recorded: TerminalRecordedIdentity;
  current: Dockerode.ContainerInspectInfo;
  signal: AbortSignal;
  verifiedRetained: boolean;
  revalidateRetained?: () => Promise<void>;
  terminalReceipt?: {
    version: 1;
    transactionId: string;
    pointId: string;
    proofSha256: string;
    nodeJournalSha256: string;
    operationSha256: string | null;
    decision: 'commit' | 'rollback';
    survivorId: string;
    databaseOid: number;
  };
  finalizeRetained?: () => Promise<void>;
};
const stopped = (value: Dockerode.ContainerInspectInfo) => !value.State.Running && !value.State.Restarting && !value.State.Paused;
async function settleProtectedStaging(options: {
  journal: BackupRestoreJournal;
  docker: Dockerode;
  controller: string;
  data: string;
  signal: AbortSignal;
}) {
  const { journal, docker, controller, data, signal } = options;
  const transaction = await RetainedRootTransaction.read(journal.directory);
  const proof = await transaction.terminalProof(signal);
  if (proof.nodePhase !== 'staging') return false;
  if (
    proof.state !== 'rolled-back' ||
    proof.decision !== 'rollback' ||
    proof.operationSha256 !== null ||
    !['idle', 'checking'].includes((await readRootRestorationState()) ?? '')
  )
    throw terminalFailure();
  const store = path.dirname(journal.directory);
  await withRestoreLease(store, async () => {
    const active = await BackupRestoreJournal.active(store);
    if (!active || active.state.id !== journal.state.id || !['staging', 'discarded'].includes(active.state.phase)) throw terminalFailure();
    const state = active.state;
    const staged = { ...state, phase: 'staging', decision: null };
    const bindingRecord = await readTerminalJson(path.join(active.directory, 'retained-binding.json'), 512 * 1024);
    let original = staged;
    if (proof.binding) {
      if (
        proof.binding.restoreId !== state.id ||
        proof.binding.nonce !== state.nonce ||
        proof.binding.originalController !== state.originalController
      )
        throw terminalFailure();
      if (bindingRecord === undefined) {
        if (state.candidateController !== state.originalController) throw terminalFailure();
      } else {
        if (
          !bindingRecord ||
          typeof bindingRecord !== 'object' ||
          Array.isArray(bindingRecord) ||
          Object.keys(bindingRecord).sort().join(',') !== 'binding,oldState,version' ||
          !('version' in bindingRecord) ||
          bindingRecord.version !== 1 ||
          !('oldState' in bindingRecord) ||
          !('binding' in bindingRecord) ||
          canonicalPublicationJson(bindingRecord.binding) !== canonicalPublicationJson(proof.binding)
        )
          throw terminalFailure();
        original = bindingRecord.oldState as typeof staged;
        if (
          proof.binding.candidateController !== state.candidateController ||
          proof.binding.workerId !== state.worker ||
          proof.binding.verifierController !== state.verifierController ||
          canonicalPublicationJson(original.roots) !== canonicalPublicationJson(state.roots)
        )
          throw terminalFailure();
      }
    } else if (bindingRecord !== undefined || state.candidateController !== state.originalController) throw terminalFailure();
    if (
      original.id !== state.id ||
      original.nonce !== state.nonce ||
      original.phase !== 'staging' ||
      original.decision !== null ||
      original.originalController !== state.originalController ||
      original.candidateController !== original.originalController ||
      createHash('sha256').update(canonicalPublicationJson(original)).digest('hex') !== proof.sourceBinding.originalJournalSha256
    )
      throw terminalFailure();
    if (
      !proof.retired.some((entry) => entry.role === 'provisional-worker' && entry.id === original.worker) ||
      !proof.retired.some((entry) => entry.role === 'provisional-verifier' && entry.id === original.verifierController)
    )
      throw terminalFailure();
    const journalRecord = await readRetainedBoundRecord(path.join(active.directory, 'restore.json'));
    if (
      createHash('sha256').update(JSON.stringify(staged)).digest('hex') !== proof.nodeJournalSha256 ||
      (state.phase === 'staging' && journalRecord.sha256 !== proof.nodeJournalSha256)
    )
      throw terminalFailure();
    const bootstrapRecord = await readRetainedBoundRecord(path.join(active.directory, 'bootstrap.json'));
    const bootstrap = restoreBootstrapSchema(bootstrapRecord.value);
    const admission = await readRetainedBoundRecord(path.join(active.directory, 'time-machine-admission.json'));
    const receipt = await readRetainedRestoreReceipt(active);
    if (
      bootstrap instanceof type.errors ||
      bootstrapRecord.sha256 !== proof.sourceBinding.bootstrapSha256 ||
      admission.sha256 !== proof.admissionSha256 ||
      !receipt ||
      receipt.binding.pointId !== proof.pointId ||
      bootstrap.identity.id !== state.id ||
      bootstrap.identity.nonce !== state.nonce ||
      bootstrap.identity.original.id !== original.originalController ||
      bootstrap.identity.candidate.id !== original.candidateController ||
      bootstrap.identity.worker?.id !== original.worker ||
      bootstrap.identity.verifier.id !== original.verifierController
    )
      throw terminalFailure();
    const current = await inspectTerminalContainer(docker, controller, signal);
    const connection = bootstrap.connection;
    const rootJson = canonicalPublicationJson(connection).replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    if (
      !current ||
      current.Id !== proof.survivor.id ||
      current.Id !== state.originalController ||
      current.Image !== proof.survivor.imageId ||
      !current.Id.startsWith(controller) ||
      current.Config.Hostname !== controller ||
      !current.State.Running ||
      current.State.Paused ||
      current.State.Restarting ||
      proof.database.name !== connection.database ||
      proof.database.user !== connection.user ||
      proof.database.connectionSha256 !== createHash('sha256').update(rootJson).digest('hex')
    )
      throw terminalFailure();
    const env = await fs.open(path.join(data, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await env.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.mode & 0o077 ||
        before.size > 1024 * 1024 ||
        (process.getuid && before.uid !== process.getuid())
      )
        throw terminalFailure();
      const bytes = await env.readFile();
      const after = await env.stat();
      const now = await fs.lstat(path.join(data, '.env'));
      const parsed = dotenv.parse(bytes);
      if (
        bytes.length !== before.size ||
        [after, now].some((stat) =>
          ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
        ) ||
        parsed.POSTGRES_HOST !== connection.host ||
        parsed.POSTGRES_USERNAME !== connection.user ||
        Number(parsed.POSTGRES_PORT ?? 5432) !== connection.port ||
        parsed.POSTGRES_DBNAME !== connection.database
      )
        throw terminalFailure();
    } finally {
      await env.close();
    }
    if (state.phase === 'staging') await active.advance('discarded');
    const result = {
      version: 1,
      transactionId: state.id,
      pointId: proof.pointId,
      proofSha256: proof.proofSha256,
      nodeJournalSha256: proof.nodeJournalSha256,
      operationSha256: null,
      decision: 'rollback',
      survivorId: proof.survivor.id,
      databaseOid: proof.database.oid,
    };
    const receiptFile = path.join(active.directory, 'retained-terminal-reconciliation.json');
    const prior = await readTerminalJson(receiptFile);
    if (prior === undefined) await writeTerminalJson(receiptFile, result, true);
    else if (canonicalPublicationJson(prior) !== canonicalPublicationJson(result)) throw terminalFailure();
    await writeTerminalJson(path.join(store, 'latest-terminal.json'), { version: 1, id: state.id, nonce: state.nonce, phase: 'discarded' });
    if (canonicalPublicationJson(await transaction.terminalProof(signal)) !== canonicalPublicationJson(proof)) throw terminalFailure();
    const pointerFile = path.join(store, 'active.json');
    const handle = await fs.open(pointerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > 4096 || (process.getuid && before.uid !== process.getuid()))
        throw terminalFailure();
      const pointer = JSON.parse(await handle.readFile('utf8'));
      const now = await fs.lstat(pointerFile);
      if (
        Object.keys(pointer).sort().join(',') !== 'id,nonce' ||
        pointer.id !== state.id ||
        pointer.nonce !== state.nonce ||
        now.dev !== before.dev ||
        now.ino !== before.ino
      )
        throw terminalFailure();
      await fs.unlink(pointerFile);
      const parent = await fs.open(store, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await handle.close();
    }
    await transaction.terminalFinalize(proof.proofSha256, signal);
  });
  return true;
}
async function context(docker: Dockerode, journal: BackupRestoreJournal, controller: string, data: string, signal: AbortSignal): Promise<Context> {
  const state = await journal.refresh();
  if (!terminalPhase(state) || !state.verifierController) throw terminalFailure();
  if (await restoreControllerRetired(path.dirname(journal.directory), controller)) throw terminalFailure();
  let recorded: TerminalRecordedIdentity | undefined;
  const retained = await readTerminalJson(path.join(journal.directory, 'retained-binding.json'), 512 * 1024);
  const progress = await readRestoreProgress(journal);
  if (
    (retained === undefined && state.phase === 'completed' && progress?.status !== 'succeeded') ||
    (retained === undefined && state.phase === 'rolled-back' && progress?.status !== 'rolled-back') ||
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
  let ownership: TerminalOwnership | undefined;
  let protectedTerminal = false;
  let revalidateRetained: (() => Promise<void>) | undefined;
  let terminalReceipt: Context['terminalReceipt'];
  let finalizeRetained: Context['finalizeRetained'];
  if (retained !== undefined) {
    if (
      !retained ||
      typeof retained !== 'object' ||
      Array.isArray(retained) ||
      Object.keys(retained).sort().join(',') !== 'binding,oldState,version' ||
      !('version' in retained) ||
      retained.version !== 1 ||
      !('oldState' in retained) ||
      !('binding' in retained)
    )
      throw terminalFailure();
    const old = retained.oldState as typeof state;
    const transaction = await RetainedRootTransaction.read(journal.directory);
    const proof = await transaction.terminalProof(signal);
    const status = proof;
    if (
      !['discarded', 'rolled-back', 'completed'].includes(state.phase) ||
      status.state !== (state.phase === 'completed' ? 'complete' : 'rolled-back') ||
      status.decision !== state.decision ||
      !status.binding ||
      !['idle', 'checking'].includes((await readRootRestorationState()) ?? '') ||
      canonicalPublicationJson(status.binding) !== canonicalPublicationJson(retained.binding) ||
      createHash('sha256').update(canonicalPublicationJson(old)).digest('hex') !== status.binding.sourceBinding.originalJournalSha256 ||
      old.id !== state.id ||
      old.nonce !== state.nonce ||
      old.phase !== 'staging' ||
      old.decision !== null ||
      old.originalController !== state.originalController ||
      old.candidateController !== old.originalController ||
      status.binding.restoreId !== state.id ||
      status.binding.nonce !== state.nonce ||
      status.binding.originalController !== state.originalController ||
      status.binding.candidateController !== state.candidateController ||
      status.binding.workerId !== state.worker ||
      status.binding.verifierController !== state.verifierController ||
      canonicalPublicationJson(old.roots) !== canonicalPublicationJson(state.roots)
    )
      throw terminalFailure();
    revalidateRetained = async () => {
      const fresh = await transaction.terminalProof(signal);
      const root = await readRootRestorationState();
      if (!(root === 'idle' || root === 'checking') || canonicalPublicationJson(fresh) !== canonicalPublicationJson(status)) throw terminalFailure();
    };
    const bootstrapRecord = await readRetainedBoundRecord(path.join(journal.directory, 'bootstrap.json'));
    const bootstrap = restoreBootstrapSchema(bootstrapRecord.value);
    if (
      bootstrap instanceof type.errors ||
      bootstrapRecord.sha256 !== status.binding.sourceBinding.bootstrapSha256 ||
      bootstrap.identity.id !== old.id ||
      bootstrap.identity.nonce !== old.nonce ||
      bootstrap.identity.original.id !== old.originalController ||
      bootstrap.identity.candidate.id !== old.candidateController ||
      bootstrap.identity.worker?.id !== old.worker ||
      bootstrap.identity.verifier.id !== old.verifierController
    )
      throw terminalFailure();
    {
      const journalRecord = await readRetainedBoundRecord(path.join(journal.directory, 'restore.json'));
      if (proof.nodePhase !== state.phase || proof.nodeJournalSha256 !== journalRecord.sha256) throw terminalFailure();
      const operation = proof.operationSha256 === null ? undefined : await readRestoreOperation(journal);
      if (operation) {
        const operationRecord = await readRetainedBoundRecord(path.join(journal.directory, 'runtime.json'));
        if (proof.operationSha256 !== operationRecord.sha256) throw terminalFailure();
      } else {
        if (state.phase !== 'discarded') throw terminalFailure();
        try {
          await fs.lstat(path.join(journal.directory, 'runtime.json'));
          throw terminalFailure();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const originalConnection = operation?.database.connection ?? bootstrap.connection;
      const expectedName = state.phase === 'completed' ? operation?.database.owner.name : originalConnection.database;
      if (!expectedName || (state.phase === 'completed' && !operation)) throw terminalFailure();
      recorded = { identity: operation ?? bootstrap.identity, connection: originalConnection, database: expectedName };
      const connection = { ...originalConnection, database: expectedName };
      const rootJson = canonicalPublicationJson(connection).replace(
        /[\u007f-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
      const requiredRetired = new Map([
        [state.phase === 'completed' ? 'previous' : 'candidate', state.phase === 'completed' ? state.originalController : state.candidateController],
        ['verifier', state.verifierController],
        ['coordinator', state.worker],
        ['provisional-worker', old.worker],
        ['provisional-verifier', old.verifierController],
      ]);
      if (
        proof.retired.length !== requiredRetired.size ||
        proof.retired.some((item) => requiredRetired.get(item.role) !== item.id) ||
        proof.survivor.id !== (state.phase === 'completed' ? state.candidateController : state.originalController) ||
        proof.survivor.id !== current.Id ||
        proof.survivor.imageId !== current.Image ||
        !current.Id.startsWith(controller) ||
        current.Config.Hostname !== controller ||
        !current.State.Running ||
        current.State.Paused ||
        current.State.Restarting ||
        proof.database.name !== expectedName ||
        proof.database.user !== connection.user ||
        proof.database.connectionSha256 !== createHash('sha256').update(rootJson).digest('hex') ||
        (state.phase === 'completed' &&
          (!operation || proof.database.oid !== operation.database.owner.oid || proof.database.marker !== operation.database.owner.marker))
      )
        throw terminalFailure();
      const env = await fs.open(path.join(data, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await env.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.mode & 0o077 ||
          before.size > 1024 * 1024 ||
          (process.getuid && before.uid !== process.getuid())
        )
          throw terminalFailure();
        const bytes = await env.readFile();
        const after = await env.stat();
        const currentEnv = await fs.lstat(path.join(data, '.env'));
        const parsed = dotenv.parse(bytes);
        if (
          bytes.length !== before.size ||
          [after, currentEnv].some((stat) =>
            ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
          ) ||
          parsed.POSTGRES_HOST !== connection.host ||
          parsed.POSTGRES_USERNAME !== connection.user ||
          Number(parsed.POSTGRES_PORT ?? 5432) !== connection.port ||
          parsed.POSTGRES_DBNAME !== expectedName
        )
          throw terminalFailure();
      } finally {
        await env.close();
      }
      protectedTerminal = true;
      terminalReceipt = {
        version: 1,
        transactionId: state.id,
        pointId: proof.pointId,
        proofSha256: proof.proofSha256,
        nodeJournalSha256: proof.nodeJournalSha256,
        operationSha256: proof.operationSha256,
        decision: proof.decision,
        survivorId: proof.survivor.id,
        databaseOid: proof.database.oid,
      };
      finalizeRetained = async () => {
        await transaction.terminalFinalize(proof.proofSha256, signal);
      };
    }
    ownership = await readTerminalOwnership(journal.directory, old);
    if (!ownership) throw terminalFailure();
  } else {
    recorded = await terminalIdentity(journal);
    ownership = await readTerminalOwnership(journal.directory, state);
  }
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
  await proveTerminalRoots(journal, ownership, retained === undefined ? undefined : recorded);
  if (!protectedTerminal) await proveManagedController(docker, current, ownership, controller, data, recorded.connection, recorded.database, signal);
  return {
    docker,
    journal,
    ownership,
    recorded,
    current,
    signal,
    verifiedRetained: retained !== undefined,
    revalidateRetained,
    terminalReceipt,
    finalizeRetained,
  };
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
    await proveTerminalRoots(c.journal, c.ownership, c.verifiedRetained ? c.recorded : undefined);
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
  await c.revalidateRetained?.();
  await readLatestTerminalPointer(store);
  await removeAuxiliaries(c, previous);
  await cleanupTerminalWorkingTrees(c.journal, c.ownership, c.verifiedRetained ? c.recorded : undefined);
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
    await c.revalidateRetained?.();
    if (c.terminalReceipt) {
      const receiptFile = path.join(c.journal.directory, 'retained-terminal-reconciliation.json');
      const prior = await readTerminalJson(receiptFile);
      if (prior === undefined) await writeTerminalJson(receiptFile, c.terminalReceipt, true);
      else if (canonicalPublicationJson(prior) !== canonicalPublicationJson(c.terminalReceipt)) throw terminalFailure();
    }
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
    await c.finalizeRetained?.();
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
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30000)]);
  if (!active) {
    if ((await readRootRestorationState()) !== 'checking') return;
    await withRestoreLease(options.store, async () => {
      if (await BackupRestoreJournal.active(options.store)) throw terminalFailure();
      const latest = await BackupRestoreJournal.latest(options.store);
      if (!latest) throw terminalFailure();
      const receipt = await readTerminalJson(path.join(latest.directory, 'retained-terminal-reconciliation.json'));
      const transaction = await RetainedRootTransaction.read(latest.directory);
      const proof = await transaction.terminalProof(signal);
      const expected = {
        version: 1,
        transactionId: latest.state.id,
        pointId: proof.pointId,
        proofSha256: proof.proofSha256,
        nodeJournalSha256: proof.nodeJournalSha256,
        operationSha256: proof.operationSha256,
        decision: proof.decision,
        survivorId: proof.survivor.id,
        databaseOid: proof.database.oid,
      };
      if (canonicalPublicationJson(receipt) !== canonicalPublicationJson(expected)) throw terminalFailure();
      await transaction.terminalFinalize(proof.proofSha256, signal);
    });
    return;
  }
  if (['staging', 'discarded'].includes(active.state.phase) && (await readRootRestorationState()) === 'checking') {
    try {
      await fs.lstat(path.join(active.directory, 'retained-root-request.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw terminalFailure();
    }
    if (await settleProtectedStaging({ journal: active, docker: options.docker, controller: options.controller, data: options.data, signal })) return;
  }
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
