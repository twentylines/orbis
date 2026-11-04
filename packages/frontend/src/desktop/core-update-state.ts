import { lt, valid } from 'semver';
import { readDownloadProgress, type DownloadProgress } from './download-progress';

export type CoreUpdateOperation = 'update' | 'downgrade';

export type CoreUpdateJob = {
  id: string;
  state: string;
  targetTag: string;
  startedAt?: number;
  message?: string;
  phase?: string | null;
  download?: DownloadProgress;
};
export type CoreUpdateStatus = {
  available: boolean;
  enrolled?: boolean;
  currentTag?: string | null;
  coreState?: string;
  coreHealth?: string;
  imageMatches?: boolean;
  reason?: string;
  job?: CoreUpdateJob | null;
};
export type CoreUpdateWatch = {
  id: string;
  targetTag: string;
  phase: 'downloading' | 'updating' | 'offline' | 'checking' | 'failed' | 'ready' | 'returned';
  returnedTag?: string;
  outcome?: 'rolled-back' | 'aborted';
  message: string;
  refreshIssued: boolean;
  download?: DownloadProgress;
  operation?: CoreUpdateOperation;
};
export type CoreUpdateEvent =
  | { type: 'accepted'; id: string; targetTag: string; operation?: CoreUpdateOperation }
  | { type: 'unavailable' }
  | { type: 'status'; status: CoreUpdateStatus; buildTag?: string };

const jobId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releaseTag = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;
export const coreJobIsActive = (job?: CoreUpdateJob | null) => ['queued', 'running', 'recovering'].includes(job?.state ?? '');
export const coreWatchIsActive = (watch: CoreUpdateWatch | null) => Boolean(watch && !watch.refreshIssued && watch.phase !== 'failed');
export const validCoreUpdate = (id: string, targetTag: string) => jobId.test(id) && releaseTag.test(targetTag);
export const coreUpdateTitle = (phase: CoreUpdateWatch['phase'], operation: CoreUpdateOperation = 'update') =>
  phase === 'downloading'
    ? 'Downloading Orbis'
    : phase === 'offline'
      ? 'Restarting Orbis'
      : phase === 'checking' || phase === 'ready' || phase === 'returned'
        ? 'Starting Orbis'
        : operation === 'downgrade'
          ? 'Downgrading Orbis'
          : 'Updating Orbis';

const restartingMessage = 'The page will reload automatically when Orbis is ready.';

