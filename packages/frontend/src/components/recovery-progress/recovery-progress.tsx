import { DepthTravel } from './depth-travel';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { formatBackupBytes, progressPercent } from '@/modules/system-backups/contracts';
import './recovery-progress.css';

type Props = {
  label: string;
  completed?: number;
  total?: number | null;
  settled?: boolean;
  unit?: 'bytes' | 'records';
  journey?: boolean;
};

export function RecoveryProgressBar({ label, percentage }: { label: string; percentage?: number }) {
  const reduced = useReducedMotion();
  const visible = useWindowVisible();
  return (
    <div className="recovery-progress-bar" data-known={percentage !== undefined} data-motion={visible && !reduced}>
      <progress aria-label={label} max={100} value={percentage} />
      {percentage === undefined ? <span aria-hidden="true" /> : null}
    </div>
  );
}

export function RecoveryProgress({ label, completed = 0, total = null, settled = false, unit = 'bytes', journey = true }: Props) {
  const percentage = progressPercent(completed, total, settled);
  const reduced = useReducedMotion();
  return (
    <div
      className="recovery-progress"
      data-reduced={Boolean(reduced)}
      data-active={!settled}
      data-known={percentage !== undefined}
      data-journey={journey}
    >
      {journey ? <DepthTravel active={!settled} className="recovery-flight" /> : null}
      <div className="recovery-progress-heading">
        <span>{label}</span>
        <span>{percentage === undefined ? 'Working…' : `${percentage}%`}</span>
      </div>
      <RecoveryProgressBar label={label} percentage={percentage} />
      {total !== null ? (
        <small>
          {unit === 'records'
            ? `${completed.toLocaleString()} of ${total.toLocaleString()} records`
            : `${formatBackupBytes(completed)} of ${formatBackupBytes(total)}`}
        </small>
      ) : null}
    </div>
  );
}
