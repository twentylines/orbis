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

export type AppEmbeddingCheck = { status: 'blocked' | 'not-blocked-by-headers' | 'unknown'; reason: string };

export function appEmbeddingWarning(check?: AppEmbeddingCheck, knownBlocked = false) {
  if (check?.status === 'blocked' || (knownBlocked && check?.status === 'unknown')) {
    if (check?.reason === 'mixed-content')
      return {
        blocked: true,
        title: 'A secure address is needed',
        description: 'This secure Orbis page cannot embed an HTTP app. Use an HTTPS app address or open a browser tab.',
      };
    if (check?.reason === 'same-origin')
      return {
        blocked: true,
        title: 'This address needs a browser tab',
        description: 'Apps at the same address as Orbis cannot run safely inside an Orbis window.',
      };
    return {
      blocked: true,
      title: 'This app needs a browser tab',
      description: 'This app blocks embedded windows. Use a browser tab, or allow Orbis in its embedding settings if available.',
    };
  }
  if (check?.status === 'unknown' && check.reason === 'unreachable')
    return {
      blocked: false,
      title: 'The app did not respond',
      description:
        'Orbis could not reach this app during its compatibility check. It may still be reachable from your browser. Try its window or open a new tab.',
    };
  return undefined;
}
