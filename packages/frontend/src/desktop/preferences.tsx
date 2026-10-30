import { useThemePack } from '@/modules/theme-packs/use-theme-pack';
import { applyThemePackRuntime, themePackAppearance } from '@/modules/theme-packs/theme-pack-runtime';
import '@/modules/theme-packs/theme-pack-runtime.css';
import { applyAppearanceRuntime } from './appearance-runtime';
import { transitionAppearance } from './theme-motion';
import { MotionPreferences } from './motion-preferences';
import { useLayoutEffect, createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { useUserContext } from '@/context/user-context';
import { useStartupReady } from '@/components/startup/startup-boundary';
import { useLocation } from 'react-router';
import toast from 'react-hot-toast';
import { desktopWindowsSchema, type DesktopWindows, type DesktopWindowId, type DesktopWindowState } from '@runtipi/common/schemas/desktop-windows';
import { appLaunchSchema, defaultAppLaunch, type AppLaunchPreferences } from '@runtipi/common/schemas/app-launch';
import { desktopAppearanceSchema, normaliseDesktopAppearance, type DesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { useResolvedColourMode, readSystemColourMode, type ColourMode, type ResolvedColourMode } from './colour-mode';
import { appearanceFromStored, preferenceStorageKey, preferenceCacheLimit, preferenceChangeEvent, appearanceCacheEvent } from './appearance-cache';
import { validHomePins } from './workspace-apps';
import { resolveWallpaperKey, type ThemePreset } from './wallpaper-presets';
import { validHiddenRecommendationCategories, type StoreRecommendationCategory } from '@/modules/app/components/store-discover/store-recommendations';

export const widgetIds = ['applications', 'activity', 'storage', 'attention'] as const;
export type WidgetId = (typeof widgetIds)[number];
export type WorkspacePreferences = { order: WidgetId[]; hidden: WidgetId[]; wide: WidgetId[]; pinnedApps: string[]; showAllApps: boolean };

export type DesktopPreferences = {
  serverName: string;
  preset: 'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush';
  mode: ColourMode;
  density: 'comfortable' | 'compact';
  wallpaper: 'sandstone' | 'tidal' | 'canopy';
  wallpaperMode: 'theme' | 'custom';
  wallpaperPreset: ThemePreset | null;
  workspace: WorkspacePreferences;
  windows: DesktopWindows;
  appLaunch: AppLaunchPreferences;
  appearance: DesktopAppearance;
  showStoreRecommendations: boolean;
  hiddenStoreRecommendationCategories: StoreRecommendationCategory[];
};

export const defaultDesktopPreferences: DesktopPreferences = {
  serverName: 'Server',
  preset: 'frost',
  mode: 'light',
  density: 'comfortable',
  wallpaper: 'sandstone',
  wallpaperMode: 'theme',
  wallpaperPreset: null,
  windows: {},
  appLaunch: defaultAppLaunch,
  appearance: normaliseDesktopAppearance(),
  showStoreRecommendations: true,
  hiddenStoreRecommendationCategories: [],
  workspace: { order: [...widgetIds], hidden: [], wide: ['applications'], pinnedApps: [], showAllApps: false },
};
const STORAGE_KEY = preferenceStorageKey;

type StoredWorkspacePreferences = Omit<WorkspacePreferences, 'pinnedApps' | 'showAllApps'> &
  Partial<Pick<WorkspacePreferences, 'pinnedApps' | 'showAllApps'>>;
type StoredDesktopPreferences = Omit<
  DesktopPreferences,
  | 'mode'
  | 'wallpaper'
  | 'workspace'
  | 'windows'
  | 'appearance'
  | 'appLaunch'
  | 'wallpaperMode'
  | 'wallpaperPreset'
  | 'showStoreRecommendations'
  | 'hiddenStoreRecommendationCategories'
> &
  Partial<
    Pick<
      DesktopPreferences,
      | 'mode'
      | 'wallpaper'
      | 'windows'
      | 'appLaunch'
      | 'wallpaperMode'
      | 'wallpaperPreset'
      | 'showStoreRecommendations'
      | 'hiddenStoreRecommendationCategories'
    >
  > & {
    workspace?: StoredWorkspacePreferences;
    appearance?: typeof desktopAppearanceSchema.infer;
  };

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
    (workspace.pinnedApps === undefined || validHomePins(workspace.pinnedApps))
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
    (candidate.wallpaperMode === undefined || ['theme', 'custom'].includes(String(candidate.wallpaperMode))) &&
    (candidate.wallpaperPreset === undefined ||
      candidate.wallpaperPreset === null ||
      ['frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'].includes(String(candidate.wallpaperPreset))) &&
    (candidate.workspace === undefined || isWorkspacePreferences(candidate.workspace)) &&
    (candidate.windows === undefined || desktopWindowsSchema.allows(candidate.windows)) &&
    (candidate.appLaunch === undefined || appLaunchSchema.allows(candidate.appLaunch)) &&
    (candidate.showStoreRecommendations === undefined || typeof candidate.showStoreRecommendations === 'boolean') &&
    (candidate.hiddenStoreRecommendationCategories === undefined ||
      validHiddenRecommendationCategories(candidate.hiddenStoreRecommendationCategories)) &&
    (candidate.appearance === undefined || desktopAppearanceSchema.allows(candidate.appearance))
  );
};

