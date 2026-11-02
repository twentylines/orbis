import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { timeMachineActivity } from './time-machine-activity';
import './capture-progress.css';

export function TimeMachineCaptureProgress({ point, unavailable = false }: { point: TimeMachinePoint; unavailable?: boolean }) {
  const activity = timeMachineActivity(point);
  return (
    <output className="tm-capture-progress">
      <strong>Time Machine capture</strong>
      <span>{unavailable ? 'Waiting for capture status' : (activity?.stage ?? point.stage.replaceAll('-', ' '))}</span>
      <RecoveryProgressBar label="Capture progress" percentage={unavailable ? undefined : activity?.percentage} />
      <small>
        {unavailable
          ? 'Reconnecting to the server'
          : point.totalBytes
            ? `${formatBackupBytes(point.completedBytes)} of ${formatBackupBytes(point.totalBytes)}`
            : 'The server has not reported a total size.'}
      </small>
    </output>
  );
}
