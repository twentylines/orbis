import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { useUserContext } from '@/context/user-context';
import { useUIStore } from '@/stores/ui-store';

export const widgetIds = ['applications', 'activity', 'storage', 'attention'] as const;
export type WidgetId = (typeof widgetIds)[number];
export type WorkspacePreferences = { order: WidgetId[]; hidden: WidgetId[]; wide: WidgetId[]; pinnedApps: string[] };

export type DesktopPreferences = {
  serverName: string;
  preset: 'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush';
  density: 'comfortable' | 'compact';
  wallpaper: 'sandstone' | 'tidal' | 'canopy';
  workspace: WorkspacePreferences;
};

export const defaultDesktopPreferences: DesktopPreferences = {
  serverName: 'Hades',
  preset: 'frost',
  density: 'comfortable',
  wallpaper: 'sandstone',
  workspace: { order: [...widgetIds], hidden: [], wide: ['applications'], pinnedApps: [] },
};
const STORAGE_KEY = 'server-desktop-preferences-v1';

type StoredWorkspacePreferences = Omit<WorkspacePreferences, 'pinnedApps'> & Partial<Pick<WorkspacePreferences, 'pinnedApps'>>;
type StoredDesktopPreferences = Omit<DesktopPreferences, 'wallpaper' | 'workspace'> &
  Partial<Pick<DesktopPreferences, 'wallpaper'>> & { workspace?: StoredWorkspacePreferences };

const isWidgetList = (value: unknown): value is WidgetId[] =>
  Array.isArray(value) && value.length <= widgetIds.length && new Set(value).size === value.length && value.every((item) => widgetIds.includes(item));

export const isWorkspacePreferences = (value: unknown): value is StoredWorkspacePreferences => {
  if (!value || typeof value !== 'object') return false;
  const workspace = value as Record<string, unknown>;
  return (
    isWidgetList(workspace.order) &&
    workspace.order.length === widgetIds.length &&
    isWidgetList(workspace.hidden) &&
    isWidgetList(workspace.wide) &&
    (workspace.pinnedApps === undefined ||
      (Array.isArray(workspace.pinnedApps) &&
        workspace.pinnedApps.length <= 12 &&
        new Set(workspace.pinnedApps).size === workspace.pinnedApps.length &&
        workspace.pinnedApps.every((urn) => typeof urn === 'string' && urn.length > 2 && urn.length <= 180 && /^[^:]+:[^:]+$/.test(urn))))
  );
};

export const isPreferences = (value: unknown): value is StoredDesktopPreferences => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverName === 'string' &&
    candidate.serverName.length >= 1 &&
    candidate.serverName.length <= 40 &&
    ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(String(candidate.preset)) &&
    ['comfortable', 'compact'].includes(String(candidate.density)) &&
    (candidate.wallpaper === undefined || ['sandstone', 'tidal', 'canopy'].includes(String(candidate.wallpaper))) &&
    (candidate.workspace === undefined || isWorkspacePreferences(candidate.workspace))
  );
};

export const normalisePreferences = (value: StoredDesktopPreferences): DesktopPreferences => ({
  ...defaultDesktopPreferences,
  ...value,
  workspace: { ...defaultDesktopPreferences.workspace, ...value.workspace },
});

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
  const revision = useRef(0);

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
    const loadRevision = revision.current;
    setSyncState('loading');
    fetch('/api/desktop-preferences', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preference load failed');
        const value: unknown = await response.json();
        if (!isPreferences(value)) throw new Error('Invalid server preferences');
        if (revision.current === loadRevision) setPreferences(normalisePreferences(value));
        setServerReady(true);
        setSyncState(revision.current === loadRevision ? 'saved' : 'saving');
      })
      .catch(() => {
        if (!controller.signal.aborted) setSyncState('error');
      });
    return () => controller.abort();
  }, [isLoggedIn]);

  useEffect(() => {
    if (!serverReady || !hydrated) return;
    const controller = new AbortController();
    const saveRevision = revision.current;
    setSyncState('saving');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/desktop-preferences', {
          method: 'PUT',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(preferences),
        });
        if (!response.ok) throw new Error('Preference save failed');
        if (revision.current === saveRevision) setSyncState('saved');
      } catch {
        if (!controller.signal.aborted && revision.current === saveRevision) setSyncState('error');
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [preferences, serverReady, hydrated]);

  const update = (value: Partial<DesktopPreferences>) => {
    if (!isPreferences({ ...preferences, ...value })) return;
    revision.current += 1;
    setSyncState('saving');
    setPreferences((previous) => {
      const next = { ...previous, ...value };
      return isPreferences(next) ? next : previous;
    });
  };

  const reset = () => {
    revision.current += 1;
    setSyncState('saving');
    setPreferences({ ...defaultDesktopPreferences, workspace: { ...defaultDesktopPreferences.workspace } });
  };

  return <Context.Provider value={{ preferences, update, reset, syncState }}>{children}</Context.Provider>;
};

export const useDesktopPreferences = () => {
  const context = useContext(Context);
  if (!context) throw new Error('DesktopPreferencesProvider is missing');
  return context;
};
