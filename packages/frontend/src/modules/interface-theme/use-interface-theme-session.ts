import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { InterfaceThemeIdentity, InterfaceThemeValue } from '@runtipi/common/schemas/interface-theme';
import type { ResolvedInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import { themePacksChanged } from '../theme-packs/theme-packs-api';
import { createThemeSettingsClient, type ThemeSettingsClient } from './theme-settings-api';
import { InterfaceThemeDraftStore, type InterfaceThemeDraft, type InterfaceThemeDraftSnapshot } from './theme-settings-drafts';
import { readPublicInterfaceThemeCache, rememberPublicInterfaceThemeCache } from './interface-theme-cache';

export type InterfaceThemeSession = InterfaceThemeDraftSnapshot & {
  current: InterfaceThemeDraft | null;
  preview: ResolvedInterfaceThemeSettings | null;
  cacheAvailable: boolean;
  setValue: (key: string, value: InterfaceThemeValue) => boolean;
  setColourText: (key: string, value: string) => boolean;
  setNumberText: (key: string, value: string) => boolean;
  reset: () => void;
  discard: (identity?: InterfaceThemeIdentity) => void;
  prepare: (identity: InterfaceThemeIdentity) => Promise<(() => Promise<void>) | null>;
  reload: () => Promise<void>;
  migrate: () => Promise<void>;
  forTheme: (identity: InterfaceThemeIdentity | null) => {
    binding: InterfaceThemeDraft | null;
    setValue: (key: string, value: InterfaceThemeValue) => boolean;
    setColourText: (key: string, value: string) => boolean;
    setNumberText: (key: string, value: string) => boolean;
    reset: () => void;
  };
};

export function useInterfaceThemeSession({
  enabled,
  identity,
  client,
}: {
  enabled: boolean;
  identity: InterfaceThemeIdentity | null;
  client?: ThemeSettingsClient;
}): InterfaceThemeSession {
  const [store] = useState(() => new InterfaceThemeDraftStore(client ?? createThemeSettingsClient(), readPublicInterfaceThemeCache()));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const id = identity?.id;
  const version = identity?.version;
  const target = useMemo(() => (id && version ? { id, version } : null), [id, version]);
  const [cacheAvailable, setCacheAvailable] = useState(true);
  const current = useMemo(() => store.binding(target, state), [store, state, target]);
  const preview = useMemo(() => store.preview(target, state), [store, state, target]);
  const drafts = useMemo(
    () =>
      state.drafts.map((draft) =>
        current && draft.descriptor.id === current.descriptor.id && draft.descriptor.settingsVersion === current.descriptor.settingsVersion
          ? current
          : draft,
      ),
    [state.drafts, current],
  );
  useEffect(() => {
    if (!enabled) {
      store.disconnect();
      return;
    }
    const controller = new AbortController();
    const reload = () => {
      void store.load(controller.signal);
    };
    reload();
    window.addEventListener(themePacksChanged, reload);
    window.addEventListener('focus', reload);
    return () => {
      controller.abort();
      window.removeEventListener(themePacksChanged, reload);
      window.removeEventListener('focus', reload);
      store.disconnect();
    };
  }, [enabled, store]);
  useEffect(() => {
    if (state.document) setCacheAvailable(rememberPublicInterfaceThemeCache(state.document));
  }, [state.document]);
  const setValue = useCallback((key: string, value: InterfaceThemeValue) => store.setValue(target, key, value), [store, target]);
  const setColourText = useCallback((key: string, value: string) => store.setColourText(target, key, value), [store, target]);
  const setNumberText = useCallback((key: string, value: string) => store.setNumberText(target, key, value), [store, target]);
  const reset = useCallback(() => store.reset(target), [store, target]);
  const discard = useCallback((requested?: InterfaceThemeIdentity) => store.discard(requested ?? target), [store, target]);
  const prepare = useCallback((target: InterfaceThemeIdentity) => store.prepare(target), [store]);
  const reload = useCallback(() => store.load(), [store]);
  const migrate = useCallback(() => store.migrate(), [store]);
  const forTheme = useCallback(
    (requested: InterfaceThemeIdentity | null) => ({
      binding: store.binding(requested, state),
      setValue: (key: string, value: InterfaceThemeValue) => store.setValue(requested, key, value),
      setColourText: (key: string, value: string) => store.setColourText(requested, key, value),
      setNumberText: (key: string, value: string) => store.setNumberText(requested, key, value),
      reset: () => store.reset(requested),
    }),
    [store, state],
  );
  return {
    ...state,
    drafts,
    current,
    preview,
    cacheAvailable,
    setValue,
    setColourText,
    setNumberText,
    reset,
    discard,
    prepare,
    reload,
    migrate,
    forTheme,
  };
}
