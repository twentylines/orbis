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

let initialPending = false;

function flushMeasurements() {
  const measurements = [...pending];
  pending.clear();
  // Read every heading before changing styles, so one heading cannot flush another's layout.
  const updates = measurements.map((read) => read());
  for (const update of updates) update?.();
}

function scheduleMeasurement(measure: Measurement, initial = false) {
  pending.add(measure);
  if (initial) {
    if (initialPending) return;
    initialPending = true;
    // Layout effects register all Home headings before this pre-paint batch runs.
    queueMicrotask(() => {
      initialPending = false;
      flushMeasurements();
    });
    return;
  }
  if (pendingFrame !== null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    flushMeasurements();
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

const backgroundColours = new WeakMap<Element, { base: string; colour: [number, number, number] }>();

function wallpaperBackground(desktop: Element, base: string) {
  const cached = backgroundColours.get(desktop);
  if (cached?.base === base) return cached.colour;
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
  backgroundColours.set(desktop, { base, colour: background });
  return background;
}

export function observeWallpaperText(target: HTMLElement, sample: WallpaperSample) {
  let connected = true;
  let previousColour: string | null = null;
  const desktop = target.closest('.desktop') ?? document.documentElement;
  const measure = () => {
    if (!connected) return;
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(desktop);
    const background = wallpaperBackground(desktop, style.backgroundColor);
    const modeDim = Number.parseFloat(style.getPropertyValue('--workspace-wallpaper-dim')) || 0;
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
      target.style.setProperty(
        '--workspace-heading-soft-shadow',
        colour === '#ffffff' ? '0 1px 4px rgb(0 0 0 / 0.72), 0 3px 14px rgb(0 0 0 / 0.32)' : 'none',
      );
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
  scheduleMeasurement(measure, true);
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
    target.style.removeProperty('--workspace-heading-soft-shadow');
  };
}
