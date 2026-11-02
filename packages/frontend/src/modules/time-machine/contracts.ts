import { type } from 'arktype';
import { timeMachineRestoreReviewSchema } from '@runtipi/common/schemas/time-machine-restore';
import {
  timeMachineIdSchema,
  timeMachineIssueSchema,
  timeMachineLimits,
  timeMachineMetadataSchema,
  type timeMachinePreferencesSchema,
  type TimeMachinePoint,
} from '@runtipi/common/schemas/time-machine';

const count = '0 <= number.integer <= 9007199254740991' as const;
export const pointSchema = type({
  id: timeMachineIdSchema,
  createdAt: '0 < number.integer <= 9007199254740991',
  status: "'capturing' | 'sealed' | 'failed' | 'interrupted'",
  stage: 'string <= 64',
  completedBytes: count,
  totalBytes: type(count).or('null'),
  issue: timeMachineIssueSchema.or('null'),
  backupJobId: timeMachineIdSchema.or('null'),
  metadata: timeMachineMetadataSchema.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow((point) =>
    point.status === 'sealed'
      ? point.metadata !== null && point.metadata.id === point.id && point.metadata.createdAt === point.createdAt
      : point.metadata === null,
  );
export const listSchema = type({
  version: '1',
  available: 'boolean',
  points: pointSchema.array().atMostLength(timeMachineLimits.points),
  activeCaptureId: timeMachineIdSchema.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow((list) => new Set(list.points.map((point) => point.id)).size === list.points.length);
export const captureActivitySchema = type({ version: '1', point: pointSchema.or('null') })
  .onUndeclaredKey('reject')
  .narrow((value) => value.point === null || (value.point.status === 'capturing' && value.point.metadata === null));
export const capabilitiesSchema = type({
  version: '1',
  experimental: 'true',
  manualCapture: 'boolean',
  experimentalAcknowledgementRequired: 'true',
  automaticCapture: { scheduled: 'boolean', preUpdate: 'boolean', preRestart: 'boolean' },
  osSnapshots: { supported: 'false', reason: timeMachineIssueSchema },
  dockerImages: { capture: 'boolean', restore: 'boolean' },
  appExclusions: { capture: 'boolean', restore: 'boolean' },
  cluster: { supported: 'false', requiresAllHostsSealed: 'true' },
  restore: { supported: 'boolean', blockers: timeMachineIssueSchema.array().atMostLength(16) },
  exportSealedPoints: 'false',
  limits: {
    points: type.enumerated(timeMachineLimits.points),
    bytes: type.enumerated(timeMachineLimits.bytes),
    metadataBytes: type.enumerated(timeMachineLimits.metadataBytes),
    apps: type.enumerated(timeMachineLimits.apps),
  },
}).onUndeclaredKey('reject');
export const restoreReviewSchema = timeMachineRestoreReviewSchema;
export type TimeMachineSnapshot = {
  capabilities: typeof capabilitiesSchema.infer;
  preferences: typeof timeMachinePreferencesSchema.infer;
  list: typeof listSchema.infer;
};
export function parseTimeMachine<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
  const result = schema(value);
  if (result instanceof type.errors) throw new Error('This server returned an unsupported Time Machine response. Update Orbis and refresh.');
  return result;
}
export function orderedPoints(points: readonly TimeMachinePoint[]) {
  return [...points].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export function chronologicalPoints(points: readonly TimeMachinePoint[]) {
  return [...points].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export function selectedPointId(points: readonly TimeMachinePoint[], previous: string | null) {
  return points.some((point) => point.id === previous) ? previous : (orderedPoints(points)[0]?.id ?? null);
}
export function visiblePointCards(points: readonly TimeMachinePoint[], selected: string | null) {
  const ordered = orderedPoints(points);
  const index = ordered.findIndex((point) => point.id === selected);
  return index < 0 ? [] : ordered.slice(index, index + 10);
}
export function timeMachinePollDelay(snapshot: TimeMachineSnapshot | null, visible: boolean): number | false {
  if (!visible) return false;
  return snapshot?.list.activeCaptureId || snapshot?.list.points.some((point) => point.status === 'capturing') ? 2500 : 30_000;
}
export function historicalAssetPath(point: TimeMachinePoint) {
  const preview = point.metadata?.preview;
  if (!preview?.available || !preview.wallpaperAsset.available || !timeMachineIdSchema.allows(point.id)) return null;
  return `/api/system-backups/time-machine/points/${point.id}/assets/${preview.wallpaperAsset.identity}`;
}
