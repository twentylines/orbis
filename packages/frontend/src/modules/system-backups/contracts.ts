import { type } from 'arktype';

const count = 'number.integer >= 0 & number <= 9007199254740991' as const;
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const sha256 = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const progress = { completedBytes: count, totalBytes: type(count).or('null') };
const base = { id: uuid, createdAt: 'number > 0', updatedAt: 'number > 0', message: 'string <= 1024', ...progress } as const;
export const exportJobSchema = type({
  ...base,
  status: "'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'",
  stage: "'preparing' | 'inventory' | 'quiescing' | 'database' | 'copying' | 'archiving' | 'encrypting' | 'resuming' | 'complete'",
  needsRecovery: 'boolean',
  restartRequired: 'boolean',
});
export const reviewSchema = type({
  formatVersion: '1',
  createdAt: 'number > 0',
  orbisVersion: 'string <= 128',
  runtipiVersion: 'string <= 128',
  architecture: "'amd64' | 'arm64'",
  fileCount: count,
  appCount: count,
  expandedBytes: count,
  manifestSha256: sha256,
  databaseValidation: "'pending' | 'validated'",
  'databaseRecords?': count,
  compatibility: {
    compatible: 'boolean',
    blockers: type("'runtipi-version' | 'newer-orbis' | 'unknown-orbis-version'").array(),
    architectureChanged: 'boolean',
  },
});
export const importJobSchema = type({
  ...base,
  status: "'awaiting-upload' | 'uploading' | 'uploaded' | 'reviewing' | 'reviewed' | 'preparing' | 'failed' | 'cancelled'",
  stage: "'upload' | 'opening' | 'inspecting' | 'database' | 'complete'",
  uploadedBytes: count,
  'review?': reviewSchema,
  'reviewExpiresAt?': 'number > 0',
});
export const restoreJobSchema = type({
  id: uuid,
  status: "'ready' | 'running' | 'succeeded' | 'rolled-back' | 'recovery-required'",
  stage: 'string <= 64',
  phase: 'string <= 64',
  message: 'string <= 1024',
  needsRecovery: 'boolean',
  progressUnavailable: 'boolean',
  canCancel: 'boolean',
  canRecover: 'boolean',
  'updatedAt?': 'number > 0',
  'check?': 'string <= 40',
  'preparation?': {
    stage: "'checking' | 'files' | 'database' | 'sealing' | 'prepared'",
    ...progress,
    records: count,
    totalRecords: type(count).or('null'),
  },
});
export const exportListSchema = type({ available: 'boolean', retentionHours: count, jobs: exportJobSchema.array().atMostLength(32) });
export const importListSchema = type({ available: 'boolean', retentionHours: count, jobs: importJobSchema.array().atMostLength(32) });
export const restoreStatusSchema = type({ job: restoreJobSchema.or('null') });
export type ExportJob = typeof exportJobSchema.infer;
export type ImportJob = typeof importJobSchema.infer;
export type RestoreJob = typeof restoreJobSchema.infer;
export type BackupReview = typeof reviewSchema.infer;
export type BackupSnapshot = {
  exports: typeof exportListSchema.infer;
  imports: typeof importListSchema.infer;
  restore: typeof restoreStatusSchema.infer;
};

export function parseBackupResponse<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
  const result = schema(value);
  if (result instanceof type.errors) throw new Error('The server returned an unsupported backup response. Refresh Orbis and try again.');
  return result;
}

export function progressPercent(completed: number, total: number | null, settled = false): number | undefined {
  if (settled) return 100;
  if (total === null || total <= 0 || !Number.isSafeInteger(total) || !Number.isSafeInteger(completed) || completed < 0) return undefined;
  return Math.min(99, Math.floor((completed / total) * 100));
}

export function canRestore(job: ImportJob, now: number): boolean {
  return Boolean(
    job.status === 'reviewed' &&
      job.review?.databaseValidation === 'validated' &&
      job.review.compatibility.compatible &&
      job.review.compatibility.blockers.length === 0 &&
      job.reviewExpiresAt &&
      job.reviewExpiresAt > now,
  );
}

export function formatBackupBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`;
}

export function backupPollingInterval(snapshot: BackupSnapshot | undefined, visible: boolean): number | false {
  if (!visible) return false;
  const active =
    snapshot?.exports.jobs.some((job) => job.status === 'running' || job.needsRecovery || job.restartRequired) ||
    snapshot?.imports.jobs.some((job) => ['uploading', 'reviewing', 'preparing'].includes(job.status)) ||
    (snapshot?.restore.job && !['succeeded', 'rolled-back'].includes(snapshot.restore.job.status));
  return active ? 2500 : 30_000;
}
