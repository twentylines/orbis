import type { DesktopWindowBounds } from '@runtipi/common/schemas';
import type { WindowArea } from './window-geometry';

export type AppWindowMode = 'floating' | 'maximized' | 'left' | 'right';
export type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const APP_WINDOW_MIN_WIDTH = 420;
export const APP_WINDOW_MIN_HEIGHT = 300;
export const APP_WINDOW_GAP = 16;

const limit = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function clampAppBounds(bounds: DesktopWindowBounds, area: WindowArea): DesktopWindowBounds {
  const width = limit(bounds.width, Math.min(APP_WINDOW_MIN_WIDTH, area.width), area.width);
  const height = limit(bounds.height, Math.min(APP_WINDOW_MIN_HEIGHT, area.height), area.height);
  return {
    x: Math.round(limit(bounds.x, area.x, area.x + area.width - width)),
    y: Math.round(limit(bounds.y, area.y, area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export const canSplitAppWindows = (area: WindowArea) => area.width >= APP_WINDOW_MIN_WIDTH * 2 + APP_WINDOW_GAP;

export function splitAppBounds(side: 'left' | 'right', area: WindowArea, ratio = 0.5): DesktopWindowBounds {
  const available = Math.max(1, area.width - APP_WINDOW_GAP);
  const minimum = Math.min(APP_WINDOW_MIN_WIDTH, available / 2);
  const leftWidth = Math.round(limit(available * ratio, minimum, available - minimum));
  return side === 'left' ? { ...area, width: leftWidth } : { ...area, x: area.x + leftWidth + APP_WINDOW_GAP, width: available - leftWidth };
}

export function resizeAppBounds(bounds: DesktopWindowBounds, edge: ResizeEdge, dx: number, dy: number, area: WindowArea): DesktopWindowBounds {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const minimumWidth = Math.min(APP_WINDOW_MIN_WIDTH, area.width);
  const minimumHeight = Math.min(APP_WINDOW_MIN_HEIGHT, area.height);
  const x = edge.includes('w') ? limit(bounds.x + dx, area.x, right - minimumWidth) : bounds.x;
  const y = edge.includes('n') ? limit(bounds.y + dy, area.y, bottom - minimumHeight) : bounds.y;
  const nextRight = edge.includes('e') ? limit(right + dx, x + minimumWidth, area.x + area.width) : right;
  const nextBottom = edge.includes('s') ? limit(bottom + dy, y + minimumHeight, area.y + area.height) : bottom;
  return clampAppBounds({ x, y, width: nextRight - x, height: nextBottom - y }, area);
}

export function appSnapTarget(x: number, y: number, area: WindowArea): Exclude<AppWindowMode, 'floating'> | null {
  if (canSplitAppWindows(area) && x <= area.x + 24) return 'left';
  if (canSplitAppWindows(area) && x >= area.x + area.width - 24) return 'right';
  return y <= area.y + 18 ? 'maximized' : null;
}
