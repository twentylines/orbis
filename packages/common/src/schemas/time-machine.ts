import { historicalIconsAssetSchema } from './time-machine-icons.js';
import { type } from 'arktype';
import { desktopAppearanceSchema } from './desktop-appearance.js';
import { themePackManifestSchema } from './theme-pack.js';

export const timeMachineLimits = { points: 16, bytes: 128 * 1024 ** 3, metadataBytes: 512 * 1024, apps: 512 } as const;
export const timeMachineAssetLimit = 32 * 1024 * 1024;
const text = type('string <= 240').narrow((value) =>
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && !'<>'.includes(character)),
);
export const timeMachineIdSchema = type('string').narrow((value) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value),
);
export const timeMachineHashSchema = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const bytes = type('0 <= number.integer <= 9007199254740991');
const timestamp = type('0 < number.integer <= 9007199254740991');
const appUrn = type('string <= 180').narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value));
const excludedApps = appUrn
  .array()
  .atMostLength(timeMachineLimits.apps)
  .narrow((items) => new Set(items).size === items.length);
export const timeMachineReasonSchema = type.enumerated(
  'docker-images-not-retained',
  'controller-version-not-pinned',
  'app-exclusions-unsupported',
  'activation-not-integrated',
  'action-bound-auth-unavailable',
  'cluster-not-sealed',
  'os-snapshots-unsupported',
  'automatic-capture-unsupported',
  'preview-not-captured',
  'preview-invalid',
  'custom-wallpaper-unavailable',
  'historical-assets-unavailable',
  'screenshot-not-captured',
  'capture-interrupted',
  'capture-failed',
  'capture-recovery-required',
  'experimental-acknowledgement-required',
  'capacity-exceeded',
  'storage-unavailable',
  'point-not-found',
  'point-integrity-failed',
  'revision-conflict',
  'operation-busy',
  'invalid-request',
  'host-capture-support-required',
  'proxy-layout-migration-required',
);
export type TimeMachineReason = typeof timeMachineReasonSchema.infer;
export const timeMachineIssueSchema = type({ code: timeMachineReasonSchema, message: text }).onUndeclaredKey('reject');
export type TimeMachineIssue = typeof timeMachineIssueSchema.infer;
export const timeMachinePreferencesSchema = type({
  version: '1',
  revision: bytes,
  enabled: 'boolean',
  schedule: type({ enabled: 'false', intervalHours: '1 <= number.integer <= 8760' }).onUndeclaredKey('reject'),
  beforeUpdate: 'false',
  beforeRestart: 'false',
  excludedApps,
}).onUndeclaredKey('reject');
export type TimeMachinePreferences = typeof timeMachinePreferencesSchema.infer;
export const defaultTimeMachinePreferences = (): TimeMachinePreferences => ({
  version: 1,
  revision: 0,
  enabled: true,
  schedule: { enabled: false, intervalHours: 24 },
  beforeUpdate: false,
  beforeRestart: false,
  excludedApps: [],
});
export const timeMachinePreferencesUpdateSchema = type({
  expectedRevision: bytes,
  enabled: 'boolean',
  schedule: type({ enabled: 'boolean', intervalHours: '1 <= number.integer <= 8760' }).onUndeclaredKey('reject'),
  beforeUpdate: 'boolean',
  beforeRestart: 'boolean',
  excludedApps,
}).onUndeclaredKey('reject');
export type TimeMachinePreferencesUpdate = typeof timeMachinePreferencesUpdateSchema.infer;
export const timeMachineCaptureSchema = type({ 'experimentalAcknowledged?': 'true', label: text }).onUndeclaredKey('reject');
const widgetList = type
  .enumerated('applications', 'activity', 'storage', 'attention')
  .array()
  .atMostLength(4)
  .narrow((items) => new Set(items).size === items.length);
export const timeMachineWallpaperAssetSchema = type({
  available: 'true',
  identity: timeMachineHashSchema,
  cipherSha256: timeMachineHashSchema,
  bytes: `1 <= number.integer <= ${timeMachineAssetLimit}`,
  mime: type.enumerated('image/png', 'image/jpeg', 'image/webp'),
  width: '1 <= number.integer <= 16384',
  height: '1 <= number.integer <= 16384',
  source: type.enumerated('captured-custom', 'captured-theme', 'captured-builtin'),
})
  .onUndeclaredKey('reject')
  .narrow((asset) => asset.width * asset.height <= 64_000_000);