export const normalisePreferences = (value: StoredDesktopPreferences): DesktopPreferences => ({
  ...defaultDesktopPreferences,
  serverName: value.serverName,
  preset: value.preset,
  density: value.density,
  wallpaper: value.wallpaper ?? defaultDesktopPreferences.wallpaper,
  wallpaperMode: value.wallpaperMode ?? (value.wallpaperPreset || value.appearance?.wallpaperImage ? 'custom' : 'theme'),
  wallpaperPreset: value.wallpaperPreset ?? null,
  windows: value.windows ?? {},
  appLaunch: value.appLaunch ?? defaultAppLaunch,
  showStoreRecommendations: value.showStoreRecommendations ?? true,
  hiddenStoreRecommendationCategories: value.hiddenStoreRecommendationCategories ?? [],
  appearance: normaliseDesktopAppearance(value.appearance),
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
    const value: unknown = raw && raw.length <= preferenceCacheLimit ? JSON.parse(raw) : null;
    const cachedAppearance = appearanceFromStored(value);
    return {
      preferences: isPreferences(value)
        ? normalisePreferences(value)
        : { ...defaultDesktopPreferences, ...cachedAppearance, appearance: normaliseDesktopAppearance(cachedAppearance.appearance) },
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
  activeThemePack: { id: string; version: string; name: string } | null;
  cacheAvailable: boolean;
  update: (value: Partial<DesktopPreferences>) => void;
  updateAppearance: (value: Partial<DesktopAppearance>) => void;
  wallpaperRevision: number;
  refreshWallpaper: () => void;
  updateWindow: (id: DesktopWindowId, value: DesktopWindowState) => void;
  reset: () => void;
  syncState: 'local' | 'loading' | 'saving' | 'saved' | 'error';
  requiresOnboarding: boolean;
  completeOnboarding: (serverName: string, draft?: DesktopPreferences) => Promise<void>;
  setPreview: (value: DesktopPreferences | null) => void;
  setWorkspaceLoading: (loading: boolean) => void;
};
const Context = createContext<PreferenceContext | null>(null);
const LOAD_NOTICE = 'desktop-preferences-load';

export const DesktopPreferencesProvider = ({ children }: PropsWithChildren) => {
  const { isLoggedIn } = useUserContext();
  const { pathname } = useLocation();
  const themePack = useThemePack(isLoggedIn);
  const [cache] = useState(readPreferenceCache);
  const [preferences, setPreferences] = useState(cache.preferences);
  const [preview, setPreview] = useState<DesktopPreferences | null>(null);
  const displayed = preview ?? preferences;
  const displayedWallpaper = resolveWallpaperKey(displayed);
  const [wallpaperRevision, setWallpaperRevision] = useState(0);
  const resolvedMode = useResolvedColourMode(displayed.mode);
  const [cacheAvailable, setCacheAvailable] = useState(cache.available);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const booting = isLoggedIn && (!initialLoadComplete || workspaceLoading);
  useStartupReady(!booting && !(isLoggedIn && ['/login', '/register', '/reset-password'].includes(pathname)));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [requiresOnboarding, setRequiresOnboarding] = useState(true);
  const completingSetup = useRef(false);
  const [syncState, setSyncState] = useState<PreferenceContext['syncState']>('local');
  const appearancePainted = useRef(false);
  const remoteRefresh = useRef<(() => void) | null>(null);
  const revision = useRef(0);
  const acknowledgedRevision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useLayoutEffect(() => {
    const root = document.documentElement;
    const effectiveMode = displayed.mode === 'system' ? readSystemColourMode() : resolvedMode;
    const apply = () => {
      root.dataset.desktopPreset = displayed.preset;
      root.dataset.desktopMode = effectiveMode;
      root.dataset.desktopWallpaper = displayedWallpaper;
      root.dataset.desktopLocalWallpaper = String(displayed.wallpaperMode === 'custom' && Boolean(displayed.appearance.wallpaperImage));
      root.dataset.orbisAppearanceReady = 'true';
      applyThemePackRuntime(themePack, effectiveMode, displayed.wallpaperMode === 'theme');
      applyAppearanceRuntime(themePackAppearance(themePack, displayed.appearance), effectiveMode);
    };
    transitionAppearance(apply, appearancePainted.current);
    appearancePainted.current = true;
    const queries = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)'].flatMap((query) => {
      try {
        return [window.matchMedia(query)];
      } catch {
        return [];
      }
    });
    for (const query of queries) query.addEventListener('change', apply);
    return () => {
      for (const query of queries) query.removeEventListener('change', apply);
    };
  }, [displayed.appearance, displayed.preset, displayedWallpaper, displayed.mode, displayed.wallpaperMode, resolvedMode, themePack]);

  useEffect(() => {
    if (isLoggedIn && !initialLoadComplete) return;
    try {
      const stored = JSON.stringify(preferences);
      localStorage.setItem(STORAGE_KEY, stored);
      setCacheAvailable(localStorage.getItem(STORAGE_KEY) === stored);
      window.dispatchEvent(new Event(appearanceCacheEvent));
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
    if (!isLoggedIn || !serverReady) return;
    let disposed = false;
    let reading = false;
    let waiting = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed) return;
      if (reading || revision.current !== acknowledgedRevision.current) {
        waiting = true;
        return;
      }
      reading = true;
      waiting = false;
      const currentRevision = revision.current;
      try {
        const response = await fetch('/api/desktop-preferences', {
          credentials: 'include',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (!disposed && isPreferences(value) && revision.current === currentRevision && acknowledgedRevision.current === currentRevision) {
          const next = normalisePreferences(value);
          setPreferences((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
        }
      } catch {
        // The saved browser appearance remains available while the server reconnects.
      } finally {
        reading = false;
        if (waiting && revision.current === acknowledgedRevision.current) void refresh();
      }
    };
    const changed = () => void refresh();
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', focus);
    window.addEventListener(preferenceChangeEvent, changed);
    remoteRefresh.current = refresh;
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener('focus', focus);
      window.removeEventListener(preferenceChangeEvent, changed);
      if (remoteRefresh.current === refresh) remoteRefresh.current = null;
    };
  }, [isLoggedIn, serverReady]);

  useEffect(() => {
    if (isLoggedIn) return;
    const stored = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setPreferences(readCachedDesktopPreferences());
    };
    window.addEventListener('storage', stored);
    return () => window.removeEventListener('storage', stored);
  }, [isLoggedIn]);

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
            signal: AbortSignal.timeout(20_000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preferences),
          });
          if (!response.ok) throw new Error('Preference save failed');
          acknowledgedRevision.current = saveRevision;
          if (!superseded && revision.current === saveRevision) setSyncState('saved');
          remoteRefresh.current?.();
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

  const updateAppearance = (value: Partial<DesktopAppearance>) => {
    if (completingSetup.current || !desktopAppearanceSchema.allows(value)) return;
    revision.current += 1;
    setSyncState(isLoggedIn ? (serverReady ? 'saving' : syncState === 'loading' ? 'loading' : 'error') : 'local');
    setPreferences((previous) => ({ ...previous, appearance: { ...previous.appearance, ...value } }));
  };

  const updateWindow = (id: DesktopWindowId, value: DesktopWindowState) => {
    if (completingSetup.current) return;
    if (!desktopWindowsSchema.allows({ [id]: value })) return;
    revision.current += 1;
    setSyncState(isLoggedIn ? (serverReady ? 'saving' : syncState === 'loading' ? 'loading' : 'error') : 'local');
    setPreferences((previous) => ({ ...previous, windows: { ...previous.windows, [id]: value } }));
  };

  const completeOnboarding = async (serverName: string, draft = preferences) => {
    const next = { ...draft, serverName: serverName.trim() };
    if (!isLoggedIn || !serverReady || !isPreferences(next) || completingSetup.current) throw new Error('Setup cannot be saved yet. Try again.');
    completingSetup.current = true;
    const saveRevision = ++revision.current;
    setSyncState('saving');
    const save = async () => {
      const saved = await fetch('/api/desktop-preferences', {
        method: 'PUT',
        credentials: 'include',
        signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!saved.ok) throw new Error('Server settings could not be saved. Try again.');
      const completed = await fetch('/api/desktop-preferences/onboarding', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(20_000),
      });
      if (!completed.ok || (await completed.json()).complete !== true) throw new Error('Setup could not be completed. Try again.');
      acknowledgedRevision.current = saveRevision;
      setPreferences(next);
      setPreview(null);
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
      value={{
        preferences,
        resolvedMode,
        activeThemePack: themePack ? { id: themePack.id, version: themePack.version, name: themePack.name } : null,
        cacheAvailable,
        update,
        updateAppearance,
        wallpaperRevision,
        refreshWallpaper: () => setWallpaperRevision((value) => value + 1),
        updateWindow,
        reset,
        syncState,
        requiresOnboarding,
        completeOnboarding,
        setPreview,
        setWorkspaceLoading,
      }}
    >
      <MotionPreferences reduced={displayed.appearance.motion === 'reduced' || displayed.appearance.lowEffects}>
        {isLoggedIn && !initialLoadComplete ? null : children}
      </MotionPreferences>
    </Context.Provider>
  );
};

export const useDesktopPreferences = () => {
  const context = useContext(Context);
  if (!context) throw new Error('DesktopPreferencesProvider is missing');
  return context;
};

export function DesktopPreferencesPreview({
  value,
  onChange,
  children,
}: PropsWithChildren<{ value: DesktopPreferences; onChange: (value: DesktopPreferences) => void }>) {
  const parent = useDesktopPreferences();
  const resolvedMode = useResolvedColourMode(value.mode);
  useLayoutEffect(() => parent.setPreview(value), [parent.setPreview, value]);
  useLayoutEffect(() => () => parent.setPreview(null), [parent.setPreview]);
  return (
    <Context.Provider
      value={{
        ...parent,
        preferences: value,
        resolvedMode,
        update: (patch) => onChange({ ...value, ...patch }),
        updateAppearance: (patch) => onChange({ ...value, appearance: { ...value.appearance, ...patch } }),
      }}
    >
      {children}
    </Context.Provider>
  );
}
