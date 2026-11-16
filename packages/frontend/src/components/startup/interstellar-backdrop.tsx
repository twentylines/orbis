import { useLayoutEffect, useRef } from 'react';
import './interstellar-backdrop.css';

export const interstellarBackdropSource = '/startup/interstellar-v1.webp';

const nearbyStars = Array.from({ length: 48 }, (_, index) => ({
  x: (index * 977 + 149) % 1600,
  y: (index * 431 + 73) % 900,
  radius: 0.45 + (index % 5) * 0.14,
  opacity: 0.15 + (index % 4) * 0.07,
}));

export function InterstellarBackdrop({ className = '' }: { className?: string }) {
  const scene = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scene.current?.style.setProperty('--orbis-interstellar-delay', `${-performance.now()}ms`);
  }, []);
  return (
    <div ref={scene} className={`orbis-interstellar ${className}`} aria-hidden="true">
      <img src={interstellarBackdropSource} width={1672} height={941} alt="" fetchPriority="high" decoding="async" />
      <svg className="orbis-interstellar-near" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" focusable="false" aria-hidden="true">
        {nearbyStars.map((star) => (
          <circle key={`${star.x}:${star.y}`} cx={star.x} cy={star.y} r={star.radius} opacity={star.opacity} />
        ))}
      </svg>
    </div>
  );
}