export type TimeMachineWallpaperAsset = typeof timeMachineWallpaperAssetSchema.infer;
export const timeMachinePreviewSchema = type({
  available: 'true',
  kind: "'historical-home-projection'",
  version: '1',
  capturedAt: timestamp,
  desktop: type({
    serverName: 'string > 0 & string <= 40',
    preset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'),
    mode: type.enumerated('light', 'dark', 'system'),
    density: type.enumerated('comfortable', 'compact'),
    wallpaper: type.enumerated('sandstone', 'tidal', 'canopy'),
    wallpaperMode: type.enumerated('theme', 'custom'),
    wallpaperPreset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush', null),
    appearance: desktopAppearanceSchema,
    workspace: type({ order: widgetList, hidden: widgetList, wide: widgetList, showAllApps: 'boolean', pinnedApps: excludedApps }).onUndeclaredKey(
      'reject',
    ),
  }).onUndeclaredKey('reject'),
  theme: themePackManifestSchema.or('null'),
  customWallpaperAvailable: 'boolean',
  'appIcons?': historicalIconsAssetSchema,
  wallpaperAsset: timeMachineWallpaperAssetSchema.or(
    type({ available: 'false', identity: timeMachineHashSchema.or('null'), reason: timeMachineIssueSchema }).onUndeclaredKey('reject'),
  ),
  screenshot: type({ available: 'false', reason: timeMachineIssueSchema }).onUndeclaredKey('reject'),
  resolvedSystemMode: 'null',
  apps: type({ urn: appUrn, name: text, running: 'boolean' }).onUndeclaredKey('reject').array().atMostLength(timeMachineLimits.apps),
})
  .onUndeclaredKey('reject')
  .narrow((preview) => !preview.appIcons || preview.appIcons.icons.every((icon) => preview.apps.some((app) => app.urn === icon.urn)));
export const timeMachineUnavailablePreviewSchema = type({ available: 'false', reason: timeMachineIssueSchema }).onUndeclaredKey('reject');
export type TimeMachinePreview = typeof timeMachinePreviewSchema.infer | typeof timeMachineUnavailablePreviewSchema.infer;
export const timeMachineLegacyMetadataSchema = type({
  version: '1',
  id: timeMachineIdSchema,
  createdAt: timestamp,
  label: text,
  source: "'manual'",
  archiveBytes: bytes,
  archiveSha256: timeMachineHashSchema,
  manifestSha256: timeMachineHashSchema,
  software: type({ orbis: text, runtipi: text, architecture: text }).onUndeclaredKey('reject'),
  coverage: type({
    database: 'true',
    configuration: 'true',
    appData: 'true',
    dockerImages: 'false',
    controllerVersion: 'false',
    appearance: 'true',
    cluster: "'local-only'",
  }).onUndeclaredKey('reject'),
  restore: type({ ready: 'false', blockers: timeMachineIssueSchema.array().atMostLength(16) }).onUndeclaredKey('reject'),
  preview: timeMachinePreviewSchema.or(timeMachineUnavailablePreviewSchema),
  breakdown: type({ id: text, bytes, entries: bytes }).onUndeclaredKey('reject').array().atMostLength(16),
  excludedApps,
}).onUndeclaredKey('reject');
export const timeMachineRuntimeSummarySchema = type({
  version: '1',
  cipherBytes: bytes,
  cipherSha256: timeMachineHashSchema,
  manifestSha256: timeMachineHashSchema,
  imageCaptureSha256: timeMachineHashSchema,
  imageInventorySha256: timeMachineHashSchema,
  configurationSetSha256: timeMachineHashSchema,
  imageCount: '1 <= number.integer <= 256',
  bindingCount: '1 <= number.integer <= 4096',
  'coherenceSha256?': timeMachineHashSchema,
}).onUndeclaredKey('reject');
export type TimeMachineRuntimeSummary = typeof timeMachineRuntimeSummarySchema.infer;
const retainedMetadata = timeMachineLegacyMetadataSchema
  .omit('version', 'coverage')
  .merge({
    version: '2',
    coverage: type({
      database: 'true',
      configuration: 'true',
      appData: 'true',
      dockerImages: 'true',
      controllerConfiguration: 'true',
      controllerVersion: 'boolean',
      appearance: 'true',
      cluster: "'local-only'",
    }).onUndeclaredKey('reject'),
    runtime: timeMachineRuntimeSummarySchema,
  })
  .onUndeclaredKey('reject');
export const timeMachineMetadataSchema = timeMachineLegacyMetadataSchema.or(retainedMetadata);
export type TimeMachineMetadata = typeof timeMachineMetadataSchema.infer;
export type TimeMachinePoint = {
  id: string;
  createdAt: number;
  status: 'capturing' | 'sealed' | 'failed' | 'interrupted';
  stage: string;
  completedBytes: number;
  totalBytes: number | null;
  issue: TimeMachineIssue | null;
  backupJobId: string | null;
  metadata: TimeMachineMetadata | null;
};
export type TimeMachineList = { version: 1; available: boolean; points: TimeMachinePoint[]; activeCaptureId: string | null };
export type TimeMachineCapabilities = {
  version: 1;
  experimental: true;
  manualCapture: true;
  experimentalAcknowledgementRequired: false;
  automaticCapture: { scheduled: false; preUpdate: false; preRestart: false };
  osSnapshots: { supported: false; reason: TimeMachineIssue };
  dockerImages: { capture: true; restore: false };
  appExclusions: { capture: false; restore: false };
  cluster: { supported: false; requiresAllHostsSealed: true };
  restore: { supported: false; blockers: TimeMachineIssue[] };
  exportSealedPoints: false;
  limits: typeof timeMachineLimits;
};
