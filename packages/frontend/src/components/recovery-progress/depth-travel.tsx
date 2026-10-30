import type { CSSProperties } from 'react';
import { useReducedMotion } from '@/desktop/motion-preferences';
import './depth-travel.css';

const stars = Array.from({ length: 24 }, (_, index) => ({
  x: 8 + ((index * 37) % 84),
  y: 6 + ((index * 53) % 88),
  size: index % 5 === 0 ? 2 : 1,
}));

export function DepthTravel({ active = true, className = '' }: { active?: boolean; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <div className={`depth-travel ${className}`} aria-hidden="true" data-active={active} data-reduced={Boolean(reduced)}>
      <div className="depth-travel-horizon" />
      {[0, 1, 2].map((layer) => (
        <div key={layer} className="depth-travel-plane" style={{ '--depth-delay': `${-layer * 1.6}s` } as CSSProperties}>
          {stars.map((star) => (
            <i key={`${star.x}-${star.y}`} style={{ left: `${star.x}%`, top: `${star.y}%`, width: star.size, height: star.size }} />
          ))}
        </div>
      ))}
    </div>
  );
}
