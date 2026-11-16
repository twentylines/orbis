import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { glassDisplacement } from './glass-displacement';
import { interstellarBackdropSource } from './interstellar-backdrop';
import './refractive-scene.css';

const maps = new Map<string, string>();
function refractionMap(width: number, height: number) {
  const key = `${width}:${height}`;
  const previous = maps.get(key);
  if (previous) return previous;
  const value = glassDisplacement(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = value.width;
  canvas.height = value.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(value.width, value.height);
  image.data.set(value.data);
  context.putImageData(image, 0, 0);
  const source = canvas.toDataURL();
  maps.set(key, source);
  if (maps.size > 8) maps.delete(maps.keys().next().value ?? '');
  return source;
}

export function RefractiveScene() {
  const svg = useRef<SVGSVGElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [bounds, setBounds] = useState({ x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 });
  const [map, setMap] = useState<string | null>(null);
  useLayoutEffect(() => {
    const card = svg.current?.parentElement;
    if (!card) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const box = card.getBoundingClientRect();
      const next = {
        x: box.left,
        y: box.top,
        width: Math.round(box.width),
        height: Math.round(box.height),
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      };
      setBounds((previous) =>
        Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next,
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(card);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    svg.current?.style.setProperty('--orbis-interstellar-delay', `${-performance.now()}ms`);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    if (!bounds.width || !bounds.height) return;
    const timer = window.setTimeout(() => setMap(refractionMap(bounds.width, bounds.height)), 100);
    return () => window.clearTimeout(timer);
  }, [bounds.width, bounds.height]);
  const edge = 28;
  const strips = [
    { name: 'top', x: -16, y: -16, width: bounds.width + 32, height: edge + 32 },
    { name: 'bottom', x: -16, y: bounds.height - edge - 16, width: bounds.width + 32, height: edge + 32 },
    { name: 'left', x: -16, y: -16, width: edge + 32, height: bounds.height + 32 },
    { name: 'right', x: bounds.width - edge - 16, y: -16, width: edge + 32, height: bounds.height + 32 },
  ];
  return (
    <svg
      ref={svg}
      className="orbis-scene-refraction"
      viewBox={`0 0 ${bounds.width || 1} ${bounds.height || 1}`}
      preserveAspectRatio="none"
      focusable="false"
      aria-hidden="true"
    >
      {map ? (
        <>
          <defs>
            <mask id={`${id}-edge`} maskUnits="userSpaceOnUse" x="0" y="0" width={bounds.width} height={bounds.height}>
              <rect
                x="1"
                y="1"
                width={Math.max(0, bounds.width - 2)}
                height={Math.max(0, bounds.height - 2)}
                rx="24"
                fill="none"
                stroke="white"
                strokeWidth="42"
              />
            </mask>
            {strips.map((strip) => (
              <filter
                key={strip.name}
                id={`${id}-${strip.name}`}
                filterUnits="userSpaceOnUse"
                x={strip.x}
                y={strip.y}
                width={strip.width}
                height={strip.height}
                colorInterpolationFilters="sRGB"
              >
                <feImage href={map} x="0" y="0" width={bounds.width} height={bounds.height} preserveAspectRatio="none" result="refraction" />
                <feDisplacementMap in="SourceGraphic" in2="refraction" scale="18" xChannelSelector="R" yChannelSelector="G" />
              </filter>
            ))}
          </defs>
          <g mask={`url(#${id}-edge)`}>
            {strips.map((strip) => (
              <g key={strip.name} filter={`url(#${id}-${strip.name})`}>
                <image
                  className="orbis-refraction-image"
                  href={interstellarBackdropSource}
                  x={-bounds.x - bounds.viewportWidth * 0.08}
                  y={-bounds.y - bounds.viewportHeight * 0.08}
                  width={bounds.viewportWidth * 1.16}
                  height={bounds.viewportHeight * 1.16}
                  preserveAspectRatio="xMidYMid slice"
                />
              </g>
            ))}
          </g>
        </>
      ) : null}
    </svg>
  );
}
