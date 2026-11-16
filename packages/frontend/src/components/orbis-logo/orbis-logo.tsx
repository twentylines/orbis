import { useId, type CSSProperties } from 'react';
import './orbis-logo.css';
import { formationAmount, formationProgress } from '@/components/startup/dot-formation';

const spiralArm =
  'M32.19 27C31.93 26.82 31.25 26.2 30.65 25.92C30.06 25.65 29.34 25.44 28.61 25.37C27.87 25.31 27.03 25.34 26.23 25.54C25.42 25.73 24.55 26.05 23.76 26.53C22.97 27.01 22.17 27.64 21.49 28.39C20.81 29.15 20.17 30.07 19.7 31.07C19.23 32.08 18.85 33.24 18.66 34.43C18.48 35.63 18.44 36.95 18.6 38.24C18.77 39.54 19.12 40.91 19.68 42.2C20.23 43.49 20.99 44.81 21.94 45.98C22.89 47.15 24.05 48.28 25.36 49.21C26.67 50.14 28.19 50.96 29.79 51.54C31.39 52.12 33.18 52.54 34.98 52.68C36.78 52.81 38.71 52.74 40.58 52.38C42.45 52.02 44.4 51.4 46.2 50.52C48 49.63 49.8 48.47 51.38 47.08C52.96 45.69 54.47 44.01 55.69 42.17C56.91 40.33 58.2 37.06 58.7 36.03';

function galaxyParticlePaths() {
  const coordinates = (spiralArm.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const coordinate = (index: number) => {
    const value = coordinates[index];
    if (value === undefined) throw new Error('The Orbis arm is incomplete.');
    return value;
  };
  let startX = coordinate(0);
  let startY = coordinate(1);
  let distance = 0;
  const samples = [{ x: startX, y: startY, distance }];
  for (let index = 2; index < coordinates.length; index += 6) {
    const x1 = coordinate(index);
    const y1 = coordinate(index + 1);
    const x2 = coordinate(index + 2);
    const y2 = coordinate(index + 3);
    const endX = coordinate(index + 4);
    const endY = coordinate(index + 5);
    for (let step = 1; step <= 16; step++) {
      const t = step / 16;
      const u = 1 - t;
      const x = u ** 3 * startX + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * endX;
      const y = u ** 3 * startY + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * endY;
      const previous = samples.at(-1);
      if (!previous) throw new Error('The Orbis arm is incomplete.');
      distance += Math.hypot(x - previous.x, y - previous.y);
      samples.push({ x, y, distance });
    }
    startX = endX;
    startY = endY;
  }
  const points: Array<[number, number, number]> = [];
  for (const arm of [0, 120, 240]) {
    const rotation = (arm * Math.PI) / 180;
    for (let step = 0; step < 42; step++) {
      const target = (step / 41) * distance;
      const index = Math.max(
        1,
        samples.findIndex((sample) => sample.distance >= target),
      );
      const before = samples[index - 1];
      const after = samples[index];
      if (!before || !after) throw new Error('The Orbis arm is incomplete.');
      const amount = (target - before.distance) / (after.distance - before.distance);
      const x = before.x + (after.x - before.x) * amount;
      const y = before.y + (after.y - before.y) * amount;
      const angle = Math.atan2(after.y - before.y, after.x - before.x);
      for (const side of [-1, 1]) {
        const localX = x - Math.sin(angle) * side * 0.65 - 32;
        const localY = y + Math.cos(angle) * side * 0.65 - 32;
        points.push([
          32 + localX * Math.cos(rotation) - localY * Math.sin(rotation),
          32 + localX * Math.sin(rotation) + localY * Math.cos(rotation),
          0.42,
        ]);
      }
    }
  }
  points.push([32, 32, 3.2]);
  points.push([20, 11, 0.7], [52, 24, 0.9], [39, 55, 0.6]);
  const groups = Array.from({ length: 16 }, () => '');
  // Equal-radius arms keep their source order across server and browser math implementations.
  const radialKey = ([x, y]: readonly [number, number, number]) => Math.round(((x - 32) ** 2 + (y - 32) ** 2) * 1_000_000);
  points.sort((a, b) => radialKey(a) - radialKey(b));
  for (const [index, [x, y, r]] of points.entries()) {
    const circle = `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
    const slot = Math.min(groups.length - 1, Math.floor((index / points.length) * groups.length));
    groups[slot] = (groups[slot] ?? '') + circle;
  }
  return { points, groups };
}

const { points: orbisGalaxyPoints, groups: particlePaths } = galaxyParticlePaths();
export { orbisGalaxyPoints };

export function OrbisLogo({
  size = 28,
  className = '',
  plain = false,
  animated = false,
  dots = false,
  progress,
  animationElapsed = 0,
}: {
  size?: number;
  className?: string;
  plain?: boolean;
  animated?: boolean;
  dots?: boolean;
  progress?: number;
  animationElapsed?: number;
}) {
  const identity = `orbis-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const percentage = formationProgress(progress);
  const particles = (dots || animated || percentage !== undefined) && size >= 48;
  return (
    <svg
      className={`orbis-logo ${className}`.trim()}
      width={size}
      height={size}
      style={{ '--orbis-logo-size': `${size}px` } as CSSProperties}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-plain={plain || undefined}
      data-animated={animated || undefined}
      data-progress={percentage}
    >
      <defs>
        <radialGradient id={`${identity}-arm`} gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28">
          <stop offset="0" stopColor="var(--orbis-logo-light)" />
          <stop offset="0.3" stopColor="var(--orbis-logo-light)" />
          <stop offset="0.65" stopColor="var(--orbis-logo-colour)" />
          <stop offset="1" stopColor="var(--orbis-logo-colour)" stopOpacity="0.2" />
        </radialGradient>
      </defs>
      {particles ? (
        <g fill={`url(#${identity}-arm)`}>
          {particlePaths.map((d, index) => (
            <path
              key={d}
              className="orbis-logo-dot-group"
              d={d}
              style={
                {
                  '--orbis-dot-scale': 1.4 + index * 0.025,
                  '--orbis-dot-turn': '-12deg',
                  animationDelay: `${index * 25 - animationElapsed}ms`,
                  ...(percentage === undefined
                    ? {}
                    : {
                        transform: `rotate(${-12 * (1 - formationAmount(percentage, index))}deg) scale(${1 + (0.4 + index * 0.025) * (1 - formationAmount(percentage, index))})`,
                        opacity: 0.08 + 0.92 * formationAmount(percentage, index),
                      }),
                } as CSSProperties
              }
            />
          ))}
        </g>
      ) : (
        <>
          <g className="orbis-logo-galaxy" fill="none" stroke={`url(#${identity}-arm)`} strokeWidth={plain ? 3.2 : 3.6} strokeLinecap="round">
            {[0, 120, 240].map((angle) => (
              <path key={angle} className="orbis-logo-arm" pathLength={1} d={spiralArm} transform={`rotate(${angle} 32 32)`} />
            ))}
          </g>
          <circle className="orbis-logo-core" cx="32" cy="32" r="3.2" fill="var(--orbis-logo-light)" />
        </>
      )}
      {!particles && size >= 48 ? (
        <g className="orbis-logo-stars" fill="var(--orbis-logo-light)">
          <circle cx="20" cy="11" r="0.7" />
          <circle cx="52" cy="24" r="0.9" />
          <circle cx="39" cy="55" r="0.6" />
        </g>
      ) : null}
    </svg>
  );
}
