import type { RestoreJob } from '@/modules/system-backups/contracts';
import { Button } from '@/components/ui/Button';
import { useRestoreDeparture } from '@/components/recovery-progress/use-restore-departure';
import { RecoveryScene } from '@/components/recovery-progress/recovery-scene';
import { restorePresentation } from '@/components/recovery-progress/restore-presentation';

export function TimeMachineRestoreJourney({
  job,
  reconnecting,
  onRetry,
  onCancel,
  onRecover,
  onDone,
}: {
  job: RestoreJob;
  reconnecting: boolean;
  onRetry: () => void;
  onCancel?: () => void;
  onRecover?: () => void;
  onDone?: () => void;
}) {
  const presentation = restorePresentation(job, reconnecting);
  const continuity = useRestoreDeparture(job, reconnecting);
  const terminal = job.status === 'succeeded' || job.status === 'rolled-back';
  return (
    <RecoveryScene
      {...presentation}
      departing={continuity.departing}
      actions={
        <>
          {reconnecting ? <Button onClick={onRetry}>Reconnect</Button> : null}
          {job.canCancel && onCancel ? (
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {job.canRecover && onRecover ? <Button onClick={onRecover}>Recover</Button> : null}
          {terminal && !reconnecting && !job.needsRecovery && !continuity.departing ? (
            <Button onClick={onDone ?? (() => window.location.assign('/'))}>Continue</Button>
          ) : null}
        </>
      }
    />
  );
}
