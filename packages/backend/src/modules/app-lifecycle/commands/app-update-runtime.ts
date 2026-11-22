import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { createHash } from 'node:crypto';
import type { AppUpdateStage } from '../../docker/app-update-stage';
import type { AppUpdateContext } from '../../docker/app-update-stage';
import { migrationEngineRequest, migrationRecord } from '../../docker/app-migration-engine';
const recovery = () => new Error('The app update runtime could not be verified. Its saved files and any new writes were kept.');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function currentContainers(docker: Dockerode, appUrn: AppUrn) {
  const project = appUrn.replace(':', '_');
  const signal = AbortSignal.timeout(30_000);
  const listed = await migrationEngineRequest(
    docker,
    '/containers/json?',
    'GET',
    { all: true, filters: JSON.stringify({ label: [`com.docker.compose.project=${project}`] }) },
    signal,
  );
  if (
    !Array.isArray(listed) ||
    listed.length > 256 ||
    listed.some((item) => !migrationRecord(item) || typeof item.Id !== 'string') ||
    new Set(listed.map(({ Id }) => Id)).size !== listed.length
  )
    throw recovery();
  const values: Dockerode.ContainerInspectInfo[] = [];
  for (const { Id } of listed) {
    if (!/^[a-f0-9]{64}$/.test(Id)) throw recovery();
    const raw = await migrationEngineRequest(docker, `/containers/${Id}/json`, 'GET', {}, signal);
    if (
      !migrationRecord(raw) ||
      Buffer.byteLength(JSON.stringify(raw)) > 2 * 1024 * 1024 ||
      !migrationRecord(raw.Config) ||
      !migrationRecord(raw.Config.Labels) ||
      !migrationRecord(raw.State)
    )
      throw recovery();
    const value = raw as unknown as Dockerode.ContainerInspectInfo;
    const labels = value.Config?.Labels;
    if (
      value.Id !== Id ||
      !labels ||
      labels['runtipi.managed'] !== 'true' ||
      labels['runtipi.appurn'] !== appUrn ||
      labels['com.docker.compose.project'] !== project ||
      typeof labels['com.docker.compose.service'] !== 'string' ||
      !value.State ||
      ['Running', 'Paused', 'Restarting', 'Dead'].some((key) => typeof Reflect.get(value.State, key) !== 'boolean') ||
      !Number.isSafeInteger(value.State.Pid)
    )
      throw recovery();
    values.push(value);
  }
  return values;
}
export function originalStopped(values: Dockerode.ContainerInspectInfo[], context: AppUpdateContext) {
  if (!equal(values.map(({ Id }) => Id).sort(), context.originalContainers.map(({ id }) => id).sort())) throw recovery();
  for (const value of values) {
    const expected = context.originalContainers.find(({ id }) => id === value.Id);
    if (
      !expected ||
      value.Image !== expected.imageId ||
      value.Config.Labels?.['com.docker.compose.service'] !== expected.service ||
      value.State.Running ||
      value.State.Paused ||
      value.State.Restarting ||
      value.State.Dead ||
      value.State.Pid !== 0
    )
      throw recovery();
  }
}
function targetHealthy(values: Dockerode.ContainerInspectInfo[], context: AppUpdateContext, stageId: string, images: Record<string, string>) {
  const covered = new Set<string>();
  for (const value of values) {
    const service = value.Config.Labels?.['com.docker.compose.service'];
    if (
      !service ||
      !Object.hasOwn(images, service) ||
      value.Image !== images[service] ||
      value.Config.Labels?.['io.orbis.app-update.stage'] !== stageId ||
      context.originalContainers.some(({ id }) => id === value.Id) ||
      !value.State.Running ||
      value.State.Paused ||
      value.State.Restarting ||
      value.State.Dead ||
      value.State.Pid <= 0 ||
      (value.State.Health && value.State.Health.Status !== 'healthy')
    )
      throw recovery();
    covered.add(service);
  }
  if (!equal([...covered].sort(), Object.keys(images).sort())) throw recovery();
}

export async function verifyAppUpdateRuntime(
  docker: Dockerode,
  appUrn: AppUrn,
  context: AppUpdateContext,
  stageId: string,
  images: Record<string, string>,
) {
  const current = await currentContainers(docker, appUrn);
  if (context.updateStatus === 'running') targetHealthy(current, context, stageId, images);
  else originalStopped(current, context);
}

/** Only preparation before checkpoint capture may finish stopping the original saved deployment. */
export async function stopOriginalUpdateRuntime(docker: Dockerode, appUrn: AppUrn, context: AppUpdateContext) {
  const values = await currentContainers(docker, appUrn);
  if (!equal(values.map(({ Id }) => Id).sort(), context.originalContainers.map(({ id }) => id).sort())) throw recovery();
  for (const value of values) {
    const expected = context.originalContainers.find(({ id }) => id === value.Id);
    if (
      !expected ||
      value.Image !== expected.imageId ||
      value.Config.Labels?.['com.docker.compose.service'] !== expected.service ||
      value.State.Dead ||
      ((value.State.Running || value.State.Paused || value.State.Restarting) && !(expected.running || expected.paused || expected.restarting))
    )
      throw recovery();
  }
  const signal = AbortSignal.timeout(60_000);
  for (const value of values) {
    if (value.State.Paused) await migrationEngineRequest(docker, `/containers/${value.Id}/unpause?`, 'POST', {}, signal);
    if (value.State.Running || value.State.Paused || value.State.Restarting)
      await migrationEngineRequest(docker, `/containers/${value.Id}/stop?`, 'POST', { t: 30 }, signal);
  }
  originalStopped(await currentContainers(docker, appUrn), context);
}

