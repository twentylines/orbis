import type { RestoreJob } from '@/modules/system-backups/contracts';

const preparationStages: Record<NonNullable<RestoreJob['preparation']>['stage'], string> = {
  checking: 'Checking backup',
  files: 'Preparing files',
  database: 'Preparing database',
  sealing: 'Finishing preparation',
  prepared: 'Preparation complete',
};
const restoreStages: Record<string, string> = {
  quiescing: 'Stopping apps',
  restoring: 'Restoring server',
  recovering: 'Restoring previous state',
  restarting: 'Restarting server',
};
function bytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(size)} ${units[unit]}`;
}
const failureReasons: Record<string, string> = {
  'transaction-start': 'Restore preparation could not finish.',
  'stop-writers': 'Apps could not be safely stopped for restoration.',
  'promote-roots': 'The backup files could not be applied.',
  'database-pointer': 'The restored database could not be selected.',
  'verify-candidate': 'The restored server did not pass its startup checks.',
  'commit-decision': 'Restore completion could not be confirmed.',
  'rollback-recovery': 'Recovery of the previous server needs review.',
  'host-identity-required': 'The server identity could not be verified.',
  'host-identity-changed': 'The server identity changed during restoration.',
  'verifier-startup-failed': 'The restored server could not be started for verification.',
  'verifier-env-readonly': 'The restored server could not read its protected configuration.',
  'verifier-health-timeout': 'The restored server did not become healthy in time.',
};
export function restoreFailureReason(job: Pick<RestoreJob, 'status' | 'needsRecovery' | 'check'>): string | undefined {
  if (job.status !== 'rolled-back' && job.status !== 'recovery-required' && !job.needsRecovery) return undefined;
  return job.check ? failureReasons[job.check] : undefined;
}
export function restorePresentation(job: RestoreJob, reconnecting: boolean) {
  const terminal = job.status === 'succeeded' || job.status === 'rolled-back';
  const recovery = job.status === 'recovery-required' || job.needsRecovery;
  const prep = job.preparation && job.stage === job.preparation.stage ? job.preparation : undefined;
  const title = reconnecting
    ? 'Reconnecting'
    : job.status === 'succeeded'
      ? 'Restore complete'
      : job.status === 'rolled-back'
        ? 'Previous state restored'
        : recovery
          ? 'Recovery needed'
          : 'Restoring';
  const status = reconnecting
    ? 'Connecting to your server'
    : recovery
      ? 'Restore could not finish'
      : job.status === 'succeeded'
        ? 'Your server is ready'
        : job.status === 'rolled-back'
          ? 'Your previous state has been restored'
          : prep
            ? preparationStages[prep.stage]
            : (restoreStages[job.stage] ?? 'Restoring your server');
  let detail: string | undefined;
  if (!reconnecting && !recovery && !terminal && prep?.stage === 'files' && prep.completedBytes > 0) {
    detail =
      prep.totalBytes !== null ? `${bytes(prep.completedBytes)} of ${bytes(prep.totalBytes)} prepared` : `${bytes(prep.completedBytes)} prepared`;
  } else if (!reconnecting && !recovery && !terminal && prep?.stage === 'database' && prep.records > 0) {
    const count = new Intl.NumberFormat();
    detail =
      prep.totalRecords !== null
        ? `${count.format(prep.records)} of ${count.format(prep.totalRecords)} records prepared`
        : `${count.format(prep.records)} records prepared`;
  } else if (!reconnecting && !recovery && !terminal && job.progressUnavailable) detail = 'Waiting for progress';
  if (!reconnecting && (terminal || recovery)) detail = restoreFailureReason(job);
  return {
    title,
    status,
    detail,
    progress: terminal
      ? 100
      : !reconnecting && !recovery && prep?.stage === 'files'
        ? measuredPercent(prep.completedBytes, prep.totalBytes)
        : undefined,
    active: !terminal && !recovery && !reconnecting,
  };
}

export function measuredPercent(completed: number, total: number | null): number | undefined {
  if (!Number.isSafeInteger(completed) || completed < 0 || total === null || !Number.isSafeInteger(total) || total <= 0 || completed > total)
    return undefined;
  return Math.min(99, Math.floor((completed / total) * 100));
}
