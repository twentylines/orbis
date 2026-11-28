import { appUpdateSettingsSchema, type AppUpdateSettings } from '../apps/app-update-settings';
import { retainOrdinaryUpdateResult } from '../app-lifecycle/update-result';
import { ordinaryUpdateResultBinding } from '../apps/app-update-commit';
import { assertPackageLinks, portablePackageLink } from '../app-stores/app-package-links';
import { existingBaselineStateSchema } from '../apps/app-existing-baseline-schema';
import { verifyExistingAppBaseline, type ExistingAppBaseline } from './app-existing-storage';
import { migrationHash } from '../backups/app-migration-journal';
import { freshInstallResultBinding } from '../apps/app-fresh-commit';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import type { AppMigrationJournal } from '../backups/app-migration-journal';
import type { AppsRepository } from '../apps/apps.repository';
import { appMigrationLedgerSchema } from '../apps/app-migration-ledger';
import {
  readAppImagePins,
  encodeAppImagePins,
  writeAppImagePins,
  type AppImagePinSource,
  removeAppImagePins,
  appUpdateStorage as files,
  type AppImageUpdateGuard,
  type MetadataState,
  type PulledUpdateImages,
  type StagedAppImageUpdate,
  STAGED_UPDATE_DEFAULT_PLATFORM,
} from './app-image-pins';

const failed = () => new Error('This app update needs recovery. Its saved files and operation records were kept.');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const urn = type('string').narrow((value) => /^[a-z0-9][a-z0-9._-]{0,127}:[a-z0-9][a-z0-9._-]{0,127}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const absolute = type('string <= 4096').narrow((value) => path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value));
const identity = type({ dev: '0 <= number.integer <= 9007199254740991', ino: '0 <= number.integer <= 9007199254740991' }).onUndeclaredKey('reject');
const entry = type({
  name: type('string <= 512').narrow(
    (name) => name === '' || (!path.isAbsolute(name) && path.normalize(name) === name && !name.split('/').includes('..') && !/[\0\r\n\\]/.test(name)),
  ),
  directory: 'boolean',
  mode: '0 <= number.integer <= 511',
  uid: '0 <= number.integer <= 4294967295',
  gid: '0 <= number.integer <= 4294967295',
  'sha256?': hash,
  'bytes?': '0 <= number.integer <= 8388608',
  'symlink?': type('string').narrow(portablePackageLink),
})
  .onUndeclaredKey('reject')
  .narrow((value) =>
    value.directory ? value.sha256 === undefined && value.bytes === undefined : value.sha256 !== undefined && value.bytes !== undefined,
  );
const metadata = type({
  entries: entry.array().atLeastLength(1).atMostLength(4096),
  envSha256: hash.or('null'),
  envMode: type('0 <= number.integer <= 511').or('null'),
  envGid: type('0 <= number.integer <= 4294967295').or('null'),
}).onUndeclaredKey('reject');
const pulled = type({ activationSha256: hash, imageIds: { '[string]': 'string' } })
  .onUndeclaredKey('reject')
  .narrow((value) => files.validPulledImages(value));
const migrationId = type('string').narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value));
const contextSchema = type({
  'purpose?': "'fresh-install'",
  appId: 'number.integer > 0 & number <= 2147483647',
  appCreatedAt: '0 <= number.integer <= 2147483647',
  fromVersion: '0 <= number.integer <= 2147483647',
  toVersion: '0 <= number.integer <= 2147483647',
  requestInputSha256: hash,
  'settings?': appUpdateSettingsSchema,
  authoritySha256: hash,
  previousLedger: appMigrationLedgerSchema,
  targetMigrationIds: migrationId
    .array()
    .atMostLength(300)
    .narrow((ids) => new Set(ids).size === ids.length),
  updateStatus: "'running' | 'stopped'",
  originalContainers: type({
    id: hash,
    imageId: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
    service: type('string <= 128').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)),
    running: 'boolean',
    paused: 'boolean',
    restarting: 'boolean',
  })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(256),
})
  .onUndeclaredKey('reject')
  .narrow(
    (value) =>
      (value.settings === undefined || (value.purpose === undefined && value.settings.sourceSha256 === value.requestInputSha256)) &&
      new Set(value.originalContainers.map(({ id }) => id)).size === value.originalContainers.length &&
      (value.purpose === 'fresh-install'
        ? value.originalContainers.length === 0 &&
          value.fromVersion === value.toVersion &&
          !value.previousLedger.baselined &&
          value.previousLedger.migrationIds.length === 0
        : (value.updateStatus === 'running') === value.originalContainers.some((row) => row.running || row.paused || row.restarting)),
  );
