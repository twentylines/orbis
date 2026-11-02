import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import type { TimeMachineRestoreReview } from '@runtipi/common/schemas/time-machine-restore';
import { eligibleRestoreReview, verifiedRestoreReview } from './timeline-state';
export function restoreAuthorizationAvailable(
  point: TimeMachinePoint | undefined,
  review: TimeMachineRestoreReview | null,
  supported: boolean,
  now: number,
) {
  return Boolean(point && ((supported && verifiedRestoreReview(review, point, now)) || eligibleRestoreReview(review, point, now)));
}
