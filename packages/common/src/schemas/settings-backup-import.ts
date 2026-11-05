import { type } from 'arktype';
import { settingsBackupSelectionSchema } from './settings-backup.js';

const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const bytes = type('0 <= number.integer <= 2200101191680');
const timestamp = type('0 < number.integer <= 9007199254740991');
const version = type('string').narrow((value) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value));
const content = type({
  kind: type.enumerated('settings', 'dashboard', 'wallpapers', 'themes', 'time-machine'),
  id: uuid.or('null'),
  bytes,
  items: '0 <= number.integer <= 250000',
  'pointId?': uuid,
  'capturedAt?': timestamp,
  'orbisVersion?': version,
})
  .onUndeclaredKey('reject')
  .narrow((value) =>
    value.kind === 'time-machine'
      ? value.id !== null && value.pointId === value.id && value.capturedAt !== undefined && value.orbisVersion !== undefined
      : value.id === null && value.pointId === undefined && value.capturedAt === undefined && value.orbisVersion === undefined,
  );

export const settingsBackupReviewSchema = type({
  version: '1',
  reviewId: uuid,
  archiveSha256: hash,
  createdAt: type('string').narrow((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  orbisVersion: version,
  contents: content.array().atMostLength(20),
  available: settingsBackupSelectionSchema,
  expiresAt: timestamp,
})
  .onDeepUndeclaredKey('reject')
  .narrow((value) => {
    const keys = value.contents.map((entry) => `${entry.kind}:${entry.id ?? ''}`);
    return (
      value.contents.length > 0 &&
      new Set(keys).size === keys.length &&
      (['settings', 'dashboard', 'wallpapers', 'themes'] as const).every(
        (kind) => value.available[kind] === value.contents.some((entry) => entry.kind === kind),
      ) &&
      value.available.timeMachine.length === value.contents.filter((entry) => entry.kind === 'time-machine').length &&
      value.available.timeMachine.every((point) => value.contents.some((entry) => entry.kind === 'time-machine' && entry.id === point))
    );
  });
export type SettingsBackupReview = typeof settingsBackupReviewSchema.infer;

export const settingsBackupImportJobSchema = type({
  id: uuid,
  status: type.enumerated('awaiting-upload', 'uploading', 'uploaded', 'reviewing', 'reviewed', 'failed', 'consumed'),
  createdAt: timestamp,
  updatedAt: timestamp,
  uploadedBytes: bytes,
  completedBytes: bytes,
  totalBytes: bytes.or('null'),
  message: 'string <= 256',
  'review?': settingsBackupReviewSchema,
})
  .onDeepUndeclaredKey('reject')
  .narrow(
    (value) =>
      (value.status === 'reviewed') === (value.review !== undefined) && (value.totalBytes === null || value.completedBytes <= value.totalBytes),
  );
export type SettingsBackupImportJob = typeof settingsBackupImportJobSchema.infer;
export const settingsBackupRestoreJobSchema = type({
  id: uuid,
  status: type.enumerated('running', 'succeeded', 'rolled-back', 'recovery-required'),
  stage: type.enumerated('preparing', 'prepared', 'applying', 'complete', 'rolling-back', 'rolled-back', 'recovery'),
  needsRecovery: 'boolean',
  canRollback: 'boolean',
})
  .onUndeclaredKey('reject')
  .narrow((value) => {
    const terminal = value.status === 'succeeded' || value.status === 'rolled-back';
    return (
      value.canRollback !== terminal &&
      (!terminal || !value.needsRecovery) &&
      (value.status !== 'succeeded' || value.stage === 'complete') &&
      (value.status !== 'rolled-back' || value.stage === 'rolled-back') &&
      (value.status !== 'recovery-required' || value.needsRecovery)
    );
  });
export type SettingsBackupRestoreJob = typeof settingsBackupRestoreJobSchema.infer;
export const settingsBackupImportListSchema = type({
  available: 'boolean',
  jobs: settingsBackupImportJobSchema.array().atMostLength(32),
}).onUndeclaredKey('reject');