function originalIdentity(values: Dockerode.ContainerInspectInfo[], context: AppUpdateContext) {
  if (!equal(values.map(({ Id }) => Id).sort(), context.originalContainers.map(({ id }) => id).sort())) throw recovery();
  for (const value of values) {
    const expected = context.originalContainers.find(({ id }) => id === value.Id);
    if (
      !expected ||
      value.Image !== expected.imageId ||
      value.Config.Labels?.['com.docker.compose.service'] !== expected.service ||
      value.State.Dead ||
      typeof value.State.StartedAt !== 'string' ||
      !value.State.StartedAt ||
      value.State.StartedAt.length > 128
    )
      throw recovery();
  }
}
function desiredOriginal(value: Dockerode.ContainerInspectInfo, wanted: AppUpdateContext['originalContainers'][number]) {
  return wanted.running || wanted.paused || wanted.restarting
    ? value.State.Running && value.State.Pid > 0 && !value.State.Restarting && value.State.Paused === wanted.paused && !value.State.Dead
    : !value.State.Running && !value.State.Paused && !value.State.Restarting && !value.State.Dead && value.State.Pid === 0;
}
const originalProof = (value: Dockerode.ContainerInspectInfo) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        id: value.Id,
        image: value.Image,
        service: value.Config.Labels?.['com.docker.compose.service'],
        startedAt: value.State.StartedAt,
        running: value.State.Running,
        paused: value.State.Paused,
        restarting: value.State.Restarting,
        dead: value.State.Dead,
        pid: value.State.Pid,
      }),
    )
    .digest('hex');

export async function verifyOriginalRollbackRuntime(docker: Dockerode, appUrn: AppUrn, context: AppUpdateContext) {
  const values = await currentContainers(docker, appUrn);
  originalIdentity(values, context);
  if (
    values.some((value) => {
      const expected = context.originalContainers.find(({ id }) => id === value.Id);
      return !expected || !desiredOriginal(value, expected);
    })
  )
    throw recovery();
  return values;
}

/** Every possible old-container start/pause is journaled first. A lost reply is reconciled only from positive current state. */
export async function restoreOriginalRollbackRuntime(docker: Dockerode, appUrn: AppUrn, stage: AppUpdateStage) {
  const initial = await stage.read();
  const context = initial.context;
  if (!context || initial.phase !== 'rolled-back' || initial.rollback?.phase !== 'retained') throw recovery();
  originalIdentity(await currentContainers(docker, appUrn), context);
  for (const expected of context.originalContainers) {
    let values = await currentContainers(docker, appUrn);
    originalIdentity(values, context);
    let current = values.find(({ Id }) => Id === expected.id);
    if (!current) throw recovery();
    let recorded = (await stage.read()).rollback?.runtime[expected.id];
    if (!desiredOriginal(current, expected) && !(expected.running || expected.paused || expected.restarting)) throw recovery();
    if (!current.State.Running && (expected.running || expected.paused || expected.restarting)) {
      if (recorded || current.State.Paused || current.State.Restarting || current.State.Pid !== 0) throw recovery();
      await stage.recordRollbackRuntime(expected.id, { phase: 'start-intent', startedAt: current.State.StartedAt, proofSha256: null });
      await migrationEngineRequest(docker, `/containers/${expected.id}/start?`, 'POST', {}, AbortSignal.timeout(30_000)).catch(() => undefined);
      values = await currentContainers(docker, appUrn);
      originalIdentity(values, context);
      current = values.find(({ Id }) => Id === expected.id);
      if (!current) throw recovery();
      recorded = (await stage.read()).rollback?.runtime[expected.id];
    }
    if (current.State.Running && expected.paused && !current.State.Paused) {
      if (recorded && recorded.phase !== 'start-intent') throw recovery();
      await stage.recordRollbackRuntime(expected.id, { phase: 'pause-intent', startedAt: current.State.StartedAt, proofSha256: null });
      await migrationEngineRequest(docker, `/containers/${expected.id}/pause?`, 'POST', {}, AbortSignal.timeout(30_000)).catch(() => undefined);
      values = await currentContainers(docker, appUrn);
      originalIdentity(values, context);
      current = values.find(({ Id }) => Id === expected.id);
      if (!current) throw recovery();
    }
    if (!desiredOriginal(current, expected)) throw recovery();
    await stage.recordRollbackRuntime(expected.id, { phase: 'verified', startedAt: current.State.StartedAt, proofSha256: originalProof(current) });
  }
  await verifyOriginalRollbackRuntime(docker, appUrn, context);
}
