import path from 'node:path';
import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import { type } from 'arktype';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { BackupRestoreDockerRuntime, readRestoreOperation, snapshotRestoreContainer, snapshotRetainedRole } from './backup-restore-runtime';
import { restoreBootstrapSchema, type RestoreBootstrap } from './backup-restore-bootstrap';
import type { BackupRestoreJournal, RestoreJournal } from './backup-restore-journal';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { readTerminalJson } from './backup-restore-terminal-record';
import { readRetainedBoundRecord, retainedRootBindingSchema, type RetainedRootBinding } from './time-machine-retained-bootstrap';
import { verifyRetainedWorkerIdentity } from './time-machine-retained-worker-identity';
import { restoreTreeNames } from './backup-restore-materialize';

const fail = () => new Error('Retained restore context could not be verified.');
const same = (a: unknown, b: unknown) => canonicalPublicationJson(a) === canonicalPublicationJson(b);

/** Verify the root-issued coordinator before changing the local journal binding. */
export async function verifyRetainedRootWorker(options: { journal: BackupRestoreJournal; rootBinding: RetainedRootBinding; docker: Dockerode }) {
  const { journal, rootBinding, docker } = options;
  const bootstrapRecord = await readRetainedBoundRecord(path.join(journal.directory, 'bootstrap.json'));
  const bootstrap = restoreBootstrapSchema(bootstrapRecord.value);
  if (
    bootstrap instanceof type.errors ||
    bootstrap.identity.id !== rootBinding.restoreId ||
    bootstrap.identity.nonce !== rootBinding.nonce ||
    bootstrap.identity.original.id !== rootBinding.originalController
  )
    throw fail();
  const [original, worker, image] = await Promise.all([
    docker.getContainer(rootBinding.originalController).inspect(),
    docker.getContainer(rootBinding.workerId).inspect(),
    docker.getImage(bootstrap.identity.image).inspect(),
  ]);
  if (
    snapshotRestoreContainer(original).fingerprint !== bootstrap.identity.original.fingerprint ||
    original.Image !== bootstrap.identity.image ||
    image.Id !== bootstrap.identity.image ||
    !Array.isArray(image.Config?.Env)
  )
    throw fail();
  const snapshot = rootBinding.workerSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || !('Mounts' in snapshot) || !Array.isArray(snapshot.Mounts)) throw fail();
  const mounts: unknown[] = snapshot.Mounts;
  const sourceFor = (destination: string) => {
    const found = mounts.filter(
      (entry: unknown) => entry && typeof entry === 'object' && 'Destination' in entry && entry.Destination === destination,
    );
    if (found.length !== 1 || !found[0] || typeof found[0] !== 'object' || !('Source' in found[0]) || typeof found[0].Source !== 'string')
      throw fail();
    return found[0].Source;
  };
  await verifyRetainedWorkerIdentity({
    original,
    worker,
    rootSnapshot: snapshot,
    restoreId: rootBinding.restoreId,
    nonce: rootBinding.nonce,
    workerId: rootBinding.workerId,
    retainedSource: sourceFor(`/data/backups/restores/${rootBinding.restoreId}/retained`),
    payloadSource: sourceFor(`/data/backups/restores/${rootBinding.restoreId}/source/payload`),
    coordinatorImageEnv: image.Config.Env,
  });
}

