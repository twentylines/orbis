import type { RestoreJob } from './contracts';
import { operationAllowsDeparture, type OperationSnapshot } from '@/components/recovery-progress/operation-status';

export type RestoreAttempt = Readonly<{ previousId: string | null; acceptedId: string | null }>;
const terminal = (job: RestoreJob) => job.status === 'succeeded' || job.status === 'rolled-back';

export function restoreCanResume(job: RestoreJob | null | undefined, authority: OperationSnapshot | null | undefined): boolean {
  return Boolean(job && terminal(job) && !job.needsRecovery && authority && operationAllowsDeparture(authority));
}

export function beginRestoreAttempt(previous: Pick<RestoreJob, 'id'> | null | undefined): RestoreAttempt {
  return { previousId: previous?.id ?? null, acceptedId: null };
}
export function acceptRestoreAttempt(attempt: RestoreAttempt, returned: RestoreJob): RestoreAttempt {
  if (returned.id === attempt.previousId || (attempt.acceptedId !== null && returned.id !== attempt.acceptedId))
    throw new Error('The server returned a different or earlier restore. Check status before starting another attempt.');
  if (attempt.acceptedId === null && terminal(returned))
    throw new Error('A completed restore does not confirm this new attempt. Check status before trying again.');
  return { ...attempt, acceptedId: returned.id };
}
export function restoreForAttempt(attempt: RestoreAttempt | null, polled: RestoreJob | null | undefined): RestoreJob | null {
  if (!attempt) return polled ?? null;
  return attempt.acceptedId && polled?.id === attempt.acceptedId ? polled : null;
}
