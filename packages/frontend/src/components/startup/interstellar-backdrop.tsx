import { useLayoutEffect, useRef } from 'react';
import './interstellar-backdrop.css';

export const interstellarBackdropSource = '/startup/starfield-v1.svg';

const nearbyStars = Array.from({ length: 48 }, (_, index) => ({
  x: (index * 977 + 149) % 1600,
  y: (index * 431 + 73) % 900,
  radius: 0.45 + (index % 5) * 0.14,
  opacity: 0.15 + (index % 4) * 0.07,
}));
const quietStars = nearbyStars.filter(({ x, y }) => Math.hypot((x - 800) / 260, (y - 490) / 230) > 1);

export function InterstellarBackdrop({ className = '', variant = 'starfield' }: { className?: string; variant?: 'starfield' | 'nebula' }) {
  const scene = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scene.current?.style.setProperty('--orbis-interstellar-delay', `${-performance.now()}ms`);
  }, []);
  return (
    <div ref={scene} className={`orbis-interstellar ${className}`} data-scene={variant} aria-hidden="true">
      <img
        src={variant === 'nebula' ? '/startup/interstellar-v1.webp' : interstellarBackdropSource}
        width={variant === 'nebula' ? 1672 : 3840}
        height={variant === 'nebula' ? 941 : 2160}
        alt=""
        fetchPriority="high"
        decoding="async"
      />
      <svg className="orbis-interstellar-near" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" focusable="false" aria-hidden="true">
        {(variant === 'nebula' ? nearbyStars : quietStars).map((star) => (
          <circle key={`${star.x}:${star.y}`} cx={star.x} cy={star.y} r={star.radius} opacity={star.opacity} />
        ))}
      </svg>
    </div>
  );
}
