import type { AppLaunchPreferences, DesktopWindowBounds } from '@runtipi/common/schemas';
import type { WindowArea } from './window-geometry';
import { clampAppBounds } from './app-window-layout';

export function appAddress(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function canEmbedApp(url: string, origin: string, desktop: boolean) {
  return desktop && !(new URL(origin).protocol === 'https:' && new URL(url).protocol === 'http:') && new URL(url).origin !== new URL(origin).origin;
}

export function appOpeningMode(preferences: AppLaunchPreferences, key: string, url: string, origin: string, desktop: boolean) {
  if (preferences.mode === 'tab' || !canEmbedApp(url, origin, desktop)) return 'tab';
  return preferences.apps[key]?.mode ?? preferences.mode;
}

export function primaryAppAddress(destinations: { url: string }[], origin: string) {
  return (new URL(origin).protocol === 'https:' ? destinations.find(({ url }) => url.startsWith('https:')) : undefined)?.url ?? destinations[0]?.url;
}

export function initialAppBounds(area: WindowArea, saved?: DesktopWindowBounds, categories: string[] = []) {
  if (saved) return clampAppBounds(saved, area);
  const compact = categories.some((category) => ['utilities', 'security'].includes(category));
  const width = Math.min(compact ? 940 : 1280, Math.round(area.width * (compact ? 0.84 : 0.92)));
  const height = Math.min(compact ? 720 : 900, Math.round(area.height * 0.94));
  return clampAppBounds({ ...area, x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }, area);
}

export function restoreAppBounds(area: WindowArea, floating: DesktopWindowBounds, categories: string[] = []) {
  const bounds = clampAppBounds(floating, area);
  return bounds.width >= area.width - 1 && bounds.height >= area.height - 1 ? initialAppBounds(area, undefined, categories) : bounds;
}