/** rootBinding must come from a freshly authenticated root status, not the local record. */
export async function readRetainedRestoreContext(options: {
  journal: BackupRestoreJournal;
  rootBinding: RetainedRootBinding;
  expectedPointId: string;
  expectedRuntimeManifestSha256: string;
  ownerId: number;
  importId: string;
  docker: Dockerode;
  hostname: string;
  committed?: boolean;
  preserveLiveProxy?: boolean;
  directories: { data: string; appData: string; cache: string };
}) {
  const { journal, docker } = options;
  const state = await journal.refresh();
  const expectedRoots = restoreTreeNames.filter((name) => !options.preserveLiveProxy || name !== 'traefik');
  if (state.roots.length !== expectedRoots.length || state.roots.some((name) => !expectedRoots.includes(name as (typeof restoreTreeNames)[number])))
    throw fail();
  const record = await readTerminalJson(path.join(journal.directory, 'retained-binding.json'));
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join('\0') !== ['binding', 'oldState', 'version'].join('\0') ||
    !('version' in record) ||
    record.version !== 1 ||
    !('oldState' in record) ||
    !('binding' in record)
  )
    throw fail();
  const binding = retainedRootBindingSchema(record.binding);
  if (
    binding instanceof type.errors ||
    !same(binding, options.rootBinding) ||
    binding.pointId !== options.expectedPointId ||
    binding.restoreId !== state.id ||
    binding.nonce !== state.nonce ||
    binding.originalController !== state.originalController ||
    binding.candidateController !== state.candidateController ||
    binding.verifierController !== state.verifierController ||
    binding.workerId !== state.worker ||
    binding.migrationsPath !== `/data/backups/restores/${state.id}/retained/migrations`
  )
    throw fail();
  const old = record.oldState as RestoreJournal;
  const bootstrapRecord = await readRetainedBoundRecord(path.join(journal.directory, 'bootstrap.json'));
  const admissionRecord = await readRetainedBoundRecord(path.join(journal.directory, 'time-machine-admission.json'));
  const bootstrap = restoreBootstrapSchema(bootstrapRecord.value);
  const receipt = await readRetainedRestoreReceipt(journal);
  if (
    bootstrap instanceof type.errors ||
    !old ||
    old.id !== state.id ||
    old.nonce !== state.nonce ||
    old.originalController !== state.originalController ||
    old.candidateController !== old.originalController ||
    old.phase !== 'staging' ||
    old.decision !== null ||
    !same(old.roots, state.roots) ||
    binding.sourceBinding.originalJournalSha256 !== createHash('sha256').update(canonicalPublicationJson(old)).digest('hex') ||
    binding.sourceBinding.bootstrapSha256 !== bootstrapRecord.sha256 ||
    binding.sourceBinding.admissionSha256 !== admissionRecord.sha256 ||
    binding.sourceBinding.sourceSealSha256 !== createHash('sha256').update(canonicalPublicationJson(bootstrap.source)).digest('hex') ||
    binding.sourceBinding.legacyManifestSha256 !== bootstrap.source.manifest.sha256 ||
    binding.sourceBinding.runtimeManifestSha256 !== options.expectedRuntimeManifestSha256 ||
    bootstrap.ownerId !== options.ownerId ||
    bootstrap.identity.id !== old.id ||
    bootstrap.identity.nonce !== old.nonce ||
    bootstrap.identity.original.id !== old.originalController ||
    bootstrap.identity.candidate.id !== old.candidateController ||
    bootstrap.identity.verifier.id !== old.verifierController ||
    bootstrap.identity.worker?.id !== old.worker ||
    !receipt ||
    receipt.ownerId !== options.ownerId ||
    receipt.importId !== options.importId ||
    receipt.binding.pointId !== options.expectedPointId ||
    receipt.binding.manifestSha256 !== binding.sourceBinding.legacyManifestSha256
  )
    throw fail();
  const [original, candidate, verifier, worker, image] = await Promise.all([
    docker.getContainer(binding.originalController).inspect(),
    docker.getContainer(binding.candidateController).inspect(),
    docker.getContainer(binding.verifierController).inspect(),
    docker.getContainer(binding.workerId).inspect(),
    docker.getImage(bootstrap.identity.image).inspect(),
  ]);
  if (
    snapshotRetainedRole(original, state.id, 'original', options.committed === true).fingerprint !== bootstrap.identity.original.fingerprint ||
    original.Image !== bootstrap.identity.image ||
    image.Id !== bootstrap.identity.image ||
    !Array.isArray(image.Config?.Env)
  )
    throw fail();
  const rootSnapshot = binding.workerSnapshot;
  if (!rootSnapshot || typeof rootSnapshot !== 'object' || !('Mounts' in rootSnapshot) || !Array.isArray(rootSnapshot.Mounts)) throw fail();
  const migration = rootSnapshot.Mounts.filter(
    (entry: unknown) =>
      entry && typeof entry === 'object' && 'Destination' in entry && entry.Destination === `/data/backups/restores/${state.id}/retained`,
  );
  if (
    migration.length !== 1 ||
    !migration[0] ||
    typeof migration[0] !== 'object' ||
    !('Source' in migration[0]) ||
    typeof migration[0].Source !== 'string'
  )
    throw fail();
  const retainedSource = migration[0].Source;
  const payload = rootSnapshot.Mounts.filter(
    (entry: unknown) =>
      entry && typeof entry === 'object' && 'Destination' in entry && entry.Destination === `/data/backups/restores/${state.id}/source/payload`,
  );
  if (payload.length !== 1 || !payload[0] || typeof payload[0] !== 'object' || !('Source' in payload[0]) || typeof payload[0].Source !== 'string')
    throw fail();
  const payloadSource = payload[0].Source;
  let socketIdentity = '';
  const identity = {
    ...bootstrap.identity,
    candidate: snapshotRetainedRole(candidate, state.id, 'candidate', options.committed === true),
    verifier: snapshotRestoreContainer(verifier),
    worker: snapshotRestoreContainer(worker),
  };
  const operation = ['staging', 'preparing', 'discarded'].includes(state.phase) ? identity : await readRestoreOperation(journal);
  if (
    operation.image !== identity.image ||
    !same(operation.original, identity.original) ||
    !same(operation.apps, identity.apps) ||
    !same(operation.queue, identity.queue) ||
    operation.candidate.id !== identity.candidate.id ||
    operation.candidate.fingerprint !== identity.candidate.fingerprint ||
    operation.verifier.id !== identity.verifier.id ||
    operation.verifier.fingerprint !== identity.verifier.fingerprint ||
    operation.worker?.id !== identity.worker.id ||
    operation.worker.fingerprint !== identity.worker.fingerprint
  )
    throw fail();
  const runtime = new BackupRestoreDockerRuntime(docker, journal, operation, options.directories, {
    targetImage: binding.target.creationReference,
    committed: options.committed === true,
    preserveLiveProxy: options.preserveLiveProxy === true,
    verifyWorker: async (source, actual) => {
      const current = await verifyRetainedWorkerIdentity({
        original: source,
        worker: actual,
        rootSnapshot,
        restoreId: state.id,
        nonce: state.nonce,
        workerId: binding.workerId,
        retainedSource,
        payloadSource,
        coordinatorImageEnv: image.Config?.Env ?? [],
      });
      if (socketIdentity && socketIdentity !== current) throw fail();
      socketIdentity = current;
    },
  });
  await runtime.verifyWorker(options.hostname, { preparing: ['staging', 'preparing', 'discarded'].includes(state.phase) });
  const retainedBootstrap: RestoreBootstrap = { ...bootstrap, identity };
  return { bootstrap: retainedBootstrap, runtime, binding: structuredClone(binding), socketIdentity };
}
