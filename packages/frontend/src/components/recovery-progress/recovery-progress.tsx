import { DepthTravel } from './depth-travel';
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

export function RecoveryProgress({ label, completed = 0, total = null, settled = false, unit = 'bytes', journey = true }: Props) {
  const percentage = progressPercent(completed, total, settled);
  const reduced = useReducedMotion();
  return (
    <div className="recovery-progress" data-reduced={Boolean(reduced)} data-active={!settled} data-known={percentage !== undefined}>
      {journey ? <DepthTravel active={!settled} className="recovery-flight" /> : null}
      <div className="recovery-progress-heading">
        <span>{label}</span>
        <span>{percentage === undefined ? 'Working…' : `${percentage}%`}</span>
      </div>
      <progress aria-label={label} max={100} value={percentage} />
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
