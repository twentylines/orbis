import type { AppLaunchPreferences, DesktopWindowBounds } from '@runtipi/common/schemas';
import { clampWindowBounds, type WindowArea } from './window-geometry';

export function appAddress(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function appOpeningMode(preferences: AppLaunchPreferences, key: string, url: string, origin: string, desktop: boolean) {
  if (!desktop || (new URL(origin).protocol === 'https:' && new URL(url).protocol === 'http:') || new URL(url).origin === new URL(origin).origin)
    return 'tab';
  return preferences.apps[key]?.mode ?? preferences.mode;
}

export function primaryAppAddress(destinations: { url: string }[], origin: string) {
  return (new URL(origin).protocol === 'https:' ? destinations.find(({ url }) => url.startsWith('https:')) : undefined)?.url ?? destinations[0]?.url;
}

export function initialAppBounds(area: WindowArea, saved?: DesktopWindowBounds, categories: string[] = []) {
  if (saved) return clampWindowBounds(saved, area);
  const compact = categories.some((category) => ['utilities', 'security'].includes(category));
  const width = Math.min(area.width, compact ? 820 : 1200);
  const height = Math.min(area.height, compact ? 640 : 840);
  return clampWindowBounds({ ...area, x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }, area);
}
