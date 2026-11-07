import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { RecoveryProgressBar } from '@/components/recovery-progress/recovery-progress';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { useWindowVisible } from '@/desktop/window-visibility';
import { capturePresentation } from './capture-presentation';
import './capture-progress.css';

export function TimeMachineCaptureProgress({ point, unavailable = false }: { point: TimeMachinePoint; unavailable?: boolean }) {
  const presentation = capturePresentation(point, unavailable);
  const reduced = useReducedMotion();
  const visible = useWindowVisible();
  const running = presentation.active && presentation.percentage === undefined && visible && !reduced;
  return (
    <section
      className="tm-capture-progress"
      aria-label="Time Machine capture"
      data-pose={presentation.pose}
      data-active={presentation.active}
      data-running={running}
      data-reduced={Boolean(reduced)}
      data-visible={visible}
    >
      <div className="tm-capture-space" aria-hidden="true">
        <div className="tm-capture-orbit" />
        <div className="tm-capture-deck">
          <div className="tm-capture-plane tm-capture-plane-back" />
          <div className="tm-capture-plane tm-capture-plane-middle" />
          <div className="tm-capture-plane tm-capture-plane-front" />
        </div>
      </div>
      <div className="tm-capture-scan" aria-hidden="true" />
      <div className="tm-capture-copy">
        <strong>{presentation.title}</strong>
        <output aria-live="polite" aria-atomic="true">
          {presentation.stage}
        </output>
        {point.status === 'capturing' ? (
          <>
            {presentation.percentage !== undefined ? (
              <div className="tm-capture-meter">
                <RecoveryProgressBar label="Capture progress" percentage={presentation.percentage} />
                <span>{presentation.percentage}%</span>
              </div>
            ) : null}
            <small>
              {unavailable
                ? 'Reconnecting to the server. Completion is not yet confirmed.'
                : presentation.percentage !== undefined
                  ? `${formatBackupBytes(point.completedBytes)} of ${formatBackupBytes(point.totalBytes ?? 0)} reported by the server`
                  : 'The server has not reported a total size.'}
            </small>
          </>
        ) : null}
      </div>
    </section>
  );
}
