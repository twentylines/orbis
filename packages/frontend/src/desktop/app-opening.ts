import type { AppLaunchPreferences, DesktopWindowBounds } from '@runtipi/common/schemas';
import type { WindowArea } from './window-geometry';
import { clampAppBounds } from './app-window-layout';

function appUrl(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

export const appAddress = (value?: string) => appUrl(value)?.href;

export function canEmbedApp(url: string, origin: string, desktop: boolean) {
  return desktop && !appEmbeddingBoundary(url, origin);
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

export function appEmbeddingBoundary(url: string | undefined, origin: string): AppEmbeddingCheck | undefined {
  const target = appUrl(url);
  const source = appUrl(origin);
  if (!target || !source) return { status: 'blocked', reason: 'invalid-address' };
  if (source.protocol === 'https:' && target.protocol === 'http:') return { status: 'blocked', reason: 'mixed-content' };
  if (target.origin === source.origin) return { status: 'blocked', reason: 'same-origin' };
}

export function appEmbeddingWarning(check?: AppEmbeddingCheck) {
  if (check?.status === 'blocked') {
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
    if (check?.reason === 'invalid-address')
      return {
        blocked: true,
        title: 'An app address is needed',
        description: 'Set a complete HTTP or HTTPS app address without embedded credentials before opening its window.',
      };
    return {
      blocked: false,
      title: 'Server restriction',
      description: 'The server reports an embedding restriction. Your signed-in browser may differ.',
    };
  }
  if (check?.status === 'unknown' && check.reason === 'unreachable')
    return {
      blocked: false,
      title: 'Check unavailable',
      description: 'The server could not verify this app. Your browser may still connect.',
    };
  return undefined;
}
