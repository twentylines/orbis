import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { useUserContext } from '@/context/user-context';
import { StartupSurface } from '@/components/startup/startup-surface';
import toast from 'react-hot-toast';
import { desktopWindowsSchema, type DesktopWindows, type DesktopWindowId, type DesktopWindowState } from '@runtipi/common/schemas';
import { useResolvedColourMode, type ColourMode, type ResolvedColourMode } from './colour-mode';
import { appearanceFromStored, preferenceStorageKey } from './appearance-cache';

export const widgetIds = ['applications', 'activity', 'storage', 'attention'] as const;
export type WidgetId = (typeof widgetIds)[number];
export type WorkspacePreferences = { order: WidgetId[]; hidden: WidgetId[]; wide: WidgetId[]; pinnedApps: string[]; showAllApps: boolean };

export type DesktopPreferences = {
  serverName: string;
  preset: 'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush';
  mode: ColourMode;
  density: 'comfortable' | 'compact';
  wallpaper: 'sandstone' | 'tidal' | 'canopy';
  workspace: WorkspacePreferences;
  windows: DesktopWindows;
};

export const defaultDesktopPreferences: DesktopPreferences = {
  serverName: 'Server',
  preset: 'frost',
  mode: 'light',
  density: 'comfortable',
  wallpaper: 'sandstone',
  windows: {},
  workspace: { order: [...widgetIds], hidden: [], wide: ['applications'], pinnedApps: [], showAllApps: false },
};
const STORAGE_KEY = preferenceStorageKey;

type StoredWorkspacePreferences = Omit<WorkspacePreferences, 'pinnedApps' | 'showAllApps'> &
  Partial<Pick<WorkspacePreferences, 'pinnedApps' | 'showAllApps'>>;
type StoredDesktopPreferences = Omit<DesktopPreferences, 'mode' | 'wallpaper' | 'workspace' | 'windows'> &
  Partial<Pick<DesktopPreferences, 'mode' | 'wallpaper' | 'windows'>> & { workspace?: StoredWorkspacePreferences };

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
    (workspace.showAllApps === undefined || typeof workspace.showAllApps === 'boolean') &&
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
    (candidate.mode === undefined || ['light', 'dark', 'system'].includes(String(candidate.mode))) &&
    ['comfortable', 'compact'].includes(String(candidate.density)) &&
    (candidate.wallpaper === undefined || ['sandstone', 'tidal', 'canopy'].includes(String(candidate.wallpaper))) &&
    (candidate.workspace === undefined || isWorkspacePreferences(candidate.workspace)) &&
    (candidate.windows === undefined || desktopWindowsSchema.allows(candidate.windows))
  );
};

export const normalisePreferences = (value: StoredDesktopPreferences): DesktopPreferences => ({
  ...defaultDesktopPreferences,
  serverName: value.serverName,
  preset: value.preset,
  density: value.density,
  wallpaper: value.wallpaper ?? defaultDesktopPreferences.wallpaper,
  windows: value.windows ?? {},
  mode: value.mode ?? (value.preset === 'graphite' ? 'dark' : 'light'),
  workspace: {
    order: value.workspace?.order ?? [...widgetIds],
    hidden: value.workspace?.hidden ?? [],
    wide: value.workspace?.wide ?? ['applications'],
    pinnedApps: value.workspace?.pinnedApps ?? [],
    showAllApps: value.workspace?.showAllApps ?? false,
  },
});

function readPreferenceCache() {
  if (typeof window === 'undefined') return { preferences: defaultDesktopPreferences, available: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw && raw.length <= 16 * 1024 ? JSON.parse(raw) : null;
    return {
      preferences: isPreferences(value) ? normalisePreferences(value) : { ...defaultDesktopPreferences, ...appearanceFromStored(value) },
      available: true,
    };
  } catch {
    return { preferences: defaultDesktopPreferences, available: false };
  }
}

export function readCachedDesktopPreferences(): DesktopPreferences {
  return readPreferenceCache().preferences;
}

