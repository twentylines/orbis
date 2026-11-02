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

export function setWallpaperTextSample(sample: WallpaperSample | null) {
  current = sample;
  for (const listener of listeners) listener();
}

export function useWallpaperText<T extends HTMLElement>() {
  const [target, setTarget] = useState<T | null>(null);
  const sample = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useLayoutEffect(() => {
    if (!target || !sample) return;
    let frame = 0;
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
      frame = 0;
      const rect = target.getBoundingClientRect();
      const modeDim = Number.parseFloat(getComputedStyle(desktop).getPropertyValue('--workspace-wallpaper-dim')) || 0;
      const colour = wallpaperTextColour(
        { ...sample, dim: 1 - (1 - sample.dim) * (1 - modeDim) },
        { width: window.innerWidth, height: window.innerHeight },
        rect,
        background,
      );
      if (colour) {
        target.style.setProperty('--workspace-heading-ink', colour);
        target.style.setProperty('--workspace-heading-edge', colour === '#ffffff' ? '#10181b' : '#ffffff');
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    const modeObserver = new MutationObserver(schedule);
    modeObserver.observe(desktop, { attributes: true, attributeFilter: ['data-desktop-mode'] });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    measure();
    return () => {
      observer.disconnect();
      modeObserver.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      cancelAnimationFrame(frame);
      target.style.removeProperty('--workspace-heading-ink');
      target.style.removeProperty('--workspace-heading-edge');
    };
  }, [sample, target]);
  return setTarget;
}
