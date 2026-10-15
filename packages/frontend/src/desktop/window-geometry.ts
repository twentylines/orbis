import type { DesktopWindowBounds, DesktopWindowState } from '@runtipi/common/schemas';

export type WindowArea = DesktopWindowBounds;
export const WINDOW_MIN_WIDTH = 520;
export const WINDOW_MIN_HEIGHT = 320;
export const canSnapWindow = (area: WindowArea) => area.width >= WINDOW_MIN_WIDTH * 2 + 16;

export function clampWindowBounds(bounds: DesktopWindowBounds, area: WindowArea): DesktopWindowBounds {
  const width = Math.round(Math.min(area.width, Math.max(Math.min(WINDOW_MIN_WIDTH, area.width), bounds.width)));
  const height = Math.round(Math.min(area.height, Math.max(Math.min(WINDOW_MIN_HEIGHT, area.height), bounds.height)));
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))),
    width,
    height,
  };
}

export function defaultWindowBounds(area: WindowArea): DesktopWindowBounds {
  const width = Math.min(1040, Math.round(area.width * 0.86));
  const height = Math.min(800, Math.round(area.height * 0.9));
  return clampWindowBounds({ x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }, area);
}

export function placedWindowBounds(mode: DesktopWindowState['mode'], bounds: DesktopWindowBounds, area: WindowArea): DesktopWindowBounds {
  if (mode === 'maximized') return area;
  if ((mode === 'left' || mode === 'right') && canSnapWindow(area)) {
    const width = Math.floor((area.width - 16) / 2);
    return { ...area, x: mode === 'left' ? area.x : area.x + area.width - width, width };
  }
  return clampWindowBounds(bounds, area);
}
