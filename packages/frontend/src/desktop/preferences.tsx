import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { useUserContext } from '@/context/user-context';
import { useUIStore } from '@/stores/ui-store';

export type DesktopPreferences = {
  serverName: string;
  preset: 'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush';
  density: 'comfortable' | 'compact';
  wallpaper: 'sandstone' | 'tidal' | 'canopy';
};

export const defaultDesktopPreferences: DesktopPreferences = { serverName: 'Hades', preset: 'frost', density: 'comfortable', wallpaper: 'sandstone' };
const STORAGE_KEY = 'server-desktop-preferences-v1';

type StoredDesktopPreferences = Omit<DesktopPreferences, 'wallpaper'> & Partial<Pick<DesktopPreferences, 'wallpaper'>>;

export const isPreferences = (value: unknown): value is StoredDesktopPreferences => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverName === 'string' &&
    candidate.serverName.length >= 1 &&
    candidate.serverName.length <= 40 &&
    ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(String(candidate.preset)) &&
    ['comfortable', 'compact'].includes(String(candidate.density)) &&
    (candidate.wallpaper === undefined || ['sandstone', 'tidal', 'canopy'].includes(String(candidate.wallpaper)))
  );
};

export const normalisePreferences = (value: StoredDesktopPreferences): DesktopPreferences => ({ ...defaultDesktopPreferences, ...value });

type PreferenceContext = {
  preferences: DesktopPreferences;
  update: (value: Partial<DesktopPreferences>) => void;
  reset: () => void;
  syncState: 'local' | 'loading' | 'saving' | 'saved' | 'error';
};
const Context = createContext<PreferenceContext | null>(null);

export const DesktopPreferencesProvider = ({ children }: PropsWithChildren) => {
  const { isLoggedIn } = useUserContext();
  const setDarkMode = useUIStore((state) => state.setDarkMode);
  const [preferences, setPreferences] = useState(defaultDesktopPreferences);
  const [hydrated, setHydrated] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [syncState, setSyncState] = useState<PreferenceContext['syncState']>('local');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (isPreferences(saved)) setPreferences(normalisePreferences(saved));
    } catch {
      // Invalid local preferences safely fall back to defaults.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [hydrated, preferences]);

  useEffect(() => {
    if (hydrated) setDarkMode(preferences.preset === 'graphite');
  }, [hydrated, preferences.preset, setDarkMode]);

  useEffect(() => {
    if (!isLoggedIn) {
      setServerReady(false);
      setSyncState('local');
      return;
    }
    const controller = new AbortController();
    setSyncState('loading');
    fetch('/api/desktop-preferences', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preference load failed');
        const value: unknown = await response.json();
        if (!isPreferences(value)) throw new Error('Invalid server preferences');
        setPreferences(normalisePreferences(value));
        setServerReady(true);
        setSyncState('saved');
      })
      .catch(() => {
        if (!controller.signal.aborted) setSyncState('error');
      });
    return () => controller.abort();
  }, [isLoggedIn]);

  useEffect(() => {
    if (!serverReady || !hydrated) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSyncState('saving');
      try {
        const response = await fetch('/api/desktop-preferences', {
          method: 'PUT',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(preferences),
        });
        if (!response.ok) throw new Error('Preference save failed');
        setSyncState('saved');
      } catch {
        if (!controller.signal.aborted) setSyncState('error');
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [preferences, serverReady, hydrated]);

  const update = (value: Partial<DesktopPreferences>) =>
    setPreferences((previous) => {
      const next = { ...previous, ...value };
      return isPreferences(next) ? next : previous;
    });

  return (
    <Context.Provider value={{ preferences, update, reset: () => setPreferences(defaultDesktopPreferences), syncState }}>{children}</Context.Provider>
  );
};

export const useDesktopPreferences = () => {
  const context = useContext(Context);
  if (!context) throw new Error('DesktopPreferencesProvider is missing');
  return context;
};
