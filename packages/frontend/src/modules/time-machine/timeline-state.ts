import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import type { TimeMachineRestoreGrant, TimeMachineRestoreReview } from '@runtipi/common/schemas/time-machine-restore';

export function timelineTarget(points: readonly TimeMachinePoint[], selected: string | null, key: string): string | null {
  const index = points.findIndex((point) => point.id === selected);
  if (index < 0 || !points.length) return points[0]?.id ?? null;
  if (key === 'Home') return points.at(-1)?.id ?? null;
  if (key === 'End') return points[0]?.id ?? null;
  const direction = ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(key) ? 1 : ['ArrowDown', 'ArrowRight', 'PageDown'].includes(key) ? -1 : 0;
  return points[Math.max(0, Math.min(points.length - 1, index + direction))]?.id ?? null;
}

export function timelineOffsets(points: readonly TimeMachinePoint[], sizes: ReadonlyMap<string, number>, estimate = 76): number[] {
  const offsets = [0];
  for (const point of points) offsets.push((offsets.at(-1) ?? 0) + (sizes.get(point.id) ?? estimate));
  return offsets;
}

export function timelineIndexAt(offsets: readonly number[], position: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function timelineWindow(offsets: readonly number[], position: number, extent: number, pinned: readonly number[] = []): number[] {
  const count = offsets.length - 1;
  if (count <= 0) return [];
  const start = Math.max(0, timelineIndexAt(offsets, position) - 3);
  const end = Math.min(count - 1, timelineIndexAt(offsets, position + extent) + 3);
  const indices = new Set<number>();
  for (let index = start; index <= end; index++) indices.add(index);
  for (const index of pinned) if (index >= 0 && index < count) indices.add(index);
  return [...indices].sort((a, b) => a - b);
}

export const pointMotionSeconds = { unfold: 0.76, travel: 0.52, fold: 0.54, sceneExit: 0.72 } as const;

export function pointCardPose(depth: number, phase: 'spread' | 'folded', compact = false) {
  const bounded = Math.max(-1, Math.min(10, depth));
  if (phase === 'folded') return { y: 28 - Math.max(0, bounded) * 1.5, z: -40 - Math.max(0, bounded) * 3, scale: 0.92, rotateX: -10, opacity: 1 };
  if (bounded < 0) return { y: compact ? 100 : 170, z: 360, scale: 1.03, rotateX: 3, opacity: 0 };
  return {
    y: bounded ? -bounded * (compact ? 12 : 20) : 0,
    z: bounded ? -bounded * (compact ? 78 : 112) : 0,
    scale: 1,
    rotateX: 0,
    opacity: bounded >= 10 ? 0 : 1,
  };
}

export function pointPreviewAdmitted(pointId: string, selected: string | null, previous: string | null) {
  return pointId === selected || pointId === previous;
}

export function pointMotionEnabled(reduced: boolean, lowEffects: boolean) {
  return !reduced && !lowEffects;
}

export function reviewMatchesPoint(review: TimeMachineRestoreReview, point: TimeMachinePoint): boolean {
  return (
    point.status === 'sealed' &&
    Boolean(point.metadata) &&
    review.pointId === point.id &&
    review.archiveSha256 === point.metadata?.archiveSha256 &&
    review.manifestSha256 === point.metadata?.manifestSha256
  );
}

export function verifiedRestoreReview(review: TimeMachineRestoreReview | null, point: TimeMachinePoint, now: number): boolean {
  return Boolean(
    review &&
      reviewMatchesPoint(review, point) &&
      review.status === 'ready' &&
      review.ready &&
      review.expiresAt !== null &&
      review.expiresAt > now &&
      review.blockers.length === 0 &&
      review.progress.stage === 'ready',
  );
}

export function eligibleRestoreReview(review: TimeMachineRestoreReview | null, point: TimeMachinePoint, now: number): boolean {
  return Boolean(
    review &&
      reviewMatchesPoint(review, point) &&
      review.status === 'eligible' &&
      !review.ready &&
      review.expiresAt !== null &&
      review.expiresAt > now &&
      review.blockers.length === 0 &&
      review.progress.stage === 'checking',
  );
}

export function grantMatchesReview(grant: TimeMachineRestoreGrant, review: TimeMachineRestoreReview, point: TimeMachinePoint, now: number): boolean {
  return (
    (verifiedRestoreReview(review, point, now) || eligibleRestoreReview(review, point, now)) &&
    grant.expiresAt > now &&
    grant.expiresAt <= (review.expiresAt ?? 0) &&
    grant.pointId === review.pointId &&
    grant.reviewId === review.reviewId &&
    grant.machineId === review.machineId &&
    grant.archiveSha256 === review.archiveSha256 &&
    grant.manifestSha256 === review.manifestSha256
  );
}

export function capturePercent(completed: number, total: number | null, sealed = false): number | undefined {
  if (sealed) return 100;
  if (!Number.isSafeInteger(completed) || completed < 0 || total === null || !Number.isSafeInteger(total) || total <= 0 || completed > total)
    return undefined;
  return Math.min(99, Math.floor((completed / total) * 100));
}