export function advanceCoreUpdate(watch: CoreUpdateWatch | null, event: CoreUpdateEvent): CoreUpdateWatch | null {
  if (event.type === 'accepted') {
    if (!validCoreUpdate(event.id, event.targetTag)) return watch;
    if (watch?.id === event.id) return watch;
    return {
      id: event.id,
      targetTag: event.targetTag,
      phase: 'updating',
      message: event.operation === 'downgrade' ? 'Starting the reviewed Orbis downgrade. Applications keep running.' : 'Starting the Orbis update.',
      refreshIssued: false,
      ...(event.operation === 'downgrade' ? { operation: event.operation } : {}),
    };
  }
  if (event.type === 'unavailable') {
    return coreWatchIsActive(watch) && watch ? { ...watch, phase: 'offline', message: restartingMessage } : watch;
  }
  const { status, buildTag } = event;
  const job = status.job;
  let next = watch;
  if ((!next || next.phase === 'failed' || next.refreshIssued) && job && coreJobIsActive(job) && validCoreUpdate(job.id, job.targetTag)) {
    // A completed job alone never arms a refresh when opening or revisiting Orbis.
    if (next?.id !== job.id)
      next = advanceCoreUpdate(null, {
        type: 'accepted',
        id: job.id,
        targetTag: job.targetTag,
        operation:
          status.currentTag && valid(status.currentTag) && valid(job.targetTag) && lt(job.targetTag, status.currentTag) ? 'downgrade' : 'update',
      });
  }
  if (!next || next.refreshIssued) return next;
  if (!status.available) return { ...next, phase: 'offline', message: restartingMessage };
  if (job?.id !== next.id)
    return next.phase === 'ready' || next.phase === 'returned'
      ? { ...next, phase: 'checking', message: 'Checking the requested Orbis update.' }
      : next;
  if (job.targetTag !== next.targetTag) return { ...next, phase: 'checking', message: 'Checking the requested Orbis release.' };
  next = { ...next, returnedTag: undefined, outcome: undefined, download: readDownloadProgress(job.download) };
  if (['failed', 'interrupted', 'rolled-back'].includes(job.state)) {
    const outcome = job.state === 'rolled-back' ? 'rolled-back' : job.state === 'failed' && job.phase === 'aborted' ? 'aborted' : undefined;
    const currentTag = typeof status.currentTag === 'string' ? status.currentTag : '';
    const healthyCurrent =
      status.enrolled === true &&
      status.imageMatches === true &&
      status.coreState === 'running' &&
      status.coreHealth === 'healthy' &&
      releaseTag.test(currentTag) &&
      Boolean(valid(currentTag)) &&
      currentTag === buildTag;
    if (outcome && healthyCurrent) {
      const action = next.operation === 'downgrade' ? 'downgrade' : 'update';
      return {
        ...next,
        phase: 'returned',
        returnedTag: currentTag,
        outcome,
        message:
          outcome === 'rolled-back'
            ? `The ${action} did not complete. Orbis ${currentTag} was restored. Returning to your dashboard.`
            : `The ${action} stopped before restart. Orbis ${currentTag} is still running. Returning to your dashboard.`,
      };
    }
    return { ...next, phase: 'failed', message: job.message || 'The update needs review in Updates.' };
  }
  if (job.state !== 'complete' && job.phase === 'restarting') return { ...next, phase: 'offline', message: restartingMessage };
  if (job.state !== 'complete' && job.phase === 'verifying')
    return { ...next, phase: 'checking', message: 'Starting Orbis and checking server health.' };
  if (!status.available || status.coreState !== 'running' || status.coreHealth !== 'healthy') {
    return { ...next, phase: 'offline', message: restartingMessage };
  }
  if (job.state === 'complete') {
    const healthyTarget =
      status.enrolled === true && status.imageMatches === true && status.currentTag === next.targetTag && buildTag === next.targetTag;
    return {
      ...next,
      phase: healthyTarget ? 'ready' : 'checking',
      message: healthyTarget ? 'The update is ready. Refreshing Orbis.' : 'Checking the updated server before refreshing.',
    };
  }
  return {
    ...next,
    phase: job.phase === 'downloading' ? 'downloading' : 'updating',
    message:
      job.phase === 'downloading'
        ? `Downloading ${next.targetTag}. Applications keep running.`
        : job.message ||
          (next.operation === 'downgrade'
            ? 'Installing the earlier Orbis release. Applications keep running.'
            : 'Orbis is updating. Applications keep running.'),
  };
}

export function resumeCoreUpdate(
  marker: {
    jobId: string;
    operation: string;
    targetTag?: string;
    corePhase?: CoreUpdateWatch['phase'];
  } | null,
): CoreUpdateWatch | null {
  if (!marker?.targetTag || !['update', 'downgrade'].includes(marker.operation)) return null;
  const watch = advanceCoreUpdate(null, {
    type: 'accepted',
    id: marker.jobId,
    targetTag: marker.targetTag,
    operation: marker.operation as CoreUpdateOperation,
  });
  return watch
    ? { ...watch, phase: ['ready', 'returned', 'failed'].includes(marker.corePhase ?? '') ? 'checking' : (marker.corePhase ?? watch.phase) }
    : null;
}

export function claimCoreRefresh(watch: CoreUpdateWatch | null, alreadyRefreshed: ReadonlySet<string>) {
  if (!watch || !['ready', 'returned'].includes(watch.phase) || watch.refreshIssued) return { watch, refresh: false };
  return { watch: { ...watch, refreshIssued: true }, refresh: !alreadyRefreshed.has(watch.id) };
}
