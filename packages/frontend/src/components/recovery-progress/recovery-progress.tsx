import type { CSSProperties } from 'react';
import { IconRocket } from '@tabler/icons-react';
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
      {journey ? (
        <div className="recovery-flight" aria-hidden="true" style={{ '--recovery-position': `${percentage ?? 50}%` } as CSSProperties}>
          <div className="recovery-stars">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <span className="recovery-planet recovery-planet-origin" />
          <span className="recovery-route" />
          <span className="recovery-ship">
            <IconRocket size={28} stroke={1.6} />
          </span>
          <span className="recovery-planet recovery-planet-destination" />
        </div>
      ) : null}
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