export type AppUpdateContext = typeof contextSchema.infer;
const rollbackRuntime = type({
  phase: "'start-intent' | 'pause-intent' | 'verified'",
  startedAt: type('string > 0 & string <= 128').narrow((value) => !/[\0\r\n]/.test(value)),
  proofSha256: hash.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow((value) => (value.phase === 'verified') === (value.proofSha256 !== null));
export type RollbackRuntimeRecord = typeof rollbackRuntime.infer;
const rollbackSchema = type({
  operationSha256: hash,
  phase: "'retained' | 'settled'",
  runtime: type({ '[string]': rollbackRuntime }).narrow(
    (rows) => Object.keys(rows).length <= 256 && Object.keys(rows).every((id) => hash.allows(id)),
  ),
}).onUndeclaredKey('reject');
const volumeName = type('string > 0 & string <= 255').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value));
const freshContainer = type({
  id: hash,
  imageId: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
  active: 'boolean',
  service: type('string > 0 & string <= 128').narrow((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)),
  mountsSha256: hash,
}).onUndeclaredKey('reject');
const freshPreparationSchema = type({
  appId: 'number.integer > 0 & number <= 2147483647',
  appCreatedAt: '0 <= number.integer <= 2147483647',
  version: '0 <= number.integer <= 2147483647',
  requestInputSha256: hash,
  storageSha256: hash,
  initialVolumes: volumeName
    .array()
    .atMostLength(4096)
    .narrow((values) => new Set(values).size === values.length),
  'subnet?': type('string <= 64').narrow((value) => {
    const [ip, mask] = value.split('/');
    const parts = ip?.split('.') ?? [];
    return (
      parts.length === 4 &&
      parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255) &&
      /^(0|[1-9][0-9]?)$/.test(mask ?? '') &&
      Number(mask) <= 32
    );
  }),
  'pullPlan?': type({ authoritySha256: hash, sha256: hash, configuration: 'object' }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type FreshPreparation = typeof freshPreparationSchema.infer;
const freshSchema = type({
  'seed?': "'pending' | 'intent' | 'ready'",
  phase: "'allocating' | 'prepared' | 'baseline-intent' | 'baselined'",
  storageSha256: hash,
  createAttempted: 'boolean',
  initialVolumes: volumeName
    .array()
    .atMostLength(4096)
    .narrow((values) => new Set(values).size === values.length),
  allocations: type({
    '[string]': type({ phase: "'create-intent' | 'created'", sha256: hash.or('null') })
      .onUndeclaredKey('reject')
      .narrow((value) => (value.phase === 'created') === (value.sha256 !== null)),
  }).narrow((rows) => Object.keys(rows).length <= 256 && Object.keys(rows).every((name) => volumeName.allows(name))),
  containers: freshContainer
    .array()
    .atMostLength(256)
    .narrow((rows) => new Set(rows.map(({ id }) => id)).size === rows.length),
  imagePinsSha256: hash.or('null'),
}).onUndeclaredKey('reject');
export type FreshInstallState = typeof freshSchema.infer;
const stateSchema = type({
  version: '2',
  id: uuid,
  requestId: uuid,
  appUrn: urn,
  revision: '0 <= number.integer <= 2147483647',
  previousGuardSha256: hash.or('null'),
  phase:
    "'staged' | 'target-ready' | 'switching' | 'prepared' | 'activation-attempted' | 'committing' | 'rolling-back' | 'rolled-back' | 'commit-verified'",
  intent: "'none' | 'move-original' | 'move-target' | 'replace-env' | 'rollback-target' | 'rollback-original' | 'restore-env'",
  metadata: absolute,
  env: absolute,
  originalIdentity: identity,
  metadataParent: identity,
  environmentParent: identity,
  stagingIdentity: identity,
  'swapIdentity?': identity,
  controlIdentity: identity,
  retainedPinsSha256: hash.or('null'),
  baseline: metadata,
  prepared: metadata.or('null'),
  targetIdentity: identity.or('null'),
  pulledImages: pulled.or('null'),
  context: contextSchema.or('null'),
  'updateSettings?': appUpdateSettingsSchema,
  'ordinaryCommit?': type({ pendingRestart: type('boolean').or('null') }).onUndeclaredKey('reject'),
  'rollback?': rollbackSchema,
  'freshPreparation?': freshPreparationSchema,
  'freshInstall?': freshSchema,
  'existingBaseline?': existingBaselineStateSchema,
  'migrationPreparation?': type({ phase: "'intent' | 'ready'", operationSha256: hash.or('null') })
    .onUndeclaredKey('reject')
    .narrow((value) => (value.phase === 'ready') === (value.operationSha256 !== null)),
}).onUndeclaredKey('reject');
export type AppUpdateStageState = typeof stateSchema.infer;
export type AppUpdateStageInput = {
  directory: string;
  appUrn: string;
  metadata: string;
  env: string;
  requestId: string;
  stageId?: string;
  freshPreparation?: Omit<FreshPreparation, 'subnet' | 'pullPlan'>;
};
const live = new Set<string>();
const transitions: Record<AppUpdateStageState['phase'], readonly AppUpdateStageState['phase'][]> = {
  staged: ['staged', 'target-ready', 'rolling-back'],
  'target-ready': ['target-ready', 'switching', 'rolling-back'],
  switching: ['switching', 'prepared', 'rolling-back'],
  prepared: ['prepared', 'activation-attempted', 'committing', 'rolling-back'],
  'activation-attempted': ['activation-attempted', 'committing'],
  committing: ['commit-verified'],
  'rolling-back': ['rolling-back', 'rolled-back'],
  'rolled-back': ['rolled-back'],
  'commit-verified': [],
};

function validate(raw: unknown) {
  const state = stateSchema.assert(raw);
  if (
    state.updateSettings &&
    (state.freshPreparation || state.freshInstall || (state.context && !equal(state.context.settings, state.updateSettings)))
  )
    throw failed();
  for (const tree of [state.baseline, ...(state.prepared ? [state.prepared] : [])]) {
    assertPackageLinks(tree.entries);
    if (
      tree.entries.some(
        (row) => row.symlink !== undefined && (row.directory || row.sha256 !== digest(row.symlink) || row.bytes !== Buffer.byteLength(row.symlink)),
      )
    )
      throw failed();
    if (
      tree.entries[0]?.name !== '' ||
      tree.entries[0].directory !== true ||
      new Set(tree.entries.map(({ name }) => name)).size !== tree.entries.length ||
      tree.entries.reduce((bytes, row) => bytes + (row.bytes ?? 0), 0) > 64 * 1024 * 1024 ||
      (tree.envSha256 === null ? tree.envMode !== null || tree.envGid !== null : tree.envMode === null || tree.envGid === null)
    )
      throw failed();
  }
  if (state.prepared && (!state.targetIdentity || state.prepared.envSha256 === null)) throw failed();
  if (!['staged', 'rolling-back', 'rolled-back'].includes(state.phase) && (!state.prepared || !state.targetIdentity)) throw failed();
  if (
    ['switching', 'prepared', 'activation-attempted', 'committing', 'commit-verified'].includes(state.phase) &&
    (!state.pulledImages || !state.context)
  )
    throw failed();
  if (
    state.context?.purpose === 'fresh-install' &&
    (state.baseline.entries.length !== 1 || state.baseline.envSha256 !== null || state.retainedPinsSha256 !== null)
  )
    throw failed();
  if (
    state.ordinaryCommit &&
    (!state.context ||
      state.context.purpose !== undefined ||
      state.freshInstall ||
      state.rollback ||
      state.migrationPreparation ||
      !['prepared', 'activation-attempted', 'committing', 'commit-verified'].includes(state.phase) ||
      (state.context.updateStatus === 'stopped') !== (state.ordinaryCommit.pendingRestart === null) ||
      (state.phase === 'prepared' && state.context.updateStatus !== 'stopped') ||
      state.context.targetMigrationIds.some((id) => !state.context?.previousLedger.migrationIds.includes(id)) ||
      (!state.context.previousLedger.baselined && (state.context.previousLedger.migrationIds.length || state.context.targetMigrationIds.length)))
  )
    throw failed();
  if (state.freshPreparation) {
    const preparation = state.freshPreparation;
    const context = state.context;
    if (
      state.baseline.entries.length !== 1 ||
      state.baseline.envSha256 !== null ||
      state.retainedPinsSha256 !== null ||
      state.existingBaseline ||
      state.rollback ||
      state.ordinaryCommit ||
      state.migrationPreparation ||
      (state.prepared && !preparation.subnet) ||
      (state.pulledImages && !preparation.pullPlan) ||
      (preparation.pullPlan &&
        (Array.isArray(preparation.pullPlan.configuration) ||
          Buffer.byteLength(JSON.stringify(preparation.pullPlan.configuration)) > 2 * 1024 * 1024 ||
          digest(encode(preparation.pullPlan.configuration)) !== preparation.pullPlan.sha256)) ||
      (context &&
        (context.purpose !== 'fresh-install' ||
          context.appId !== preparation.appId ||
          context.appCreatedAt !== preparation.appCreatedAt ||
          context.fromVersion !== preparation.version ||
          context.toVersion !== preparation.version ||
          context.requestInputSha256 !== preparation.requestInputSha256 ||
          context.authoritySha256 !== preparation.pullPlan?.authoritySha256)) ||
      (state.freshInstall &&
        (state.freshInstall.storageSha256 !== preparation.storageSha256 || !equal(state.freshInstall.initialVolumes, preparation.initialVolumes)))
    )
      throw failed();
  }
  if (state.freshInstall) {
    const fresh = state.freshInstall;
    if (
      state.context?.purpose !== 'fresh-install' ||
      !state.pulledImages ||
      state.rollback ||
      Object.keys(fresh.allocations).some((name) => fresh.initialVolumes.includes(name)) ||
      fresh.containers.some((row) => state.pulledImages?.imageIds[row.service] !== row.imageId) ||
      (fresh.phase !== 'allocating' &&
        (!fresh.containers.length ||
          !equal([...new Set(fresh.containers.map(({ service }) => service))].sort(), Object.keys(state.pulledImages.imageIds).sort()))) ||
      (['activation-attempted', 'committing', 'commit-verified'].includes(state.phase) && fresh.phase !== 'baselined') ||
      ((fresh.seed === 'pending' || fresh.seed === 'intent') &&
        (fresh.phase !== 'allocating' || fresh.createAttempted || state.phase !== 'target-ready'))
    )
      throw failed();
  }
  if (state.existingBaseline) {
    const adopted = state.existingBaseline;
    const binding = adopted.binding;
    if (
      state.freshInstall ||
      state.context?.purpose === 'fresh-install' ||
      binding.requestId !== state.requestId ||
      binding.stageId !== state.id ||
      binding.appUrn !== state.appUrn ||
      binding.metadataSha256 !== migrationHash(state.baseline) ||
      (adopted.phase === 'intent' && (state.phase !== 'target-ready' || state.context)) ||
      (state.context &&
        (adopted.phase !== 'confirmed' ||
          state.context.appId !== binding.appId ||
          state.context.appCreatedAt !== binding.appCreatedAt ||
          state.context.fromVersion !== binding.version ||
          state.context.requestInputSha256 !== binding.requestInputSha256 ||
          state.context.authoritySha256 !== binding.authoritySha256 ||
          !state.context.previousLedger.baselined ||
          !equal([...state.context.previousLedger.migrationIds].sort(), binding.migrationIds) ||
          !equal(
            state.context.originalContainers
              .map(({ id, imageId, service, running, paused, restarting }) => ({ id, imageId, service, running, paused, restarting }))
              .sort((a, b) => a.id.localeCompare(b.id)),
            binding.originalContainers.map(({ id, imageId, service, running, paused, restarting }) => ({
              id,
              imageId,
              service,
              running,
              paused,
              restarting,
            })),
          )))
    )
      throw failed();
  }
  if (
    state.migrationPreparation &&
    (!state.context ||
      state.context.purpose ||
      !state.context.previousLedger.baselined ||
      !state.context.targetMigrationIds.some((id) => !state.context?.previousLedger.migrationIds.includes(id)) ||
      (state.migrationPreparation.phase === 'intent' && (!['target-ready', 'rolling-back', 'rolled-back'].includes(state.phase) || state.rollback)))
  )
    throw failed();
  if (state.rollback) {
    if (
      !state.context ||
      !state.pulledImages ||
      !['target-ready', 'switching', 'prepared', 'rolling-back', 'rolled-back'].includes(state.phase) ||
      Object.keys(state.rollback.runtime).some((id) => !state.context?.originalContainers.some((row) => row.id === id)) ||
      (state.rollback.phase === 'settled' &&
        (state.phase !== 'rolled-back' || state.context.originalContainers.some(({ id }) => state.rollback?.runtime[id]?.phase !== 'verified')))
    )
      throw failed();
  }
  return state;
}
function guardFor(state: AppUpdateStageState): Extract<AppImageUpdateGuard, { version: 2 }> {
  return {
    version: 2,
    appUrn: state.appUrn,
    id: state.id,
    requestId: state.requestId,
    phase: state.phase,
    revision: state.revision,
    journalSha256: digest(encode(state)),
  };
}
async function syncTree(directory: string, tree: MetadataState, environment?: string) {
  for (const row of [...tree.entries].reverse()) {
    if (row.symlink !== undefined) continue;
    const handle = await fs.open(path.join(directory, row.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  if (environment) {
    const handle = await fs.open(environment, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/** Reopen only the same request and inode-bound staging operation. No app-data or SQL writes. */
export class AppUpdateStage implements StagedAppImageUpdate {
  #closed = false;
  #busy = false;
  #acknowledged = false;
  #journal: Buffer;
  #guard: Buffer;
  private constructor(
    readonly input: Readonly<AppUpdateStageInput>,
    private state: AppUpdateStageState,
  ) {
    this.#journal = encode(state);
    this.#guard = encode(guardFor(state));
  }
  get id() {
    return this.state.id;
  }
  get targetDirectory() {
    return this.paths.target;
  }
  private get paths() {
    return files.stagedPaths(this.input.directory, this.id, this.state.swapIdentity ? this.state.metadata : undefined);
  }
  private get previous() {
    return path.join(this.paths.swap, 'previous-live');
  }
  private get guardPath() {
    return files.updatePath(this.input.directory, this.state.appUrn);
  }

  static async create(raw: AppUpdateStageInput) {
    const input = structuredClone(raw);
    if (
      !uuid.allows(input.requestId) ||
      !urn.allows(input.appUrn) ||
      !absolute.allows(input.directory) ||
      input.stageId !== undefined ||
      !absolute.allows(input.metadata) ||
      !absolute.allows(input.env) ||
      input.metadata === input.directory ||
      input.directory.startsWith(input.metadata + '/') ||
      input.env.startsWith(input.directory + '/')
    )
      throw failed();
    const preparation = input.freshPreparation ? freshPreparationSchema.assert(input.freshPreparation) : undefined;
    if (preparation?.subnet || preparation?.pullPlan) throw failed();
    await files.directorySafe(input.directory, true);
    if (live.has(input.directory + '/' + input.appUrn) || (await files.updateGuard(input.directory, input.appUrn))) throw failed();
    const lease = input.directory + '/' + input.appUrn;
    live.add(lease);
    try {
      const capacity = await fs.statfs(input.directory);
      if (capacity.bavail * capacity.bsize < 390 * 1024 * 1024) throw failed();
      const id = randomUUID();
      const paths = files.stagedPaths(input.directory, id, input.metadata);
      const metadataDirectory = path.dirname(input.metadata);
      await files.noSymlinkParents(metadataDirectory);
      const metadataParent = files.directoryIdentity(await fs.lstat(metadataDirectory));
      const originalIdentity = files.directoryIdentity(await fs.lstat(input.metadata));
      if (metadataParent.dev !== originalIdentity.dev) throw failed();
      const swapCapacity = await fs.statfs(metadataDirectory);
      if (swapCapacity.bavail * swapCapacity.bsize < 65 * 1024 * 1024) throw failed();
      await fs.mkdir(paths.staging, { mode: 0o700 });
      await files.syncDirectory(input.directory);
      // Linux rejects rename across separate bind mounts, even when st_dev is the same.
      await fs.mkdir(paths.swap, { mode: 0o700 });
      const swapIdentity = files.directoryIdentity(await fs.lstat(paths.swap));
      await files.syncDirectory(metadataDirectory);
      const environmentParent = files.directoryIdentity(await fs.lstat(path.dirname(input.env)));
      const baseline = await files.metadataState(input.metadata, input.env, paths.staging);
      if (
        !files.sameDirectory(await fs.lstat(input.metadata), originalIdentity) ||
        !equal(baseline, await files.metadataState(input.metadata, input.env))
      )
        throw failed();
      await syncTree(path.join(paths.staging, 'metadata'), baseline, baseline.envSha256 === null ? undefined : path.join(paths.staging, 'app.env'));
      const pins = await readAppImagePins(input.directory, { appUrn: input.appUrn, project: input.appUrn.replace(':', '_') });
      const pinBytes = pins ? await files.readOwned(pins.path, 128 * 1024) : null;
      if (pinBytes) {
        const file = await fs.open(path.join(paths.staging, 'retained-pins.json'), 'wx', 0o600);
        try {
          await file.writeFile(pinBytes);
          await file.sync();
        } finally {
          await file.close();
        }
      }
      const state = validate({
        version: 2,
        id,
        requestId: input.requestId,
        appUrn: input.appUrn,
        revision: 0,
        previousGuardSha256: null,
        phase: 'staged',
        intent: 'none',
        metadata: input.metadata,
        env: input.env,
        originalIdentity,
        metadataParent,
        environmentParent,
        stagingIdentity: files.directoryIdentity(await fs.lstat(paths.staging)),
        swapIdentity,
        controlIdentity: files.directoryIdentity(await fs.lstat(input.directory)),
        retainedPinsSha256: pinBytes ? digest(pinBytes) : null,
        baseline,
        prepared: null,
        targetIdentity: null,
        pulledImages: null,
        context: null,
        ...(preparation ? { freshPreparation: preparation } : {}),
      });
      await files.privateJson(path.join(paths.staging, 'journal.json'), state);
      const handle = await fs.open(
        files.updatePath(input.directory, input.appUrn),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(encode(guardFor(state)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await files.syncDirectory(input.directory);
      return new AppUpdateStage(Object.freeze(input), state);
    } catch {
      live.delete(lease);
      throw failed();
    }
  }

  static async open(raw: AppUpdateStageInput) {
    const input = structuredClone(raw);
    const lease = input.directory + '/' + input.appUrn;
    if (
      !uuid.allows(input.requestId) ||
      !urn.allows(input.appUrn) ||
      !absolute.allows(input.directory) ||
      !absolute.allows(input.metadata) ||
      !absolute.allows(input.env) ||
      live.has(lease)
    )
      throw failed();
    live.add(lease);
    try {
      const guard = await files.updateGuard(input.directory, input.appUrn);
      if (guard?.version !== 2 || guard.requestId !== input.requestId || (input.stageId !== undefined && guard.id !== input.stageId)) throw failed();
      const paths = files.stagedPaths(input.directory, guard.id);
      if (!(await files.directorySafe(paths.staging, false))) throw failed();
      const bytes = await files.readOwned(path.join(paths.staging, 'journal.json'), 4 * 1024 * 1024);
      if (((await fs.lstat(path.join(paths.staging, 'journal.json'))).mode & 0o077) !== 0) throw failed();
      const state = validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (
        !bytes.equals(encode(state)) ||
        state.id !== guard.id ||
        state.appUrn !== input.appUrn ||
        state.requestId !== input.requestId ||
        state.metadata !== input.metadata ||
        state.env !== input.env
      )
        throw failed();
      const handle = new AppUpdateStage(Object.freeze(input), state);
      await handle.checkParents();
      await handle.positions();
      if (state.revision === guard.revision && digest(bytes) === guard.journalSha256 && state.phase === guard.phase) {
        await handle.check();
      } else {
        // Recover exactly one journal publication whose guard reply/publication was lost.
        if (
          state.revision !== guard.revision + 1 ||
          state.previousGuardSha256 !== digest(encode(guard)) ||
          !transitions[guard.phase as AppUpdateStageState['phase']]?.includes(state.phase)
        )
          throw failed();
        await files.privateJson(handle.guardPath, guardFor(state));
        await handle.check();
      }
      return handle;
    } catch {
      live.delete(lease);
      throw failed();
    }
  }

  private async checkParents() {
    if (
      this.#closed ||
      !(await files.directorySafe(this.paths.staging, false)) ||
      !files.sameDirectory(await fs.lstat(this.input.directory), this.state.controlIdentity) ||
      !files.sameDirectory(await fs.lstat(this.paths.staging), this.state.stagingIdentity)
    )
      throw failed();
    for (const [name, expected] of [
      [path.dirname(this.state.metadata), this.state.metadataParent],
      [path.dirname(this.state.env), this.state.environmentParent],
    ] as const) {
      await files.noSymlinkParents(name);
      if (!files.sameDirectory(await fs.lstat(name), expected)) throw failed();
    }
    if (
      this.state.swapIdentity &&
      (!(await files.directorySafe(this.paths.swap, false)) || !files.sameDirectory(await fs.lstat(this.paths.swap), this.state.swapIdentity))
    )
      throw failed();
  }
  private async check() {
    await this.checkParents();
    if (((await fs.lstat(path.join(this.paths.staging, 'journal.json'))).mode & 0o077) !== 0) throw failed();
    if (
      !(await files.readOwned(path.join(this.paths.staging, 'journal.json'), 4 * 1024 * 1024)).equals(this.#journal) ||
      !(await files.readOwned(this.guardPath, 4096)).equals(this.#guard) ||
      !equal(await files.updateGuard(this.input.directory, this.state.appUrn), guardFor(this.state))
    )
      throw failed();
  }
  async read() {
    await this.check();
    return structuredClone(this.state);
  }
  async readOriginalBaseline() {
    await this.check();
    await this.positions();
    if (this.state.phase !== 'target-ready' || this.state.context || this.state.freshInstall || !this.state.pulledImages) throw failed();
    const metadata = path.join(this.paths.staging, 'metadata');
    const env = path.join(this.paths.staging, 'app.env');
    const snapshot = await files.metadataState(metadata, env);
    const content = (rows: MetadataState['entries']) => rows.map(({ mode: _mode, gid: _gid, ...row }) => row);
    if (
      this.state.baseline.envSha256 === null ||
      snapshot.envSha256 !== this.state.baseline.envSha256 ||
      snapshot.envMode !== 0o600 ||
      snapshot.entries.some((row) => row.symlink === undefined && row.mode !== (row.directory ? 0o700 : 0o600)) ||
      !equal(content(snapshot.entries), content(this.state.baseline.entries))
    )
      throw failed();
    await this.checkPins();
    if (
      this.state.retainedPinsSha256 &&
      digest(await files.readOwned(path.join(this.paths.staging, 'retained-pins.json'), 128 * 1024)) !== this.state.retainedPinsSha256
    )
      throw failed();
    return {
      metadata,
      env,
      projectDirectory: this.state.metadata,
      imagePins: this.state.retainedPinsSha256 ? path.join(this.paths.staging, 'retained-pins.json') : undefined,
    };
  }
  async recordUpdateSettings(input: AppUpdateSettings) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (this.state.phase !== 'target-ready' || this.state.context || this.state.existingBaseline) throw failed();
      const settings = appUpdateSettingsSchema.assert(input);
      if (this.state.updateSettings && !equal(this.state.updateSettings, settings)) throw failed();
      await this.save({ updateSettings: settings });
    });
  }
  async recordExistingBaseline(proof: ExistingAppBaseline) {
    return this.exclusive(async () => {
      await this.check();
      const binding = await verifyExistingAppBaseline(proof, this);
      if (this.state.phase !== 'target-ready' || this.state.context || this.state.existingBaseline) throw failed();
      await this.save({ existingBaseline: { phase: 'intent', binding } });
    });
  }
  async confirmExistingBaseline(repository: Pick<AppsRepository, 'readExistingAppBaseline'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const adopted = this.state.existingBaseline;
      if (this.state.phase !== 'target-ready' || this.state.context || !adopted || !(await repository.readExistingAppBaseline(adopted.binding)))
        throw failed();
      if (adopted.phase !== 'confirmed') await this.save({ existingBaseline: { ...adopted, phase: 'confirmed' } });
      return { baselined: true, migrationIds: [...adopted.binding.migrationIds] };
    });
  }
  async readTarget() {
    return this.exclusive(async () => {
      await this.check();
      const position = await this.positions();
      if (
        !['target-ready', 'switching', 'prepared', 'activation-attempted', 'committing', 'commit-verified', 'rolling-back', 'rolled-back'].includes(
          this.state.phase,
        ) ||
        !this.state.prepared
      )
        throw failed();
      const target = position.targetLive ? this.state.metadata : this.paths.target;
      return { target, compose: path.join(target, path.basename(this.paths.compose)), env: this.paths.env, staging: this.paths.staging };
    });
  }
  async withOverrides<T>(
    inputs: { compose: string | null; env: string | null },
    use: (paths: { compose?: string; env?: string; platform: string; target: string; targetEnv: string; targetCompose: string }) => Promise<T>,
  ) {
    return this.exclusive(async () => {
      await this.check();
      const position = await this.positions();
      if (
        !['target-ready', 'switching', 'prepared', 'activation-attempted', 'rolling-back', 'rolled-back'].includes(this.state.phase) ||
        !this.state.prepared ||
        Buffer.byteLength(inputs.compose ?? '') > 2 * 1024 * 1024 ||
        Buffer.byteLength(inputs.env ?? '') > 1024 * 1024
      )
        throw failed();
      const target = position.targetLive ? this.state.metadata : this.paths.target;
      const snapshot = path.join(this.paths.staging, `resume-overrides-${randomUUID()}`);
      await fs.mkdir(snapshot, { mode: 0o700 });
      const owned = files.directoryIdentity(await fs.lstat(snapshot));
      const cleanup = async () => {
        if (!files.sameDirectory(await fs.lstat(snapshot), owned)) throw failed();
        await fs.rm(snapshot, { recursive: true });
      };
      try {
        const compose = inputs.compose ? path.join(snapshot, 'compose.yml') : undefined;
        const env = inputs.env ? path.join(snapshot, 'app.env') : undefined;
        const platform = path.join(snapshot, 'platform.yml');
        if (compose && inputs.compose) await fs.writeFile(compose, inputs.compose, { flag: 'wx', mode: 0o600 });
        if (env && inputs.env) await fs.writeFile(env, inputs.env, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(platform, `${STAGED_UPDATE_DEFAULT_PLATFORM}: "\${DOCKER_DEFAULT_PLATFORM:-}"\n`, { flag: 'wx', mode: 0o600 });
        const result = await use({
          compose,
          env,
          platform,
          target,
          targetEnv: this.paths.env,
          targetCompose: path.join(target, path.basename(this.paths.compose)),
        });
        await this.check();
        await this.positions();
        return result;
      } finally {
        await cleanup();
      }
    });
  }
  private async save(changes: Partial<AppUpdateStageState>) {
    await this.check();
    const next = validate({ ...this.state, ...changes, revision: this.state.revision + 1, previousGuardSha256: digest(this.#guard) });
    if (!transitions[this.state.phase].includes(next.phase)) throw failed();
    await files.privateJson(path.join(this.paths.staging, 'journal.json'), next);
    await files.privateJson(this.guardPath, guardFor(next));
    this.state = next;
    this.#journal = encode(next);
    this.#guard = encode(guardFor(next));
  }
  private async exclusive<T>(effect: () => Promise<T>): Promise<T> {
    if (this.#busy || this.#closed) throw failed();
    this.#busy = true;
    try {
      return await effect();
    } catch {
      throw failed();
    } finally {
      this.#busy = false;
    }
  }
  private async environment(): Promise<Pick<MetadataState, 'envSha256' | 'envMode' | 'envGid'>> {
    try {
      const bytes = await files.readOwned(this.state.env, 1024 * 1024);
      const stat = await fs.lstat(this.state.env);
      return { envSha256: digest(bytes), envMode: stat.mode & 0o777, envGid: stat.gid };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { envSha256: null, envMode: null, envGid: null };
    }
  }
  private sameEnv(actual: Pick<MetadataState, 'envSha256' | 'envMode' | 'envGid'>, expected: MetadataState) {
    return actual.envSha256 === expected.envSha256 && actual.envMode === expected.envMode && actual.envGid === expected.envGid;
  }
  private async treeMatches(root: string, expected: MetadataState, expectedIdentity: unknown) {
    const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return false;
    if (!files.sameDirectory(stat, expectedIdentity) || !equal((await files.metadataState(root, this.state.env)).entries, expected.entries))
      throw failed();
    return true;
  }
  private async positions() {
    await this.checkParents();
    await this.checkPins();
    const { prepared, targetIdentity, baseline } = this.state;
    const current = await fs.lstat(this.state.metadata).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const oldLive = current && files.sameDirectory(current, this.state.originalIdentity);
    const targetLive = current && targetIdentity && files.sameDirectory(current, targetIdentity);
    if (current && !oldLive && !targetLive) throw failed();
    const previous = await this.treeMatches(this.previous, baseline, this.state.originalIdentity);
    if (oldLive) {
      await this.treeMatches(this.state.metadata, baseline, this.state.originalIdentity);
      if (previous) throw failed();
      if (prepared && !(await this.treeMatches(this.paths.target, prepared, targetIdentity))) throw failed();
    } else {
      if (!previous || !prepared || !targetIdentity) throw failed();
      if (targetLive) {
        await this.treeMatches(this.state.metadata, prepared, targetIdentity);
        await files.requireVacantUpdatePath(this.paths.target);
      } else if (!(await this.treeMatches(this.paths.target, prepared, targetIdentity))) throw failed();
    }
    const environment = await this.environment();
    const oldEnv = this.sameEnv(environment, baseline);
    const targetEnv = prepared ? this.sameEnv(environment, prepared) : false;
    if (!oldEnv && !targetEnv) throw failed();
    if (
      !['switching', 'rolling-back'].includes(this.state.phase) &&
      (['staged', 'target-ready', 'rolled-back'].includes(this.state.phase) ? !oldLive || !oldEnv : !targetLive || !targetEnv)
    )
      throw failed();
    return { oldLive: Boolean(oldLive), targetLive: Boolean(targetLive), previous, oldEnv, targetEnv };
  }

  async stageTarget(compose: string, environment: string) {
    return this.exclusive(async () => {
      await this.check();
      if (
        !['staged', 'target-ready'].includes(this.state.phase) ||
        this.state.pulledImages ||
        Buffer.byteLength(compose) > 8 * 1024 * 1024 ||
        Buffer.byteLength(environment) > 1024 * 1024
      )
        throw failed();
      await this.positions();
      const target = await fs.lstat(this.paths.target);
      if (target.dev !== this.state.originalIdentity.dev) throw failed();
      await files.metadataState(this.paths.target, this.paths.env);
      await files.replaceUpdateFile(this.paths.compose, compose, 0o600);
      await files.replaceUpdateFile(this.paths.env, environment, 0o600);
      const prepared = await files.metadataState(this.paths.target, this.paths.env);
      await syncTree(this.paths.target, prepared, this.paths.env);
      await files.syncDirectory(this.paths.swap);
      await this.save({ phase: 'target-ready', prepared, targetIdentity: files.directoryIdentity(target) });
    });
  }
  private async checkPins() {
    const current = await readAppImagePins(this.input.directory, { appUrn: this.state.appUrn, project: this.state.appUrn.replace(':', '_') });
    const actual = current ? digest(await files.readOwned(current.path, 128 * 1024)) : null;
    if (actual === this.state.retainedPinsSha256) return;
    if (actual !== null && actual === this.state.freshInstall?.imagePinsSha256 && this.state.context?.purpose === 'fresh-install') return;
    if (actual === null && this.state.retainedPinsSha256 !== null && ['committing', 'commit-verified'].includes(this.state.phase)) return;
    throw failed();
  }
  async recordPulledImages(binding: PulledUpdateImages) {
    return this.exclusive(async () => {
      await this.check();
      if (this.state.phase !== 'target-ready' || !files.validPulledImages(binding)) throw failed();
      await this.positions();
      if (this.state.pulledImages) {
        if (!equal(this.state.pulledImages, binding)) throw failed();
        return;
      }
      await this.save({ pulledImages: structuredClone(binding) });
    });
  }
  async recordFreshSubnet(subnet: string) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const preparation = this.state.freshPreparation;
      if (this.state.phase !== 'staged' || !preparation || this.state.prepared || this.state.context) throw failed();
      if (preparation.subnet) {
        if (preparation.subnet !== subnet) throw failed();
        return;
      }
      await this.save({ freshPreparation: { ...preparation, subnet } });
    });
  }
  async recordFreshPullPlan(authoritySha256: string, configuration: object) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const preparation = this.state.freshPreparation;
      if (this.state.phase !== 'target-ready' || !preparation?.subnet || this.state.context) throw failed();
      const bytes = encode(configuration);
      if (bytes.length > 2 * 1024 * 1024) throw failed();
      const pullPlan = { authoritySha256, sha256: digest(bytes), configuration: JSON.parse(bytes.toString('utf8')) as object };
      if (preparation.pullPlan) {
        if (!equal(preparation.pullPlan, pullPlan)) throw failed();
        return;
      }
      if (this.state.pulledImages) throw failed();
      await this.save({ freshPreparation: { ...preparation, pullPlan } });
    });
  }
  async recordContext(input: AppUpdateContext) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (this.state.phase !== 'target-ready' || !this.state.pulledImages) throw failed();
      const context = structuredClone(contextSchema.assert(input));
      if (this.state.updateSettings && !equal(context.settings, this.state.updateSettings)) throw failed();
      if (this.state.context) {
        if (!equal(this.state.context, context)) throw failed();
        return;
      }
      const pending = context.purpose === undefined && context.targetMigrationIds.some((id) => !context.previousLedger.migrationIds.includes(id));
      await this.save({ context, ...(pending ? { migrationPreparation: { phase: 'intent' as const, operationSha256: null } } : {}) });
    });
  }
  async publishTarget() {
    return this.exclusive(async () => {
      await this.check();
      if (this.state.migrationPreparation?.phase === 'intent') throw failed();
      if (
        this.state.rollback ||
        (this.state.context?.purpose === 'fresh-install' &&
          (!this.state.freshInstall || (this.state.freshInstall.seed !== undefined && this.state.freshInstall.seed !== 'ready')))
      )
        throw failed();
      if (
        !['target-ready', 'switching', 'prepared'].includes(this.state.phase) ||
        !this.state.prepared ||
        !this.state.pulledImages ||
        !this.state.context
      )
        throw failed();
      let position = await this.positions();
      if (this.state.phase === 'prepared') return;
      if (position.oldLive) {
        await this.save({ phase: 'switching', intent: 'move-original' });
        await fs.rename(this.state.metadata, this.previous);
        await files.syncDirectory(path.dirname(this.state.metadata));
        await files.syncDirectory(this.paths.swap);
      }
      position = await this.positions();
      if (!position.targetLive) {
        await this.save({ phase: 'switching', intent: 'move-target' });
        await fs.rename(this.paths.target, this.state.metadata);
        await files.syncDirectory(path.dirname(this.state.metadata));
        await files.syncDirectory(this.paths.swap);
      }
      await this.positions();
      await this.save({ phase: 'switching', intent: 'replace-env' });
      const bytes = await files.readOwned(this.paths.env, 1024 * 1024);
      if (digest(bytes) !== this.state.prepared.envSha256) throw failed();
      await files.replaceUpdateFile(this.state.env, bytes, this.state.prepared.envMode ?? 0o600, this.state.prepared.envGid ?? undefined);
      const verified = await this.positions();
      if (!verified.targetLive || !verified.targetEnv) throw failed();
      await this.save({ phase: 'prepared', intent: 'none' });
    });
  }
  async activationAttempted() {
    return this.exclusive(async () => {
      await this.check();
      if (this.state.rollback) throw failed();
      await this.positions();
      if (this.state.phase === 'activation-attempted') return;
      if (
        this.state.phase !== 'prepared' ||
        (this.state.context?.purpose === 'fresh-install' &&
          (this.state.freshInstall?.phase !== 'baselined' || !this.state.freshInstall.imagePinsSha256))
      )
        throw failed();
      await this.save({ phase: 'activation-attempted' });
    });
  }
  /** Read-only verification is also used inside this stage's acknowledged SQL callbacks. */
  async verifyFreshInstall() {
    await this.check();
    await this.positions();
    if (this.state.context?.purpose !== 'fresh-install' || !this.state.freshInstall) throw failed();
    return structuredClone(this.state);
  }
  async beginFreshStorage(storageSha256: string, initialVolumes: string[]) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (this.state.phase !== 'target-ready' || this.state.context?.purpose !== 'fresh-install' || this.state.freshInstall) throw failed();
      await this.save({
        freshInstall: freshSchema.assert({
          phase: 'allocating',
          seed: 'pending',
          storageSha256,
          createAttempted: false,
          initialVolumes,
          allocations: {},
          containers: [],
          imagePinsSha256: null,
        }),
      });
    });
  }
  async beginFreshSeed() {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (this.state.phase !== 'target-ready' || fresh?.phase !== 'allocating' || fresh.createAttempted || fresh.seed !== 'pending') throw failed();
      await this.save({ freshInstall: { ...fresh, seed: 'intent' } });
    });
  }
  async confirmFreshSeed() {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (this.state.phase !== 'target-ready' || fresh?.phase !== 'allocating' || fresh.createAttempted || fresh.seed !== 'intent') throw failed();
      await this.save({ freshInstall: { ...fresh, seed: 'ready' } });
    });
  }
  async recordFreshVolume(name: string, sha256: string | null) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (
        !volumeName.allows(name) ||
        !fresh ||
        fresh.phase !== 'allocating' ||
        fresh.initialVolumes.includes(name) ||
        (sha256 !== null && !hash.allows(sha256))
      )
        throw failed();
      const previous = fresh.allocations[name];
      if ((sha256 === null && previous) || (sha256 !== null && previous?.phase !== 'create-intent')) throw failed();
      await this.save({
        freshInstall: { ...fresh, allocations: { ...fresh.allocations, [name]: { phase: sha256 === null ? 'create-intent' : 'created', sha256 } } },
      });
    });
  }
  async freshCreationAttempted() {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (this.state.phase !== 'prepared' || fresh?.phase !== 'allocating' || fresh.createAttempted) throw failed();
      await this.save({ freshInstall: { ...fresh, createAttempted: true } });
    });
  }
  async preparedFreshStorage(containers: FreshInstallState['containers']) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (
        this.state.phase !== 'prepared' ||
        fresh?.phase !== 'allocating' ||
        !fresh.createAttempted ||
        Object.values(fresh.allocations).some((row) => row.phase !== 'created')
      )
        throw failed();
      await this.save({ freshInstall: { ...fresh, phase: 'prepared', containers: structuredClone(containers) } });
    });
  }
  async beginFreshBaseline() {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (this.state.phase !== 'prepared' || fresh?.phase !== 'prepared') throw failed();
      await this.save({ freshInstall: { ...fresh, phase: 'baseline-intent' } });
    });
  }
  async confirmFreshBaseline(repository: Pick<AppsRepository, 'readFreshInstallBaseline'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      if (!fresh || !['baseline-intent', 'baselined'].includes(fresh.phase) || (await repository.readFreshInstallBaseline(this)) !== true)
        throw failed();
      if (fresh.phase !== 'baselined') await this.save({ freshInstall: { ...fresh, phase: 'baselined' } });
    });
  }
  async pinFreshImages(source: AppImagePinSource) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const fresh = this.state.freshInstall;
      const pulled = this.state.pulledImages;
      if (
        this.state.phase !== 'prepared' ||
        fresh?.phase !== 'baselined' ||
        !pulled ||
        source.appUrn !== this.state.appUrn ||
        source.project !== this.state.appUrn.replace(':', '_')
      )
        throw failed();
      const input = { version: 1 as const, pointId: this.id, sourceSha256: source.sourceSha256, services: pulled.imageIds };
      const selected = encodeAppImagePins(source, input);
      const sha256 = digest(selected.data);
      if (fresh.imagePinsSha256 !== null && fresh.imagePinsSha256 !== sha256) throw failed();
      if (fresh.imagePinsSha256 === null) await this.save({ freshInstall: { ...fresh, imagePinsSha256: sha256 } });
      await writeAppImagePins(this.input.directory, source, input);
      await this.positions();
    });
  }
  async prepare(): Promise<void> {
    throw failed();
  }
  private async rollbackOperation(journal: AppMigrationJournal) {
    const state = await journal.read();
    const operation = state.operation;
    const context = this.state.context;
    if (
      !context ||
      !context.previousLedger.baselined ||
      state.targetWritesPossible ||
      state.commitAttempted ||
      state.commitReceiptSha256 !== null ||
      operation.requestId !== this.state.requestId ||
      operation.stageId !== this.id ||
      operation.appUrn !== this.state.appUrn ||
      operation.appId !== context.appId ||
      operation.createdAt !== context.appCreatedAt ||
      operation.fromVersion !== context.fromVersion ||
      operation.toVersion !== context.toVersion ||
      !equal(operation.settings, context.settings) ||
      !equal(operation.previousLedger, context.previousLedger) ||
      !equal(
        operation.images.map(({ migrationId }) => migrationId),
        context.targetMigrationIds.filter((id) => !context.previousLedger.migrationIds.includes(id)).sort(),
      ) ||
      !equal(
        operation.originalContainers,
        context.originalContainers.map(({ id, imageId, service }) => ({ id, imageId, service })),
      )
    )
      throw failed();
    return { state, sha256: digest(encode(operation)) };
  }
  async confirmMigrationPreparation(journal: AppMigrationJournal) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const selected = await this.rollbackOperation(journal);
      if (
        this.state.phase !== 'target-ready' ||
        !this.state.migrationPreparation ||
        selected.state.phase !== 'allocated' ||
        selected.state.checkpoint ||
        selected.state.runners.length ||
        selected.state.restores.length
      )
        throw failed();
      if (this.state.migrationPreparation.phase === 'ready') {
        if (this.state.migrationPreparation.operationSha256 !== selected.sha256) throw failed();
      } else await this.save({ migrationPreparation: { phase: 'ready', operationSha256: selected.sha256 } });
    });
  }
  async verifyMigrationPreparation(journal: AppMigrationJournal) {
    await this.check();
    const saved = this.state.migrationPreparation;
    if (saved && (saved.phase !== 'ready' || saved.operationSha256 !== migrationHash((await journal.read()).operation))) throw failed();
    // Operations written before preparation markers remain bound by the existing complete journal/context verification.
  }
  async retainRollback(journal: AppMigrationJournal) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (!['target-ready', 'switching', 'prepared', 'rolling-back', 'rolled-back'].includes(this.state.phase)) throw failed();
      const selected = await this.rollbackOperation(journal);
      if (this.state.rollback) {
        if (this.state.rollback.operationSha256 !== selected.sha256) throw failed();
        return;
      }
      await this.save({ rollback: { operationSha256: selected.sha256, phase: 'retained', runtime: {} } });
    });
  }
  async recordRollbackRuntime(id: string, input: RollbackRuntimeRecord) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const rollback = this.state.rollback;
      const expected = this.state.context?.originalContainers.find((row) => row.id === id);
      const selected = structuredClone(rollbackRuntime.assert(input));
      if (this.state.phase !== 'rolled-back' || rollback?.phase !== 'retained' || !expected) throw failed();
      const prior = rollback.runtime[id];
      if (selected.phase === 'start-intent' && (prior || !(expected.running || expected.paused || expected.restarting))) throw failed();
      if (selected.phase === 'pause-intent' && (!expected.paused || (prior && prior.phase !== 'start-intent'))) throw failed();
      await this.save({ rollback: { ...rollback, runtime: { ...rollback.runtime, [id]: selected } } });
    });
  }
  async finishRollback(journal: AppMigrationJournal, repository: Pick<AppsRepository, 'readMigrationRollback'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      const rollback = this.state.rollback;
      const context = this.state.context;
      const selected = await this.rollbackOperation(journal);
      if (
        this.state.phase !== 'rolled-back' ||
        !rollback ||
        !context ||
        rollback.operationSha256 !== selected.sha256 ||
        context.originalContainers.some(({ id }) => rollback.runtime[id]?.phase !== 'verified') ||
        (await repository.readMigrationRollback(selected.state, context.updateStatus)) !== true
      )
        throw failed();
      if (rollback.phase !== 'settled') await this.save({ rollback: { ...rollback, phase: 'settled' } });
      await this.clear();
    });
  }
  async restoreMetadata() {
    return this.exclusive(async () => {
      await this.check();
      if (this.state.existingBaseline?.phase === 'intent') throw failed();
      if (this.state.freshInstall && ['baseline-intent', 'baselined'].includes(this.state.freshInstall.phase)) throw failed();
      if (!['staged', 'target-ready', 'switching', 'prepared', 'rolling-back', 'rolled-back'].includes(this.state.phase)) throw failed();
      let position = await this.positions();
      if (this.state.phase === 'rolled-back') return this.state.rollback ? undefined : this.clear();
      if (position.targetLive) {
        await this.save({ phase: 'rolling-back', intent: 'rollback-target' });
        await fs.rename(this.state.metadata, this.paths.target);
        await files.syncDirectory(path.dirname(this.state.metadata));
        await files.syncDirectory(this.paths.swap);
      }
      position = await this.positions();
      if (!position.oldLive) {
        await this.save({ phase: 'rolling-back', intent: 'rollback-original' });
        await fs.rename(this.previous, this.state.metadata);
        await files.syncDirectory(path.dirname(this.state.metadata));
        await files.syncDirectory(this.paths.swap);
      }
      await this.save({ phase: 'rolling-back', intent: 'restore-env' });
      await this.positions();
      if (this.state.baseline.envSha256 === null) {
        if (!this.sameEnv(await this.environment(), this.state.baseline)) {
          await fs.unlink(this.state.env);
          await files.syncDirectory(path.dirname(this.state.env));
        }
      } else {
        const bytes = await files.readOwned(path.join(this.paths.staging, 'app.env'), 1024 * 1024);
        if (digest(bytes) !== this.state.baseline.envSha256) throw failed();
        await files.replaceUpdateFile(this.state.env, bytes, this.state.baseline.envMode ?? 0o600, this.state.baseline.envGid ?? undefined);
      }
      const verified = await this.positions();
      if (!verified.oldLive || !verified.oldEnv) throw failed();
      await this.save({ phase: 'rolled-back', intent: 'none' });
      if (!this.state.rollback) await this.clear();
    });
  }
  async commit(retire: () => Promise<void>) {
    return this.exclusive(async () => {
      await this.check();
      if (this.state.rollback) throw failed();
      await this.positions();
      if (
        !['prepared', 'activation-attempted'].includes(this.state.phase) ||
        (this.state.context?.purpose === 'fresh-install' &&
          (this.state.freshInstall?.phase !== 'baselined' ||
            !this.state.freshInstall.imagePinsSha256 ||
            this.state.phase !== (this.state.context.updateStatus === 'running' ? 'activation-attempted' : 'prepared')))
      )
        throw failed();
      await this.save({ phase: 'committing' });
      await retire();
      this.#acknowledged = true;
      await this.save({ phase: 'commit-verified' });
      await this.clear();
    });
  }
  async recordOrdinaryCommit(pendingRestart: boolean | null) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (!['prepared', 'activation-attempted'].includes(this.state.phase)) throw failed();
      const ordinaryCommit = { pendingRestart };
      if (this.state.ordinaryCommit) {
        if (!equal(this.state.ordinaryCommit, ordinaryCommit)) throw failed();
        return;
      }
      await this.save({ ordinaryCommit });
    });
  }
  async commitOrdinary(
    repository: Pick<AppsRepository, 'commitOrdinaryAppUpdate' | 'readCurrentOrdinaryUpdateCommit'>,
    pendingRestart: boolean | null,
  ) {
    await this.recordOrdinaryCommit(pendingRestart);
    const result = await ordinaryUpdateResultBinding(this);
    await this.commit(async () => {
      await retainOrdinaryUpdateResult(this.input.directory, result);
      try {
        if (!(await repository.commitOrdinaryAppUpdate(this, result))) throw failed();
      } catch (error) {
        if (!(await repository.readCurrentOrdinaryUpdateCommit(result))) throw error;
      }
    });
  }
  async reconcileOrdinaryCommitted(repository: Pick<AppsRepository, 'readCurrentOrdinaryUpdateCommit'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (!['committing', 'commit-verified'].includes(this.state.phase)) throw failed();
      const result = await ordinaryUpdateResultBinding(this);
      if (!(await repository.readCurrentOrdinaryUpdateCommit(result))) throw failed();
      this.#acknowledged = true;
      if (this.state.phase !== 'commit-verified') await this.save({ phase: 'commit-verified' });
      await this.clear();
    });
  }
  async reconcileFreshCommitted(repository: Pick<AppsRepository, 'readCurrentFreshInstallCommit'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (!['committing', 'commit-verified'].includes(this.state.phase)) throw failed();
      const result = await freshInstallResultBinding(this);
      if (!(await repository.readCurrentFreshInstallCommit(result))) throw failed();
      this.#acknowledged = true;
      if (this.state.phase !== 'commit-verified') await this.save({ phase: 'commit-verified' });
      await this.clear();
    });
  }
  async reconcileCommitted(journal: AppMigrationJournal, repository: Pick<AppsRepository, 'readMigrationCommit'>) {
    return this.exclusive(async () => {
      await this.check();
      await this.positions();
      if (!['committing', 'commit-verified'].includes(this.state.phase)) throw failed();
      const operation = await journal.read();
      if (
        operation.operation.requestId !== this.state.requestId ||
        operation.operation.stageId !== this.id ||
        operation.operation.appUrn !== this.state.appUrn
      )
        throw failed();
      const receipt = await repository.readMigrationCommit(operation);
      if (!receipt) throw failed();
      await journal.confirmCommitted(receipt.sha256);
      this.#acknowledged = true;
      if (this.state.phase !== 'commit-verified') await this.save({ phase: 'commit-verified' });
      await this.clear();
    });
  }
  private async clear() {
    await this.check();
    await this.positions();
    if (this.state.phase !== 'rolled-back' && !(this.state.phase === 'commit-verified' && this.#acknowledged)) throw failed();
    if (this.state.phase === 'rolled-back' && this.state.rollback && this.state.rollback.phase !== 'settled') throw failed();
    if (this.state.phase === 'commit-verified') {
      if (this.state.freshInstall) {
        const selected = await readAppImagePins(this.input.directory, { appUrn: this.state.appUrn, project: this.state.appUrn.replace(':', '_') });
        if (!selected || digest(await files.readOwned(selected.path, 128 * 1024)) !== this.state.freshInstall.imagePinsSha256) throw failed();
      } else await removeAppImagePins(this.input.directory, this.state.appUrn);
    }
    // Publish terminal custody before releasing the app barrier; orphaned terminal staging stays private on interruption.
    await fs.unlink(this.guardPath);
    await files.syncDirectory(this.input.directory);
    if (this.state.swapIdentity) {
      if (!files.sameDirectory(await fs.lstat(this.paths.swap), this.state.swapIdentity)) throw failed();
      await fs.rm(this.paths.swap, { recursive: true });
      await files.syncDirectory(path.dirname(this.paths.swap));
    }
    if (!files.sameDirectory(await fs.lstat(this.paths.staging), this.state.stagingIdentity)) throw failed();
    await fs.rm(this.paths.staging, { recursive: true });
    await files.syncDirectory(this.input.directory);
    this.#closed = true;
    live.delete(this.input.directory + '/' + this.state.appUrn);
  }
  async close() {
    if (this.#busy) throw failed();
    if (!this.#closed) {
      this.#closed = true;
      live.delete(this.input.directory + '/' + this.state.appUrn);
    }
  }
  toJSON(): never {
    throw failed();
  }
}
