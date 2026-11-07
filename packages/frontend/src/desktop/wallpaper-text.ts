import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { wallpaperTextColour, type WallpaperSample } from './wallpaper-contrast';

let current: WallpaperSample | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => current;
const serverSnapshot = () => null;

type Measurement = () => (() => void) | undefined;
const pending = new Set<Measurement>();
let pendingFrame: number | null = null;

function scheduleMeasurement(measure: Measurement) {
  pending.add(measure);
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    const measurements = [...pending];
    pending.clear();
    // Read every heading before changing styles, so one heading cannot flush another's layout.
    const updates = measurements.map((read) => read());
    for (const update of updates) update?.();
  });
}

export function setWallpaperTextSample(sample: WallpaperSample | null) {
  current = sample;
  for (const listener of listeners) listener();
}

export function useWallpaperText<T extends HTMLElement>() {
  const [target, setTarget] = useState<T | null>(null);
  const sample = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useLayoutEffect(() => {
    if (!target || !sample) return;
    return observeWallpaperText(target, sample);
  }, [sample, target]);
  return setTarget;
}

export function observeWallpaperText(target: HTMLElement, sample: WallpaperSample) {
  let connected = true;
  let previousColour: string | null = null;
  const desktop = target.closest('.desktop') ?? document.documentElement;
  const base = getComputedStyle(desktop).backgroundColor;
  let background: [number, number, number] = [16, 24, 27];
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (context) {
      context.fillStyle = base;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      background = [pixel[0] ?? 16, pixel[1] ?? 24, pixel[2] ?? 27];
    }
  } catch {
    // Privacy-restricted canvas reads must not prevent using the dashboard.
  }
  const measure = () => {
    if (!connected) return;
    const rect = target.getBoundingClientRect();
    const modeDim = Number.parseFloat(getComputedStyle(desktop).getPropertyValue('--workspace-wallpaper-dim')) || 0;
    const colour = wallpaperTextColour(
      { ...sample, dim: 1 - (1 - sample.dim) * (1 - modeDim) },
      { width: window.innerWidth, height: window.innerHeight },
      rect,
      background,
    );
    if (!colour || colour === previousColour) return;
    return () => {
      if (!connected) return;
      previousColour = colour;
      target.style.setProperty('--workspace-heading-ink', colour);
      target.style.setProperty('--workspace-heading-edge', colour === '#ffffff' ? '#10181b' : '#ffffff');
    };
  };
  const schedule = () => {
    scheduleMeasurement(measure);
  };
  const scroll = (event: Event) => {
    const source = event.target;
    if (source === window || (source instanceof Node && source.contains(target))) schedule();
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(target);
  const modeObserver = new MutationObserver(schedule);
  modeObserver.observe(desktop, { attributes: true, attributeFilter: ['data-desktop-mode'] });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', scroll, { passive: true, capture: true });
  measure()?.();
  return () => {
    connected = false;
    observer.disconnect();
    modeObserver.disconnect();
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', scroll, true);
    pending.delete(measure);
    if (!pending.size && pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
    target.style.removeProperty('--workspace-heading-ink');
    target.style.removeProperty('--workspace-heading-edge');
  };
}
