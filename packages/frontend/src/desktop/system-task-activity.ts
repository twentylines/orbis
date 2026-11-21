import type { SettingsBackupJob } from '@runtipi/common/schemas/settings-backup';
import type { SettingsBackupImportJob, SettingsBackupRestoreJob } from '@runtipi/common/schemas/settings-backup-import';
import type { TimeMachineList } from '@runtipi/common/schemas/time-machine';
import { sentinelUpdateActive, type SentinelUpdateJob } from '@runtipi/common/schemas/sentinel-update-progress';
import { describeSentinelUpdate } from '@/modules/updates/sentinel-update-progress';
import { coreJobIsActive, validCoreUpdate, type CoreUpdateStatus } from './core-update-state';
import { readDownloadProgress } from './download-progress';

export type SystemActivityBucket = 'active' | 'review' | 'recent';
export type SystemActivityRecord = {
  key: string;
  feed: 'exports' | 'imports' | 'restore' | 'core' | 'points' | 'sentinel';
  title: string;
  status: string;
  state?: string;
  phase?: string;
  message?: string;
  bucket: SystemActivityBucket;
  time?: number;
  completed?: number;
  total?: number | null;
  path: string;
  action: string;
  stale?: boolean;
};
export type ActivitySourceIssue = { message: string; retry?: () => unknown };
export type SystemActivitySnapshot = {
  records: SystemActivityRecord[];
  notices: ActivitySourceIssue[];
  loading: boolean;
  incomplete: boolean;
};
const backups = '/settings?tab=backups#setting-server-backups';
export const systemActivitySort = (a: { time?: number }, b: { time?: number }) => (b.time ?? 0) - (a.time ?? 0);
export const settingsExportActive = (job: SettingsBackupJob) => job.status === 'queued' || job.status === 'running';
export const settingsImportActive = (job: SettingsBackupImportJob) => job.status === 'uploading' || job.status === 'reviewing';
export const systemActivityPollInterval = (enabled: boolean, failed: boolean, active: boolean) => (enabled && !failed && active ? 1500 : false);

export function systemActivityRecords(input: {
  exports?: SettingsBackupJob[];
  imports?: SettingsBackupImportJob[];
  restore?: SettingsBackupRestoreJob | null;
  core?: CoreUpdateStatus;
  coreStale?: boolean;
  points?: TimeMachineList;
  sentinel?: SentinelUpdateJob[];
}) {
  const records: SystemActivityRecord[] = [];
  for (const job of input.exports ?? []) {
    records.push({
      key: `export:${job.id}`,
      feed: 'exports',
      state: job.status,
      phase: job.stage,
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
      state: job.status,
      message: job.message,
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
      state: job.status,
      phase: job.stage,
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
      state: core.state,
      phase: core.phase ?? undefined,
      message: core.message,
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
  for (const job of input.sentinel ?? []) {
    const { status, detail } = describeSentinelUpdate(job);
    records.push({
      key: `sentinel:${job.id}`,
      feed: 'sentinel',
      state: job.phase,
      title: `Sentinel ${job.version}`,
      status,
      message: detail,
      bucket: sentinelUpdateActive(job) ? 'active' : ['prepared', 'complete'].includes(job.phase) ? 'recent' : 'review',
      time: job.updatedAt,
      path: '/updates',
      action: 'View Sentinel update',
    });
  }
  for (const point of input.points?.available ? input.points.points : []) {
    records.push({
      key: `point:${point.id}`,
      feed: 'points',
      state: point.status,
      phase: point.stage,
      message: point.issue?.message,
      title: 'Time Machine capture',
      status:
        point.status === 'capturing'
          ? 'Capturing'
          : point.status === 'sealed'
            ? 'Capture saved'
            : point.status === 'failed'
              ? 'Capture failed'
              : 'Capture interrupted',
      bucket: point.status === 'capturing' ? 'active' : point.status === 'sealed' ? 'recent' : 'review',
      time: point.createdAt,
      completed: point.completedBytes,
      total: point.totalBytes,
      path: '/settings?tab=time-machine',
      action: 'View Time Machine',
    });
  }
  return records.sort(systemActivitySort);
}
