import { useEffect, useSyncExternalStore } from 'react';
import type { ThemePackState } from '@runtipi/common/schemas/theme-pack';
import { themePacksChanged, themePacksRequest } from './theme-packs-api';
import { rememberThemePackCache, subscribeThemePackAppearance, themePackAppearanceSnapshot } from './theme-pack-cache';

export function cacheThemePackSelection(state: ThemePackState) {
  const selected =
    state.installed.find((item) => item.manifest.id === state.selected?.id && item.manifest.version === state.selected.version)?.manifest ?? null;
  return rememberThemePackCache(selected);
}

export function useThemePack(enabled: boolean) {
  const pack = useSyncExternalStore(subscribeThemePackAppearance, themePackAppearanceSnapshot, themePackAppearanceSnapshot);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const { state } = await themePacksRequest('', 'GET', undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (!controller.signal.aborted && current === revision) {
          cacheThemePackSelection(state);
        }
      } catch {
        // Keep the last verified selection during a temporary connection failure.
      }
    };
    const changed = () => {
      void refresh();
    };
    window.addEventListener(themePacksChanged, changed);
    window.addEventListener('focus', changed);
    void refresh();
    return () => {
      controller.abort();
      window.removeEventListener(themePacksChanged, changed);
      window.removeEventListener('focus', changed);
    };
  }, [enabled]);
  return pack;
}
