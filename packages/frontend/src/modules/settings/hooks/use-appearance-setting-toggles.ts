import { useContext, useEffect, useRef, useState } from 'react';
import { useUserContext } from '@/context/user-context';
import { DesktopPreferencesContext } from '@/desktop/preferences-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { SettingToggle } from './use-autosaved-toggle';

const fields = {
  'oled-dark-mode': 'oledDark',
  'energy-saving': 'lowEffects',
} as const;
type AppearanceToggleId = keyof typeof fields;
const appearanceToggleIds = Object.keys(fields) as AppearanceToggleId[];

type Change = {
  session: AbortSignal;
  generation: string | null;
  checked: boolean;
  saved: boolean;
};
type Changes = Partial<Record<AppearanceToggleId, Change>>;

export function useAppearanceSettingToggles(ids: readonly string[], enabled: boolean): Partial<Record<AppearanceToggleId, SettingToggle>> {
  const { isLoggedIn, sessionAbortSignal } = useUserContext();
  const desktop = useContext(DesktopPreferencesContext);
  const syncState = desktop?.syncState;
  const onboardingGeneration = desktop?.onboardingGeneration;
  const visible = useWindowVisible();
  const oledDark = desktop?.preferences.appearance.oledDark;
  const lowEffects = desktop?.preferences.appearance.lowEffects;
  const [changes, setChanges] = useState<Changes>({});
  const loadedSession = useRef<AbortSignal | null>(null);

  useEffect(() => {
    if (syncState === 'saved') loadedSession.current = sessionAbortSignal;
  }, [syncState, sessionAbortSignal]);

  useEffect(() => {
    setChanges((previous) => {
      let next = previous;
      const checked = { 'oled-dark-mode': oledDark, 'energy-saving': lowEffects };
      for (const id of appearanceToggleIds) {
        const change = previous[id];
        if (!change) continue;
        if (change.session !== sessionAbortSignal || change.generation !== onboardingGeneration || change.checked !== checked[id]) {
          if (next === previous) next = { ...previous };
          delete next[id];
        } else if (!change.saved && syncState === 'saved') {
          if (next === previous) next = { ...previous };
          next[id] = { ...change, saved: true };
        }
      }
      return next;
    });
  }, [lowEffects, oledDark, onboardingGeneration, sessionAbortSignal, syncState]);

  if (!desktop) return {};
  const authenticated = isLoggedIn && !sessionAbortSignal.aborted && !desktop.requiresOnboarding;
  const disabled =
    !enabled ||
    !visible ||
    !authenticated ||
    syncState === 'local' ||
    syncState === 'loading' ||
    (syncState === 'error' && loadedSession.current !== sessionAbortSignal);

  const controls: Partial<Record<AppearanceToggleId, SettingToggle>> = {};
  for (const id of appearanceToggleIds) {
    if (!ids.includes(id)) continue;
    const field = fields[id];
    const checked = desktop.preferences.appearance[field];
    const change = changes[id];
    const current =
      authenticated && change?.session === sessionAbortSignal && change.generation === onboardingGeneration && change.checked === checked
        ? change
        : null;
    const saved = Boolean(current && (current.saved || syncState === 'saved'));
    const pending = Boolean(current && !saved && syncState === 'saving');
    const error = current && !saved && syncState === 'error' ? 'This appearance change could not be saved. Try again.' : null;
    const setChecked = (next: boolean) => {
      if (disabled || sessionAbortSignal.aborted) return;
      setChanges((previous) => ({
        ...previous,
        [id]: { session: sessionAbortSignal, generation: desktop.onboardingGeneration, checked: next, saved: false },
      }));
      desktop.updateAppearance({ [field]: next });
    };
    controls[id] = { id, checked, pending, saved, disabled, error, setChecked, retry: error ? () => setChecked(checked) : undefined };
  }
  return controls;
}
