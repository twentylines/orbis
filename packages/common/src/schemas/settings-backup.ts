import { type } from 'arktype';

const id = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const uniqueIds = id
  .array()
  .atMostLength(16)
  .narrow((values) => new Set(values).size === values.length);

export const settingsBackupSelectionSchema = type({
  version: '1',
  settings: 'boolean',
  dashboard: 'boolean',
  wallpapers: 'boolean',
  themes: 'boolean',
  timeMachine: uniqueIds,
})
  .onUndeclaredKey('reject')
  .narrow((value) => value.settings || value.dashboard || value.wallpapers || value.themes || value.timeMachine.length > 0);

export type SettingsBackupSelection = typeof settingsBackupSelectionSchema.infer;
export const defaultSettingsBackupSelection = (): SettingsBackupSelection => ({
  version: 1,
  settings: true,
  dashboard: true,
  wallpapers: true,
  themes: true,
  timeMachine: [],
});

const app = type('string <= 180').narrow((value) => /^[a-zA-Z0-9_-]{1,128}:[a-zA-Z0-9_-]{1,128}$/.test(value));
export const timeMachineCaptureScopeSchema = type({
  version: '1',
  orbis: 'boolean',
  apps: app
    .array()
    .atMostLength(512)
    .narrow((values) => new Set(values).size === values.length),
})
  .onUndeclaredKey('reject')
  .narrow((value) => value.orbis || value.apps.length > 0);

export type TimeMachineCaptureScope = typeof timeMachineCaptureScopeSchema.infer;
export const defaultTimeMachineCaptureScope = (): TimeMachineCaptureScope => ({ version: 1, orbis: true, apps: [] });

export const settingsBackupRestoreSelectionSchema = type({
  version: '1',
  reviewId: id,
  archiveSha256: type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value)),
  contents: settingsBackupSelectionSchema,
}).onUndeclaredKey('reject');
export type SettingsBackupRestoreSelection = typeof settingsBackupRestoreSelectionSchema.infer;

const size = type('0 <= number.integer <= 2200101191680');
export const settingsBackupJobSchema = type({
  version: '1',
  id,
  createdAt: '0 < number.integer <= 9007199254740991',
  status: type.enumerated('queued', 'running', 'ready', 'failed', 'cancelled', 'interrupted'),
  stage: type.enumerated('preparing', 'encrypting', 'captures', 'packaging', 'verifying', 'complete'),
  completedBytes: size,
  totalBytes: size.or('null'),
  bytes: size,
  sha256: type('string')
    .narrow((value) => /^[a-f0-9]{64}$/.test(value))
    .or('null'),
  selection: settingsBackupSelectionSchema,
})
  .onDeepUndeclaredKey('reject')
  .narrow(
    (job) =>
      (job.totalBytes === null || job.completedBytes <= job.totalBytes) &&
      (job.status !== 'ready' ||
        (job.stage === 'complete' && job.bytes > 0 && job.sha256 !== null && job.completedBytes === job.bytes && job.totalBytes === job.bytes)),
  );
export type SettingsBackupJob = typeof settingsBackupJobSchema.infer;

/** A restore request can narrow the verified contents; it cannot add absent sections or captures. */
export function settingsBackupSelectionContained(available: SettingsBackupSelection, requested: SettingsBackupSelection) {
  if (!settingsBackupSelectionSchema.allows(available) || !settingsBackupSelectionSchema.allows(requested)) return false;
  return (
    (['settings', 'dashboard', 'wallpapers', 'themes'] as const).every((key) => !requested[key] || available[key]) &&
    requested.timeMachine.every((point) => available.timeMachine.includes(point))
  );
}
