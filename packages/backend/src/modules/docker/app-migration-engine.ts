import path from 'node:path';
import type Dockerode from 'dockerode';
import type { MigrationJournalState } from '../backups/app-migration-journal';
import type { AppStorageObservation } from '../host-updates/app-storage-observation';

export const migrationEngineFailure = () => new Error('The app migration requires verified recovery. Keep its operation record and any checkpoint.');
export const migrationRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const id = /^[a-f0-9]{64}$/;
export class MigrationEngineError extends Error {
  constructor(readonly statusCode?: number) {
    super(migrationEngineFailure().message);
  }
}

export async function migrationEngineRequest(
  docker: Pick<Dockerode, 'modem'>,
  path: string,
  method: string,
  options: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      reject(new MigrationEngineError());
    };
    signal.addEventListener('abort', abort, { once: true });
    const callback = (error: unknown, value: unknown) => {
      signal.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (error || signal.aborted)
        reject(new MigrationEngineError(migrationRecord(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined));
      else resolve(value);
    };
    try {
      docker.modem.dial(
        {
          path,
          method,
          options,
          abortSignal: signal,
          statusCodes: { 200: true, 201: true, 204: true, 304: true, 400: 'Unavailable', 404: 'Unavailable', 409: 'Unavailable', 500: 'Unavailable' },
        },
        callback,
      );
    } catch {
      callback(new MigrationEngineError(), undefined);
    }
  });
}

