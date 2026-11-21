import { useLayoutEffect, useRef } from 'react';
import './interstellar-backdrop.css';

export const interstellarBackdropSource = '/startup/interstellar-v2-1920.webp';

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
    <div ref={scene} className={`orbis-interstellar ${className}`}>
      <img
        src={interstellarBackdropSource}
        srcSet="/startup/interstellar-v2-960.webp 960w, /startup/interstellar-v2-1920.webp 1920w, /startup/interstellar-v2-3840.webp 3840w, /startup/interstellar-v2-5120.webp 5120w"
        sizes="max(116vw, 206.23vh)"
        width={1920}
        height={1080}
        alt=""
        fetchPriority="high"
        decoding="async"
      />
      <svg className="orbis-interstellar-near" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" focusable="false" aria-hidden="true">
        {nearbyStars.map((star) => (
          <circle key={`${star.x}:${star.y}`} cx={star.x} cy={star.y} r={star.radius} opacity={star.opacity} />
        ))}
      </svg>
      <a className="orbis-interstellar-credit" href="https://esawebb.org/images/weic2316a/" target="_blank" rel="noreferrer">
        NASA, ESA, CSA, STScI, K. Pontoppidan (STScI), A. Pagan (STScI)
        <span>Rho Ophiuchi · cropped and theme tinted · CC BY 4.0</span>
      </a>
    </div>
  );
}
