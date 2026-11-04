import { advanceCoreUpdate, validCoreUpdate, type CoreUpdateWatch } from './core-update-state';
import { readDownloadProgress, type DownloadProgress } from './download-progress';

export type CoreOperationProgress = {
  version: 1;
  job: {
    id: string;
    state: 'queued' | 'running' | 'recovering' | 'complete' | 'failed' | 'interrupted';
    targetTag: string;
    phase: 'downloading' | 'installing' | 'restarting' | 'verifying' | 'recovering' | null;
    download?: DownloadProgress;
  } | null;
};

export function parseCoreOperationProgress(value: unknown): CoreOperationProgress {
  const invalid = () => new Error('Update progress is unavailable.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || Object.keys(item).length !== 2 || !('job' in item)) throw invalid();
  if (item.job === null) return { version: 1, job: null };
  if (!item.job || typeof item.job !== 'object' || Array.isArray(item.job)) throw invalid();
  const job = item.job as Record<string, unknown>;
  if (
    Object.keys(job).some((key) => !['id', 'state', 'targetTag', 'phase', 'download'].includes(key)) ||
    typeof job.id !== 'string' ||
    typeof job.targetTag !== 'string' ||
    job.targetTag.length > 128 ||
    !validCoreUpdate(job.id, job.targetTag) ||
    typeof job.state !== 'string' ||
    !['queued', 'running', 'recovering', 'complete', 'failed', 'interrupted'].includes(job.state) ||
    !(
      job.phase === null ||
      (typeof job.phase === 'string' && ['downloading', 'installing', 'restarting', 'verifying', 'recovering'].includes(job.phase))
    )
  )
    throw invalid();
  const download = job.download === undefined ? undefined : readDownloadProgress(job.download);
  if (job.download !== undefined && !download) throw invalid();
  if (
    download &&
    Object.keys(download).some(
      (key) =>
        !['schema', 'phase', 'currentBytes', 'totalBytes', 'totalKnown', 'alreadyCached', 'layersComplete', 'layersTotal', 'updatedAt'].includes(key),
    )
  )
    throw invalid();
  return {
    version: 1,
    job: {
      id: job.id,
      state: job.state as NonNullable<CoreOperationProgress['job']>['state'],
      targetTag: job.targetTag,
      phase: job.phase as NonNullable<CoreOperationProgress['job']>['phase'],
      ...(download ? { download } : {}),
    },
  };
}

export async function readCoreOperationProgress(): Promise<CoreOperationProgress> {
  const response = await fetch('/api/system/core-update-progress', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error('Update progress is unavailable.');
  if (!response.body) throw new Error('Update progress is unavailable.');
  const reader = response.body.getReader();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024) throw new Error('Update progress is unavailable.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return parseCoreOperationProgress(JSON.parse(text));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Progress cannot certify a healthy target or authorize leaving maintenance.
export function observeCoreOperationProgress(watch: CoreUpdateWatch | null, progress: CoreOperationProgress): CoreUpdateWatch | null {
  const job = progress.job;
  if (!job || (watch && (watch.id !== job.id || watch.targetTag !== job.targetTag || watch.refreshIssued))) return watch;
  if (!watch && !['queued', 'running', 'recovering'].includes(job.state)) return null;
  const current = watch ?? advanceCoreUpdate(null, { type: 'accepted', id: job.id, targetTag: job.targetTag });
  if (!current) return null;
  const next = { ...current, download: job.download };
  if (['failed', 'interrupted'].includes(job.state)) return { ...next, phase: 'failed', message: 'The update stopped. Open Updates to review it.' };
  if (job.state === 'complete' || job.phase === 'verifying') return { ...next, phase: 'checking', message: 'Orbis will reload automatically.' };
  if (job.phase === 'restarting') return { ...next, phase: 'offline', message: 'Orbis will reload automatically.' };
  if (job.phase === 'downloading') return { ...next, phase: 'downloading', message: 'Downloading the update.' };
  if (job.phase === 'installing') return { ...next, phase: 'updating', message: 'Installing the update.' };
  if (job.phase === 'recovering' || job.state === 'recovering') return { ...next, phase: 'checking', message: 'Restoring the previous version.' };
  return current;
}
