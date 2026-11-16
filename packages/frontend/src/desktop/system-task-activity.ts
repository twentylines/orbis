import type { SettingsBackupJob } from '@runtipi/common/schemas/settings-backup';
import type { SettingsBackupImportJob, SettingsBackupRestoreJob } from '@runtipi/common/schemas/settings-backup-import';
import type { TimeMachineList } from '@runtipi/common/schemas/time-machine';
import { coreJobIsActive, validCoreUpdate, type CoreUpdateStatus } from './core-update-state';
import { readDownloadProgress } from './download-progress';

export type SystemActivityBucket = 'active' | 'review' | 'recent';
export type SystemActivityRecord = {
  key: string;
  feed: 'exports' | 'imports' | 'restore' | 'core' | 'points';
  title: string;
  status: string;
  bucket: SystemActivityBucket;
  time?: number;
  completed?: number;
  total?: number | null;
  path: string;
  action: string;
  stale?: boolean;
};
export type SystemActivitySnapshot = { records: SystemActivityRecord[]; notices: string[]; loading: boolean; incomplete: boolean };
const backups = '/settings?tab=backups#setting-server-backups';
export const systemActivitySort = (a: { time?: number }, b: { time?: number }) => (b.time ?? 0) - (a.time ?? 0);
export const settingsExportActive = (job: SettingsBackupJob) => job.status === 'queued' || job.status === 'running';
export const settingsImportActive = (job: SettingsBackupImportJob) => job.status === 'uploading' || job.status === 'reviewing';
export const systemActivityPollInterval = (enabled: boolean, failed: boolean, active: boolean) => (enabled && !failed && active ? 1500 : false);

export function boundedSystemActivity(records: SystemActivityRecord[]) {
  const counts = new Map<string, number>();
  return [...records].sort(systemActivitySort).filter((record) => {
    const key = `${record.feed}:${record.bucket}`;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    return count < 3;
  });
}

export function systemActivityRecords(input: {
  exports?: SettingsBackupJob[];
  imports?: SettingsBackupImportJob[];
  restore?: SettingsBackupRestoreJob | null;
  core?: CoreUpdateStatus;
  coreStale?: boolean;
  points?: TimeMachineList;
}) {
  const records: SystemActivityRecord[] = [];
  for (const job of input.exports ?? []) {
    records.push({
      key: `export:${job.id}`,
      feed: 'exports',
      title: 'Settings backup',
      status: {
        queued: 'Queued',
        running: 'Creating backup',
        ready: 'Backup ready',
        failed: 'Backup failed',
        interrupted: 'Backup interrupted',
        cancelled: 'Cancelled',
      }[job.status],
      bucket: settingsExportActive(job) ? 'active' : ['failed', 'interrupted'].includes(job.status) ? 'review' : 'recent',
      time: job.createdAt,
      completed: job.status === 'ready' ? job.bytes : job.completedBytes,
      total: job.status === 'ready' ? job.bytes : job.totalBytes,
      path: backups,
      action: 'View backup',
    });
  }
  for (const job of input.imports ?? []) {
    records.push({
      key: `import:${job.id}`,
      feed: 'imports',
      title: 'Settings backup import',
      status: {
        'awaiting-upload': 'Waiting for a file',
        uploading: 'Uploading',
        uploaded: 'Ready for review',
        reviewing: 'Reviewing backup',
        reviewed: 'Backup reviewed',
        failed: 'Import failed',
        consumed: 'Import used',
      }[job.status],
      bucket: settingsImportActive(job) ? 'active' : job.status === 'consumed' ? 'recent' : 'review',
      time: job.updatedAt,
      completed: job.completedBytes,
      total: job.totalBytes,
      path: backups,
      action: 'View backup',
    });
  }
  if (input.restore) {
    const job = input.restore;
    records.push({
      key: `restore:${job.id}`,
      feed: 'restore',
      title: 'Latest settings restore',
      status: {
        running: 'Restoring settings',
        succeeded: 'Restore completed',
        'rolled-back': 'Restore rolled back',
        'recovery-required': 'Recovery required',
      }[job.status],
      bucket: job.status === 'running' ? 'active' : job.needsRecovery ? 'review' : 'recent',
      path: backups,
      action: 'View restore',
    });
  }
  const core = input.core?.job;
  if (core && validCoreUpdate(core.id, core.targetTag)) {
    const download = readDownloadProgress(core.download);
    const states: Record<string, string> = {
      queued: 'Queued',
      running: 'Updating',
      recovering: 'Recovering',
      complete: 'Update completed',
      succeeded: 'Update completed',
      failed: 'Update failed',
      interrupted: 'Update interrupted',
      'rolled-back': 'Update rolled back',
    };
    records.push({
      key: `core:${core.id}`,
      feed: 'core',
      title: `Orbis ${core.targetTag}`,
      status: states[core.state] ?? 'Status not confirmed',
      bucket: coreJobIsActive(core) ? 'active' : ['complete', 'succeeded', 'rolled-back'].includes(core.state) ? 'recent' : 'review',
      ...(typeof core.startedAt === 'number' && core.startedAt > 0 ? { time: core.startedAt } : {}),
      ...(download ? { completed: download.currentBytes, total: download.totalBytes } : {}),
      path: '/updates',
      action: 'View update',
      stale: input.coreStale,
    });
  }
  for (const point of input.points?.available ? input.points.points : []) {
    if (point.status === 'capturing') continue;
    records.push({
      key: `point:${point.id}`,
      feed: 'points',
      title: 'Time Machine capture',
      status: point.status === 'sealed' ? 'Capture saved' : point.status === 'failed' ? 'Capture failed' : 'Capture interrupted',
      bucket: point.status === 'sealed' ? 'recent' : 'review',
      time: point.createdAt,
      completed: point.completedBytes,
      total: point.totalBytes,
      path: '/settings?tab=time-machine',
      action: 'View Time Machine',
    });
  }
  return boundedSystemActivity(records);
}
