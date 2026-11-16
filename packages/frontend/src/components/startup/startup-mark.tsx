import { OrbisLogo } from '@/components/orbis-logo/orbis-logo';
import './startup-mark.css';
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { formationElapsed, formationProgress } from './dot-formation';

const orbit = Array.from({ length: 36 }, (_, index) => {
  const angle = (index / 36) * Math.PI * 2;
  return { x: 88 + Math.cos(angle) * 72, y: 88 + Math.sin(angle) * 72, opacity: 0.12 + (index / 35) ** 4 * 0.72 };
});

export function StartupMark({
  ready = true,
  progress,
  label,
  formationOwner,
  formationPhase,
  assemble = false,
  variant = 'workspace',
}: {
  ready?: boolean;
  progress?: number;
  label?: string;
  formationOwner?: object;
  formationPhase?: 'session' | 'setup';
  assemble?: boolean;
  variant?: 'workspace' | 'session' | 'setup' | 'progress';
}) {
  const percentage = formationProgress(progress);
  const determinate = percentage !== undefined;
  const variation = determinate ? 'progress' : variant;
  const forms = variation === 'session' || variation === 'setup' || assemble;
  const [elapsed, setElapsed] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (ready && !determinate && forms) setElapsed(formationElapsed(formationOwner ?? document, performance.now(), formationPhase ?? variation));
  }, [ready, determinate, formationOwner, formationPhase, variation, forms]);
  return (
    <div
      className="orbis-startup-mark"
      data-ready={(ready && (!forms || elapsed !== null)) || undefined}
      data-determinate={percentage !== undefined || undefined}
      data-variation={variation}
      style={{ '--orbis-formation-delay': `${-(elapsed ?? 0)}ms` } as CSSProperties}
      aria-hidden={label ? undefined : true}
      data-resuming={(elapsed !== null && elapsed > 0) || undefined}
      role="progressbar"
      aria-label={label ?? 'Loading'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
    >
      {variation !== 'session' && variation !== 'progress' ? null : (
        <span className="orbis-startup-orbit">
          <svg width="176" height="176" viewBox="0 0 176 176" focusable="false" aria-hidden="true">
            {orbit.map(({ x, y, opacity }, index) => (
              <circle key={`${x}:${y}`} cx={x} cy={y} r={index > 32 ? 1.6 : 1.1} opacity={opacity} />
            ))}
          </svg>
        </span>
      )}
      <span className="orbis-startup-beacon">
        <OrbisLogo
          size={112}
          dots={forms || determinate}
          animated={forms && ready && elapsed !== null}
          animationElapsed={elapsed ?? 0}
          progress={percentage}
        />
      </span>
      {percentage !== undefined ? (
        <span className="orbis-startup-percent" aria-hidden="true">
          {Math.floor(percentage)}%
        </span>
      ) : null}
    </div>
  );
}
