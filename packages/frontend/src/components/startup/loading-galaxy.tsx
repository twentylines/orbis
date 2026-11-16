import type { CSSProperties } from 'react';
import { orbisGalaxyPoints } from '@/components/orbis-logo/orbis-logo';
import { DepthTravel } from '@/components/recovery-progress/depth-travel';
import './loading-galaxy.css';

const extractionParticles = orbisGalaxyPoints
  .filter((_, index) => index % 4 === 0)
  .map(([x, y], index) => {
    const angle = Math.atan2(y - 32, x - 32);
    return {
      id: `${x}:${y}`,
      style: {
        '--particle-start-x': `${Math.cos(angle - 1.2) * (30 + (index % 19))}vw`,
        '--particle-start-y': `${Math.sin(angle - 1.2) * (30 + (index % 13))}vh`,
        '--particle-mid-x': `${Math.cos(angle - 0.5) * 12}vw`,
        '--particle-mid-y': `${Math.sin(angle - 0.5) * 12}vh`,
        '--particle-end-x': `calc(var(--recovery-mark-size, 112px) * ${(x - 32) / 64})`,
        '--particle-end-y': `calc(var(--recovery-mark-size, 112px) * ${(y - 32) / 64})`,
        animationDelay: `${index * 6}ms`,
      } as CSSProperties,
    };
  });

export function alignLoadingGalaxy(element: HTMLElement) {
  const mark = element.querySelector('.orbis-startup-mark');
  if (!mark) return;
  const bounds = element.getBoundingClientRect();
  const target = mark.getBoundingClientRect();
  const logo = mark.querySelector('.orbis-logo');
  element.style.setProperty('--recovery-loading-x', `${target.left + target.width / 2 - bounds.left}px`);
  element.style.setProperty('--recovery-loading-y', `${target.top + target.height / 2 - bounds.top}px`);
  element.style.setProperty('--recovery-mark-size', `${logo?.getBoundingClientRect().width ?? target.width * (112 / 176)}px`);
}

export function LoadingGalaxy({
  active = true,
  departing = false,
  distance = 1,
  variant = 'onboarding',
  backdrop = true,
}: {
  active?: boolean;
  departing?: boolean;
  distance?: number;
  variant?: 'restore' | 'update' | 'downgrade' | 'onboarding';
  backdrop?: boolean;
}) {
  return (
    <>
      {backdrop ? <DepthTravel active={active} departing={departing} distance={distance} variant={variant} className="loading-galaxy-space" /> : null}
      <div className="loading-galaxy-particles" aria-hidden="true">
        {extractionParticles.map(({ id, style }) => (
          <i key={id} style={style} />
        ))}
      </div>
    </>
  );
}