export async function inspectMigrationContainer(docker: Pick<Dockerode, 'modem'>, containerId: string, signal: AbortSignal) {
  if (!id.test(containerId)) throw migrationEngineFailure();
  try {
    const result = await migrationEngineRequest(docker, `/containers/${containerId}/json`, 'GET', {}, signal);
    if (!migrationRecord(result) || result.Id !== containerId || Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
      throw migrationEngineFailure();
    return result;
  } catch (error) {
    if (error instanceof MigrationEngineError && error.statusCode === 404) return null;
    throw error;
  }
}

export const migrationStopped = (value: unknown) =>
  migrationRecord(value) &&
  value.Running === false &&
  value.Restarting === false &&
  value.Paused === false &&
  value.Dead === false &&
  value.Pid === 0;

/** The checkpoint and every script start require the same original writers to remain stopped. */
async function requireMigrationWriters(
  docker: Pick<Dockerode, 'modem'>,
  state: Readonly<MigrationJournalState>,
  observation: Readonly<AppStorageObservation>,
  allowOriginalActivity: boolean,
) {
  const signal = AbortSignal.timeout(30_000);
  const project = state.operation.appUrn.replace(':', '_');
  const values = await migrationEngineRequest(
    docker,
    '/containers/json?',
    'GET',
    { all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) },
    signal,
  );
  if (
    !Array.isArray(values) ||
    values.length > 256 ||
    values.some((item) => !migrationRecord(item) || typeof item.Id !== 'string' || !id.test(item.Id))
  )
    throw migrationEngineFailure();
  const actual = values.map((item) => item.Id).sort();
  const expected = state.operation.originalContainers.map((item) => item.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw migrationEngineFailure();
  for (const original of state.operation.originalContainers) {
    const value = await inspectMigrationContainer(docker, original.id, signal);
    if (
      !value ||
      value.Image !== original.imageId ||
      (!allowOriginalActivity && !migrationStopped(value.State)) ||
      (allowOriginalActivity &&
        (!migrationRecord(value.State) ||
          value.State.Dead !== false ||
          !Number.isSafeInteger(value.State.Pid) ||
          ['Running', 'Paused', 'Restarting'].some((key) => typeof Reflect.get(value.State as object, key) !== 'boolean'))) ||
      !migrationRecord(value.Config) ||
      !migrationRecord(value.Config.Labels)
    )
      throw migrationEngineFailure();
    const labels = value.Config.Labels;
    if (
      labels['runtipi.managed'] !== 'true' ||
      labels['runtipi.appurn'] !== state.operation.appUrn ||
      labels['com.docker.compose.project'] !== project ||
      labels['com.docker.compose.service'] !== original.service
    )
      throw migrationEngineFailure();
    if (!Array.isArray(value.Mounts) || value.Mounts.length > 256) throw migrationEngineFailure();
    for (const mount of value.Mounts) {
      if (
        !migrationRecord(mount) ||
        mount.Type !== 'bind' ||
        typeof mount.Source !== 'string' ||
        !path.posix.isAbsolute(mount.Source) ||
        path.posix.normalize(mount.Source) !== mount.Source ||
        typeof mount.RW !== 'boolean'
      )
        throw migrationEngineFailure();
      const source = mount.Source;
      if (mount.RW && mount.Source !== observation.hostPath && !mount.Source.startsWith(observation.hostPath + '/')) throw migrationEngineFailure();
      if (
        ['/proc', '/sys', '/dev', '/run/orbis', '/run/docker.sock', '/var/run/docker.sock'].some(
          (root) => source === root || source.startsWith(root + '/'),
        )
      )
        throw migrationEngineFailure();
    }
  }
  // A stopped Compose project is insufficient if another container shares its writable data.
  const all = await migrationEngineRequest(docker, '/containers/json?', 'GET', { all: true }, signal);
  if (!Array.isArray(all) || all.length > 4096) throw migrationEngineFailure();
  const seen = new Set<string>();
  for (const item of all) {
    if (!migrationRecord(item) || typeof item.Id !== 'string' || !id.test(item.Id) || seen.has(item.Id)) throw migrationEngineFailure();
    seen.add(item.Id);
    if (item.Id === observation.controller.id || expected.includes(item.Id)) continue;
    const value = await inspectMigrationContainer(docker, item.Id, signal);
    if (!value || !Array.isArray(value.Mounts) || value.Mounts.length > 256) throw migrationEngineFailure();
    const owned = state.runners.some((row) => {
      const image = state.operation.images.find(({ migrationId }) => migrationId === row.migrationId);
      if (
        !image ||
        value.Image !== image.imageId ||
        value.Name !== '/' + row.name ||
        !migrationRecord(value.Config) ||
        !migrationRecord(value.Config.Labels)
      )
        return false;
      if (row.containerId !== item.Id && !(row.containerId === null && row.phase === 'create-intent')) return false;
      const labels = value.Config.Labels;
      return (
        labels['io.orbis.app-migration'] === 'v1' &&
        labels['io.orbis.app-migration.app'] === state.operation.appUrn &&
        labels['io.orbis.app-migration.request'] === state.operation.requestId &&
        labels['io.orbis.app-migration.stage'] === state.operation.stageId &&
        labels['io.orbis.app-migration.migration'] === row.migrationId &&
        labels['io.orbis.app-migration.nonce'] === row.nonce
      );
    });
    for (const mount of value.Mounts) {
      if (!migrationRecord(mount) || typeof mount.RW !== 'boolean') throw migrationEngineFailure();
      if (!mount.RW || mount.Type !== 'bind') continue;
      if (typeof mount.Source !== 'string' || !path.posix.isAbsolute(mount.Source) || path.posix.normalize(mount.Source) !== mount.Source)
        throw migrationEngineFailure();
      if (
        !owned &&
        (mount.Source === observation.hostPath ||
          mount.Source.startsWith(observation.hostPath + '/') ||
          observation.hostPath.startsWith(mount.Source === '/' ? '/' : mount.Source + '/'))
      )
        throw migrationEngineFailure();
    }
  }
  if (expected.some((containerId) => !seen.has(containerId))) throw migrationEngineFailure();
}

export function requireMigrationAppStopped(
  docker: Pick<Dockerode, 'modem'>,
  state: Readonly<MigrationJournalState>,
  observation: Readonly<AppStorageObservation>,
) {
  return requireMigrationWriters(docker, state, observation, false);
}
/** After a proven rollback, original writers may resume; all other storage/ownership checks remain identical. */
export function requireMigrationRollbackWriters(
  docker: Pick<Dockerode, 'modem'>,
  state: Readonly<MigrationJournalState>,
  observation: Readonly<AppStorageObservation>,
) {
  if (
    state.targetWritesPossible ||
    state.commitAttempted ||
    !(
      state.phase === 'restored' ||
      (['allocated', 'capturing', 'ready'].includes(state.phase) && state.runners.length === 0 && state.restores.length === 0)
    )
  )
    throw migrationEngineFailure();
  return requireMigrationWriters(docker, state, observation, true);
}