type PreferenceContext = {
  preferences: DesktopPreferences;
  resolvedMode: ResolvedColourMode;
  cacheAvailable: boolean;
  update: (value: Partial<DesktopPreferences>) => void;
  updateWindow: (id: DesktopWindowId, value: DesktopWindowState) => void;
  reset: () => void;
  syncState: 'local' | 'loading' | 'saving' | 'saved' | 'error';
  requiresOnboarding: boolean;
  completeOnboarding: (serverName: string) => Promise<void>;
};
const Context = createContext<PreferenceContext | null>(null);
const LOAD_NOTICE = 'desktop-preferences-load';

export const DesktopPreferencesProvider = ({ children }: PropsWithChildren) => {
  const { isLoggedIn } = useUserContext();
  const [cache] = useState(readPreferenceCache);
  const [preferences, setPreferences] = useState(cache.preferences);
  const resolvedMode = useResolvedColourMode(preferences.mode);
  const [cacheAvailable, setCacheAvailable] = useState(cache.available);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [requiresOnboarding, setRequiresOnboarding] = useState(true);
  const completingSetup = useRef(false);
  const [syncState, setSyncState] = useState<PreferenceContext['syncState']>('local');
  const revision = useRef(0);
  const acknowledgedRevision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (isLoggedIn && !initialLoadComplete) return;
    try {
      const stored = JSON.stringify(preferences);
      localStorage.setItem(STORAGE_KEY, stored);
      setCacheAvailable(localStorage.getItem(STORAGE_KEY) === stored);
    } catch {
      setCacheAvailable(false);
    }
  }, [initialLoadComplete, isLoggedIn, preferences]);

  useEffect(() => {
    if (!isLoggedIn) {
      setServerReady(false);
      setRequiresOnboarding(true);
      setSyncState('local');
      setInitialLoadComplete(false);
      setLoadAttempt(0);
      setLoadError(false);
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    const loadRevision = revision.current;
    const canReplace = loadAttempt === 0 || acknowledgedRevision.current === loadRevision;
    setSyncState('loading');
    setLoadError(false);
    Promise.all(
      ['/api/desktop-preferences', '/api/desktop-preferences/onboarding'].map(async (url) => {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error('Preference load failed');
        return response.json() as Promise<unknown>;
      }),
    )
      .then(([value, setup]) => {
        if (!isPreferences(value)) throw new Error('Invalid server preferences');
        if (!setup || typeof setup !== 'object' || !('complete' in setup) || typeof setup.complete !== 'boolean') {
          throw new Error('Invalid setup status');
        }
        if (controller.signal.aborted) throw new Error('Preference load expired');
        if (revision.current === loadRevision && canReplace) {
          acknowledgedRevision.current = loadRevision;
          setPreferences(normalisePreferences(value));
        }
        setServerReady(true);
        setRequiresOnboarding(!setup.complete);
        setSyncState(acknowledgedRevision.current === revision.current ? 'saved' : 'saving');
      })
      .catch(() => {
        if (!disposed) {
          setLoadError(true);
          setSyncState('error');
        }
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!disposed) setInitialLoadComplete(true);
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isLoggedIn, loadAttempt]);

  useEffect(() => {
    if (loadError) {
      toast.error(
        <>
          <p>Appearance could not be loaded. Using this browser’s settings.</p>
          <button
            type="button"
            className="btn btn-outline-primary"
            onClick={() => {
              const target =
                document.querySelector<HTMLElement>('.desktop-search-trigger, .desktop-auth input') ??
                document.querySelector<HTMLElement>('#root button:not([disabled]), #root a[href]') ??
                document.getElementById('root');
              target?.focus({ preventScroll: true });
              toast.dismiss(LOAD_NOTICE);
              setLoadAttempt((previous) => previous + 1);
            }}
          >
            Retry
          </button>
        </>,
        { id: LOAD_NOTICE, duration: Number.POSITIVE_INFINITY },
      );
    }
    return () => toast.dismiss(LOAD_NOTICE);
  }, [loadError]);

  useEffect(() => {
    if (!isLoggedIn || !serverReady || acknowledgedRevision.current === revision.current) return;
    let superseded = false;
    const saveRevision = revision.current;
    setSyncState('saving');
    const timer = window.setTimeout(() => {
      const save = async () => {
        if (superseded || saveRevision !== revision.current) return;
        try {
          const response = await fetch('/api/desktop-preferences', {
            method: 'PUT',
            credentials: 'include',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preferences),
          });
          if (!response.ok) throw new Error('Preference save failed');
          acknowledgedRevision.current = saveRevision;
          if (!superseded && revision.current === saveRevision) setSyncState('saved');
        } catch {
          if (!superseded && revision.current === saveRevision) setSyncState('error');
        }
      };
      saveQueue.current = saveQueue.current.then(save, save);
    }, 300);
    return () => {
      superseded = true;
      window.clearTimeout(timer);
    };
  }, [preferences, serverReady, isLoggedIn]);

  const update = (value: Partial<DesktopPreferences>) => {
    if (completingSetup.current) return;
    if (!isPreferences({ ...preferences, ...value })) return;
    revision.current += 1;
    setSyncState(isLoggedIn ? (serverReady ? 'saving' : syncState === 'loading' ? 'loading' : 'error') : 'local');
    setPreferences((previous) => {
      const next = { ...previous, ...value };
      return isPreferences(next) ? next : previous;
    });
  };

  const reset = () => {
    if (completingSetup.current) return;
    revision.current += 1;
    setSyncState(isLoggedIn ? (serverReady ? 'saving' : syncState === 'loading' ? 'loading' : 'error') : 'local');
    setPreferences({ ...defaultDesktopPreferences, workspace: { ...defaultDesktopPreferences.workspace } });
  };

  const updateWindow = (id: DesktopWindowId, value: DesktopWindowState) => {
    if (completingSetup.current) return;
    if (!desktopWindowsSchema.allows({ [id]: value })) return;
    revision.current += 1;
    setSyncState(isLoggedIn ? (serverReady ? 'saving' : syncState === 'loading' ? 'loading' : 'error') : 'local');
    setPreferences((previous) => ({ ...previous, windows: { ...previous.windows, [id]: value } }));
  };

  const completeOnboarding = async (serverName: string) => {
    const next = { ...preferences, serverName: serverName.trim() };
    if (!isLoggedIn || !serverReady || !isPreferences(next) || completingSetup.current) throw new Error('Setup cannot be saved yet. Try again.');
    completingSetup.current = true;
    const saveRevision = ++revision.current;
    setSyncState('saving');
    const save = async () => {
      const saved = await fetch('/api/desktop-preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!saved.ok) throw new Error('Server settings could not be saved. Try again.');
      const completed = await fetch('/api/desktop-preferences/onboarding', { method: 'POST', credentials: 'include' });
      if (!completed.ok || (await completed.json()).complete !== true) throw new Error('Setup could not be completed. Try again.');
      acknowledgedRevision.current = saveRevision;
      setPreferences(next);
      setRequiresOnboarding(false);
      setSyncState('saved');
    };
    const pending = saveQueue.current.then(save, save);
    saveQueue.current = pending.catch(() => undefined);
    try {
      await pending;
    } catch (error) {
      setSyncState('error');
      throw error;
    } finally {
      completingSetup.current = false;
    }
  };

  return (
    <Context.Provider
      value={{ preferences, resolvedMode, cacheAvailable, update, updateWindow, reset, syncState, requiresOnboarding, completeOnboarding }}
    >
      {isLoggedIn && !initialLoadComplete ? <StartupSurface appearance={preferences} /> : children}
    </Context.Provider>
  );
};

export const useDesktopPreferences = () => {
  const context = useContext(Context);
  if (!context) throw new Error('DesktopPreferencesProvider is missing');
  return context;
};
