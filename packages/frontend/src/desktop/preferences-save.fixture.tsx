import { desktopMaterialForMode } from './appearance-cache';
import { expect, mock } from 'bun:test';
import { PreferenceSession } from './preference-save-queue';
import { usePreferenceNameDraft } from './preference-name-draft';
import { act, useState } from 'react';
import { useWorkspaceSortable } from './workspace-sortable';
const events = new EventTarget();
const documentEvents = new EventTarget();
// React mounts its real provider/hooks; the null-output host does not model browser layout.
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener: documentEvents.addEventListener.bind(documentEvents),
  removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
  activeElement: null,
  documentElement: {
    dataset: {},
    removeAttribute() {
      return undefined;
    },
    style: {
      setProperty() {
        return undefined;
      },
      removeProperty() {
        return undefined;
      },
    },
  },
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
};
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  setTimeout,
  clearTimeout,
  matchMedia: () => ({
    matches: false,
    addEventListener() {
      return undefined;
    },
    removeEventListener() {
      return undefined;
    },
  }),
};
doc.defaultView = win;
Object.assign(globalThis, {
  window: win,
  document: doc,
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {
      return undefined;
    },
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
mock.module('@/modules/theme-packs/use-theme-pack', () => ({ useThemePack: () => null }));
mock.module('@/modules/theme-packs/theme-pack-runtime', () => ({
  applyThemePackRuntime() {
    return undefined;
  },
  applyThemePackAppearanceRuntime() {
    return undefined;
  },
  themePackAppearance: (_: unknown, v: unknown) => v,
}));
mock.module('@/desktop/appearance-runtime', () => ({
  applyAppearanceRuntime() {
    return undefined;
  },
}));
mock.module('@/desktop/theme-motion', () => ({ transitionAppearance: (fn: () => void) => fn() }));
mock.module('@/desktop/motion-preferences', () => ({ MotionPreferences: ({ children }: { children: React.ReactNode }) => children }));
mock.module('@/components/startup/startup-boundary', () => ({
  useStartupSession: () => ({ setFirstSetup: () => undefined, begin: () => undefined, finish: async () => undefined }),
  useStartupReady() {
    return undefined;
  },
}));
mock.module('react-hot-toast', () => ({
  default: {
    error() {
      return undefined;
    },
    dismiss() {
      return undefined;
    },
  },
}));
mock.module('react-router', () => ({ useLocation: () => ({ pathname: '/dashboard' }) }));
let session = new PreferenceSession(true);
let loggedIn = true;
mock.module('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: loggedIn, sessionEpoch: session.epoch, sessionAbortSignal: session.signal }),
  UserContextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
for (const [path, name] of [
  ['@/components/providers/i18n/i18n-provider', 'I18nProvider'],
  ['@/components/providers/theme/auto-theme-provider', 'AutoThemeProvider'],
  ['@/components/providers/theme/theme-provider', 'ThemeProvider'],
] as const)
  mock.module(path, () => ({ [name]: ({ children }: { children: React.ReactNode }) => children }));
mock.module('@/components/debug-panel/debug-panel', () => ({ DebugPanel: () => null }));
mock.module('@/components/error/error-page', () => ({ ErrorPage: () => null }));
const { createRoot } = await import('react-dom/client');
const { DesktopPreferencesProvider, useDesktopPreferences, defaultDesktopPreferences } = await import('./preferences');
const { useAppearanceSettingToggles } = await import('@/modules/settings/hooks/use-appearance-setting-toggles');
const refreshedModule = './preferences?generation=2';
const refreshedPreferences: typeof import('./preferences') | null = process.argv[2] === 'hmr-context-identity' ? await import(refreshedModule) : null;
const CompositionProvider =
  process.argv[2] === 'provider-composition' ? (await import('@/components/providers/providers')).Providers : DesktopPreferencesProvider;
let controls: ReturnType<typeof useDesktopPreferences>;
const clients = new Map<string, ReturnType<typeof useDesktopPreferences>>();
const client = (id: string) => {
  const current = clients.get(id);
  if (!current) throw new Error(`Client ${id} has not mounted`);
  return current;
};
let nameDraft: ReturnType<typeof usePreferenceNameDraft>;
let appearanceToggles: ReturnType<typeof useAppearanceSettingToggles>;
function AppearanceSearchProbe() {
  appearanceToggles = useAppearanceSettingToggles(['oled-dark-mode', 'energy-saving', 'surfaces'], true);
  return null;
}
let sortable: ReturnType<typeof useWorkspaceSortable<string>>;
const sortCommits: string[][] = [];
function SortableProbe() {
  const [items, setItems] = useState(['first', 'second', 'third']);
  sortable = useWorkspaceSortable(
    items,
    (next) => {
      sortCommits.push(next);
      setItems(next);
    },
    true,
  );
  return null;
}
function Probe({ id = 'main' }: { id?: string }) {
  controls = (refreshedPreferences?.useDesktopPreferences ?? useDesktopPreferences)();
  clients.set(id, controls);
  nameDraft = usePreferenceNameDraft(controls.preferences.serverName);
  if (process.argv[2] === 'appearance-search-autosave') return <AppearanceSearchProbe />;
  return process.argv[2]?.startsWith('workspace-sort-') ? <SortableProbe /> : null;
}
type RequestRecord = {
  url: string;
  method: string;
  body: string;
  signal: AbortSignal | null | undefined;
  generation: string | null;
  selection: string | null;
};
const requests: RequestRecord[] = [];
let server = structuredClone(defaultDesktopPreferences);
if (process.argv[2] === 'mode-material-autosave') {
  server.mode = 'light';
  Object.assign(server.appearance, {
    materialMode: 'custom',
    chromeOpacity: 10,
    chromeBlur: 7,
    glassBlur: 40,
    transparency: 'glass',
    themeColour: '#917965',
    textScale: 125,
    dockPins: ['media:fixture'],
  });
}
if (process.argv[2] === 'retired-wallpaper-readback') server.appearance.wallpaperUnsplash = 'legacy-photo';
if (process.argv[2]?.startsWith('logical-processors-')) delete server.showLogicalProcessors;
let onboardingComplete =
  !process.argv[2]?.startsWith('onboarding-capture-') && process.argv[2] !== 'provider-composition' && process.argv[2] !== 'two-clients-onboarding';
let generation: string | null = null;
let layoutCapability = ['workspace-capable-backend', 'workspace-capability-downgrade'].includes(process.argv[2] ?? '');
let intercept: ((r: RequestRecord) => Promise<Response> | undefined) | undefined;
function applyPreferencePut(r: RequestRecord) {
  const payload = JSON.parse(r.body);
  if (payload.appearance?.wallpaperUnsplash === null && r.selection !== (server.appearance.wallpaperUnsplash ?? 'none'))
    return new Response('', { status: 409 });
  if (payload.appearance && !Object.hasOwn(payload.appearance, 'wallpaperUnsplash'))
    payload.appearance.wallpaperUnsplash = server.appearance.wallpaperUnsplash ?? null;
  server = payload;
  return Response.json(server);
}
Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      signal: init?.signal,
      generation: new Headers(init?.headers).get('X-Orbis-Reset-Generation'),
      selection: new Headers(init?.headers).get('X-Orbis-Unsplash-Selection'),
    };
    requests.push(r);
    const result = intercept?.(r);
    if (result) return result;
    if (r.url.includes('/wallpaper/unsplash')) throw new Error('Retired wallpaper API was requested.');
    if (r.url.endsWith('/onboarding')) {
      if (r.method === 'POST' && generation && r.generation !== generation) return new Response('', { status: 409 });
      if (r.method === 'POST') onboardingComplete = true;
      return Response.json({ complete: onboardingComplete, ...(generation ? { generation } : {}) });
    }
    if (r.method === 'PUT') {
      if (generation && r.generation !== generation) return new Response('', { status: 409 });
      return applyPreferencePut(r);
    }
    return Response.json(server, {
      headers: {
        'X-Orbis-Reset-Generation': generation ?? 'none',
        ...(layoutCapability ? { 'X-Orbis-Preference-Capabilities': 'workspace-layout-v1 toolbar-order-v1' } : {}),
      },
    });
  },
});
const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const puts = () => requests.filter((r) => r.method === 'PUT');
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  textContent: '',
  appendChild() {
    return undefined;
  },
  removeChild() {
    return undefined;
  },
};
let root = createRoot(container as unknown as HTMLElement);
const render = () =>
  root.render(
    process.argv[2]?.startsWith('two-clients-') ? (
      <>
        <DesktopPreferencesProvider>
          <Probe id="first" />
        </DesktopPreferencesProvider>
        <DesktopPreferencesProvider>
          <Probe id="second" />
        </DesktopPreferencesProvider>
      </>
    ) : (
      <CompositionProvider>
        <Probe />
      </CompositionProvider>
    ),
  );
const switchSession = async () => {
  session.invalidate();
  session = new PreferenceSession(true);
  server = { ...structuredClone(defaultDesktopPreferences), serverName: 'Other account' };
  await act(async () => {
    render();
  });
};
const scenarios: Record<string, () => Promise<void>> = {
  'appearance-search-autosave': async () => {
    const oled = () => appearanceToggles['oled-dark-mode'];
    const energy = () => appearanceToggles['energy-saving'];
    expect(Object.keys(appearanceToggles)).toEqual(['oled-dark-mode', 'energy-saving']);
    expect(oled()).toMatchObject({ checked: false, disabled: false, saved: false });
    let result = deferred();
    intercept = (request) => (request.method === 'PUT' ? result.promise : undefined);
    await act(async () => {
      nameDraft.setName('Unsaved unrelated name');
      oled()?.setChecked(true);
    });
    expect(oled()).toMatchObject({ checked: true, pending: true, saved: false });
    expect(energy()).toMatchObject({ checked: false, pending: false, saved: false });
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(puts()).toHaveLength(1);
    server = JSON.parse(puts()[0]?.body ?? '');
    expect(server.serverName).toBe('Server');
    expect(server.appearance).toMatchObject({ oledDark: true, lowEffects: false, transparency: 'system', motion: 'system' });
    expect(nameDraft.name).toBe('Unsaved unrelated name');
    await act(async () => result.resolve(Response.json(server)));
    expect(oled()).toMatchObject({ pending: false, saved: true, error: null });

    result = deferred();
    await act(async () => energy()?.setChecked(true));
    expect(energy()).toMatchObject({ checked: true, pending: true, saved: false });
    expect(oled()).toMatchObject({ pending: false, saved: true, error: null });
    await act(async () => {
      await Bun.sleep(350);
    });
    await act(async () => result.resolve(new Response('', { status: 503 })));
    expect(energy()).toMatchObject({ pending: false, saved: false });
    expect(energy()?.error).toBe('This appearance change could not be saved. Try again.');
    expect(typeof energy()?.retry).toBe('function');
    expect(oled()).toMatchObject({ pending: false, saved: true, error: null });
    intercept = undefined;
    await act(async () => energy()?.retry?.());
    expect(energy()).toMatchObject({ pending: true, saved: false, error: null });
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(energy()).toMatchObject({ pending: false, saved: true, error: null });
    expect(server.appearance).toMatchObject({ oledDark: true, lowEffects: true });
    expect(server.serverName).toBe('Server');

    result = deferred();
    intercept = (request) => (request.method === 'PUT' ? result.promise : undefined);
    const previousAction = oled()?.setChecked;
    await act(async () => previousAction?.(false));
    await act(async () => {
      await Bun.sleep(350);
    });
    await switchSession();
    expect(puts().at(-1)?.signal?.aborted).toBe(true);
    await act(async () => {
      result.resolve(Response.json(defaultDesktopPreferences));
      previousAction?.(false);
    });
    expect(oled()).toMatchObject({ checked: false, pending: false, saved: false, error: null });
    expect(energy()).toMatchObject({ checked: false, pending: false, saved: false, error: null });
    expect(puts()).toHaveLength(4);

    intercept = undefined;
    await act(async () => {
      const chooseEnergy = energy()?.setChecked;
      chooseEnergy?.(true);
      chooseEnergy?.(false);
    });
    expect(energy()).toMatchObject({ checked: false, pending: true, saved: false });
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(energy()).toMatchObject({ checked: false, pending: false, saved: true });
    expect(server.appearance.lowEffects).toBe(false);

    session.invalidate();
    session = new PreferenceSession(false);
    loggedIn = false;
    await act(async () => render());
    expect(oled()).toMatchObject({ disabled: true, pending: false, saved: false });
    await act(async () => oled()?.setChecked(true));
    expect(puts()).toHaveLength(5);
  },
  'logical-processors-save': async () => {
    expect(controls.preferences.showLogicalProcessors).toBe(true);
    const result = deferred();
    intercept = (request) => {
      if (request.method !== 'PUT') return undefined;
      server = JSON.parse(request.body);
      return result.promise;
    };
    let save: Promise<void> | undefined;
    await act(async () => {
      save = controls.commit({ showLogicalProcessors: false });
    });
    expect(controls.syncState).toBe('saving');
    expect(JSON.parse(puts().at(-1)?.body ?? '{}').showLogicalProcessors).toBe(false);
    await act(async () => {
      result.resolve(Response.json(server));
      await save;
    });
    expect(controls.syncState).toBe('saved');
    expect(controls.preferences.showLogicalProcessors).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => render());
    expect(controls.preferences.showLogicalProcessors).toBe(false);
  },
  'logical-processors-old-backend': async () => {
    expect(controls.preferences.showLogicalProcessors).toBe(true);
    intercept = (request) => (request.method === 'PUT' ? Promise.resolve(Response.json(server)) : undefined);
    await act(async () => {
      await expect(controls.commit({ showLogicalProcessors: false })).rejects.toThrow('did not save');
    });
    expect(JSON.parse(puts().at(-1)?.body ?? '{}').showLogicalProcessors).toBe(false);
    expect(controls.syncState).toBe('error');
    expect(controls.preferences.showLogicalProcessors).toBe(true);
  },
  'workspace-sort-keyboard': async () => {
    const key = async (key: string) =>
      act(async () => {
        sortable.gripProps('first', 'First').onKeyDown({
          key,
          preventDefault() {
            return undefined;
          },
        } as never);
      });
    await key(' ');
    await key('ArrowDown');
    expect(sortable.order).toEqual(['second', 'first', 'third']);
    expect(sortCommits).toHaveLength(0);
    await key('Escape');
    expect(sortable.order).toEqual(['first', 'second', 'third']);
    expect(sortCommits).toHaveLength(0);
    await key(' ');
    await key('End');
    await key('Enter');
    expect(sortable.order).toEqual(['second', 'third', 'first']);
    expect(sortCommits).toEqual([['second', 'third', 'first']]);
  },
  'workspace-sort-pointer': async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    Object.assign(globalThis, {
      requestAnimationFrame: (fn: FrameRequestCallback) => {
        frames.set(++frameId, fn);
        return frameId;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    Object.assign(win, {
      innerHeight: 600,
      scrollBy() {
        return undefined;
      },
    });
    let captured = false;
    const capture = {
      setPointerCapture() {
        captured = true;
      },
      hasPointerCapture() {
        return captured;
      },
      releasePointerCapture() {
        captured = false;
      },
    };
    const nodes = new Map<string, HTMLElement>();
    for (const id of sortable.order) {
      const props = sortable.itemProps(id);
      const style: Record<string, unknown> = {
        removeProperty(key: string) {
          delete style[key];
        },
        setProperty(key: string, value: string) {
          style[key] = value;
        },
      };
      const node = {
        style,
        dataset: { sortableGroup: props['data-sortable-group'], sortableId: id },
        parentElement: capture,
        getBoundingClientRect: () => ({ left: 0, right: 200, top: sortable.order.indexOf(id) * 100, bottom: sortable.order.indexOf(id) * 100 + 90 }),
        closest() {
          return node;
        },
      } as unknown as HTMLElement;
      nodes.set(id, node);
      props.ref(node);
    }
    Object.assign(doc, { elementFromPoint: () => nodes.get('second') });
    const target = {
      setPointerCapture() {
        return undefined;
      },
    };
    await act(async () => {
      sortable.gripProps('first', 'First').onPointerDown({ button: 0, pointerId: 1, clientX: 50, clientY: 20, currentTarget: target } as never);
    });
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event('pointermove', { cancelable: true }), { pointerId: 1, clientX: 50, clientY: 120 }));
    });
    expect(captured).toBe(true);
    if (process.argv[2] === 'workspace-sort-fast-pointer') {
      expect(sortable.order).toEqual(['first', 'second', 'third']);
      expect(frames.size).toBe(1);
    } else {
      const frame = frames.values().next().value;
      if (!frame) throw new Error('Missing active drag frame');
      frames.clear();
      await act(async () => {
        frame(16);
      });
      expect(sortable.order).toEqual(['first', 'second', 'third']);
      expect(sortable.itemProps('second')['data-sortable-over']).toBe(true);
      for (let tick = 0; tick < 3; tick++) {
        const next = frames.values().next().value;
        if (!next) throw new Error('Missing steady drag frame');
        frames.clear();
        await act(async () => next(32 + tick * 16));
        expect(sortable.order).toEqual(['first', 'second', 'third']);
      }
      expect(captured).toBe(true);
    }
    expect(sortCommits).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1, clientX: 50, clientY: 120 }));
    });
    expect(sortCommits).toEqual([['second', 'first', 'third']]);
    expect(captured).toBe(false);
    expect(frames.size).toBe(0);
    expect(nodes.get('first')?.style.translate).toBeUndefined();
  },

  'workspace-sort-fast-pointer': async () => {
    await scenarios['workspace-sort-pointer']?.();
  },

  'workspace-capability-downgrade': async () => {
    expect(controls.workspaceCapabilities).toEqual({ toolbarOrder: true, workspaceLayout: true });
    layoutCapability = false;
    server = structuredClone(defaultDesktopPreferences);
    await act(async () => {
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    expect(controls.workspaceCapabilities).toEqual({ toolbarOrder: false, workspaceLayout: false });
    await act(async () => {
      await controls.commit({ serverName: 'Downgraded server' });
    });
    const payload = JSON.parse(puts().at(-1)?.body ?? '{}');
    expect(payload).not.toHaveProperty('toolbarOrder');
    expect(payload.workspace).not.toHaveProperty('layout');
  },
  'workspace-old-backend': async () => {
    expect(controls.workspaceCapabilities).toEqual({ toolbarOrder: false, workspaceLayout: false });
    await act(async () => {
      await controls.commit({ serverName: 'Old server compatible' });
    });
    const payload = JSON.parse(puts().at(-1)?.body ?? '{}');
    expect(payload).not.toHaveProperty('toolbarOrder');
    expect(payload.workspace).not.toHaveProperty('layout');
    expect(server.serverName).toBe('Old server compatible');
  },
  'workspace-capable-backend': async () => {
    expect(controls.workspaceCapabilities).toEqual({ toolbarOrder: true, workspaceLayout: true });
    const toolbarOrder = ['search', 'mode', 'tasks', 'battery', 'logout', 'connection'] as const;
    const workspace = {
      ...controls.preferences.workspace,
      layout: { version: 1 as const, appView: 'icons' as const, widgets: { activity: { columns: 3 as const, height: 480 } } },
    };
    await act(async () => {
      await controls.commit({ toolbarOrder: [...toolbarOrder], workspace });
    });
    expect(JSON.parse(puts().at(-1)?.body ?? '{}')).toMatchObject({ toolbarOrder: [...toolbarOrder], workspace });
    expect(controls.preferences.workspace.layout).toEqual(workspace.layout);
    await act(async () => {
      controls.update({ toolbarOrder: [...toolbarOrder].reverse() });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(JSON.parse(puts().at(-1)?.body ?? '{}').toolbarOrder).toEqual([...toolbarOrder].reverse());
  },

  'two-clients-onboarding': async () => {
    expect(client('first').requiresOnboarding).toBe(true);
    expect(client('second').requiresOnboarding).toBe(true);
    await act(async () => {
      await client('first').completeOnboarding('Shared server');
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    expect(client('first').requiresOnboarding).toBe(false);
    expect(client('second').requiresOnboarding).toBe(false);
    expect(client('second').preferences.serverName).toBe('Shared server');
  },
  'two-clients-reset': async () => {
    await act(async () => {
      client('first').update({ workspace: { ...client('first').preferences.workspace, pinnedApps: ['media:fixture'] } });
      client('second').updateAppearance({ dockPins: ['media:fixture'] });
    });
    generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    server = structuredClone(defaultDesktopPreferences);
    onboardingComplete = false;
    await act(async () => {
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    for (const client of clients.values()) {
      expect(client.preferences.workspace.pinnedApps).toEqual([]);
      expect(client.preferences.appearance.dockPins).toEqual([]);
      expect(client.requiresOnboarding).toBe(true);
      expect(client.onboardingGeneration).toBe(generation);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(puts()).toHaveLength(0);
    await act(async () => {
      await client('first').commit({ serverName: 'Fresh settings' });
    });
    expect(puts().at(-1)?.generation).toBe(generation);
  },
  'sleeping-client-reset': async () => {
    doc.visibilityState = 'hidden';
    generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    server = { ...structuredClone(defaultDesktopPreferences), serverName: 'After reset' };
    onboardingComplete = false;
    expect(controls.requiresOnboarding).toBe(false);
    await act(async () => {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    });
    expect(controls.requiresOnboarding).toBe(true);
    expect(controls.onboardingGeneration).toBe(generation);
    expect(controls.preferences.serverName).toBe('After reset');
    expect(puts()).toHaveLength(0);
  },
  'queued-reset': async () => {
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    let first!: Promise<unknown>;
    let queued!: Promise<unknown>;
    await act(async () => {
      first = controls.commit({ workspace: { ...controls.preferences.workspace, pinnedApps: ['media:fixture'] } }).catch((error) => error);
      queued = controls.commit({ serverName: 'Stale queued name' }).catch((error) => error);
    });
    expect(puts()).toHaveLength(1);
    generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    onboardingComplete = false;
    server = structuredClone(defaultDesktopPreferences);
    await act(async () => {
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    await act(async () => {
      pending.resolve(Response.json({}));
      expect(await first).toBeInstanceOf(Error);
      expect(await queued).toBeInstanceOf(Error);
    });
    expect(puts()).toHaveLength(1);
    expect(controls.preferences.workspace.pinnedApps).toEqual([]);
    expect(controls.preferences.serverName).toBe('Server');
    expect(controls.requiresOnboarding).toBe(true);
    expect(controls.syncState).toBe('saved');
  },
  'snapshot-crossing-reset': async () => {
    generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    onboardingComplete = false;
    intercept = (r) =>
      r.method === 'GET' && r.url === '/api/desktop-preferences'
        ? Promise.resolve(Response.json({ ...server, serverName: 'Stale response' }, { headers: { 'X-Orbis-Reset-Generation': 'none' } }))
        : undefined;
    await act(async () => {
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    expect(controls.preferences.serverName).toBe('Server');
    await act(async () => {
      await expect(controls.commit({ serverName: 'Stale write' })).rejects.toThrow();
    });
    expect(puts().at(-1)?.generation).toBe('none');
    intercept = undefined;
    await act(async () => {
      window.dispatchEvent(new Event('orbis-desktop-preferences-changed'));
    });
    expect(controls.onboardingGeneration).toBe(generation);
    expect(controls.preferences.serverName).toBe('Server');
  },
  'hmr-context-identity': async () => {
    if (refreshedPreferences?.useDesktopPreferences === useDesktopPreferences || !controls?.preferences)
      throw new Error('Refreshed consumer lost its existing provider');
  },
  'provider-composition': async () => {
    expect(controls.requiresOnboarding).toBe(true);
    await act(async () => {
      await controls.completeOnboarding('Composition server');
    });
    expect(controls.requiresOnboarding).toBe(false);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => {
      render();
    });
    expect(controls.requiresOnboarding).toBe(false);
    expect(controls.preferences.serverName).toBe('Composition server');
  },
  'onboarding-capture-completion': async () => {
    expect(controls.requiresOnboarding).toBe(true);
    const events: string[] = [];
    await act(async () => {
      await controls.completeOnboarding('Captured server', undefined, async () => {
        expect(puts().at(-1)?.body).toContain('Captured server');
        expect(requests.filter((request) => request.url.endsWith('/onboarding') && request.method === 'POST')).toHaveLength(0);
        events.push('capture accepted');
        onboardingComplete = true;
        return true;
      });
    });
    expect(events).toEqual(['capture accepted']);
    expect(requests.at(-1)).toMatchObject({ url: '/api/desktop-preferences/onboarding', method: 'GET' });
    expect(controls.requiresOnboarding).toBe(false);
    expect(controls.preferences.serverName).toBe('Captured server');
  },
  'onboarding-capture-failure': async () => {
    await act(async () => {
      await expect(
        controls.completeOnboarding('Waiting server', undefined, async () => {
          throw new Error('Capture did not start');
        }),
      ).rejects.toThrow('Capture did not start');
    });
    expect(controls.requiresOnboarding).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/onboarding') && request.method === 'POST')).toHaveLength(0);
  },
  'onboarding-capture-unconfirmed': async () => {
    await act(async () => {
      await expect(controls.completeOnboarding('Waiting server', undefined, async () => true)).rejects.toThrow('could not be completed');
    });
    expect(controls.requiresOnboarding).toBe(true);
    expect(requests.filter((request) => request.url.endsWith('/onboarding') && request.method === 'POST')).toHaveLength(0);
  },
  'onboarding-capture-optional-failure': async () => {
    expect(controls.requiresOnboarding).toBe(true);
    await act(async () => {
      await controls.completeOnboarding('Ready without capture', undefined, async () => false);
    });
    expect(controls.requiresOnboarding).toBe(false);
    expect(requests.at(-1)).toMatchObject({ url: '/api/desktop-preferences/onboarding', method: 'POST' });
    expect(controls.preferences.serverName).toBe('Ready without capture');
  },
  'colour-slider-autosave': async () => {
    for (const themeColour of ['#ae4866', '#ae4868', '#ae4869']) {
      await act(async () => controls.updateAppearance({ themeColour }));
      expect(controls.preferences.appearance.themeColour).toBe(themeColour);
      expect(puts()).toHaveLength(0);
    }
    await act(async () => controls.updateAppearance({ accent: '#345678' }));
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(puts()).toHaveLength(1);
    expect(JSON.parse(puts()[0]?.body ?? '{}')).toMatchObject({ appearance: { themeColour: '#ae4869', accent: '#345678' } });
    expect(controls.syncState).toBe('saved');
  },
  'mode-material-autosave': async () => {
    const material = () => desktopMaterialForMode(controls.preferences.appearance, controls.resolvedMode);
    expect(controls.resolvedMode).toBe('light');
    expect(material()).toMatchObject({ chromeOpacity: null, chromeBlur: null, glassBlur: null, materialMode: 'default' });
    await act(async () => controls.update({ mode: 'dark' }));
    expect(material()).toMatchObject({ chromeOpacity: 10, chromeBlur: 7, glassBlur: 40 });
    await act(async () => {
      controls.updateAppearance({ darkMaterial: { chromeOpacity: 0 } });
      controls.updateAppearance({ darkMaterial: { chromeBlur: 0 } });
      controls.update({ mode: 'light' });
      controls.updateAppearance({ lightMaterial: { materialMode: 'custom', chromeOpacity: 82, chromeBlur: 18 } });
      controls.updateAppearance({ lightMaterial: { glassBlur: 12 }, themeColour: '#ae4869', accent: '#345678' });
    });
    expect(material()).toMatchObject({ chromeOpacity: 82, chromeBlur: 18, glassBlur: 12 });
    await act(async () => controls.update({ mode: 'dark' }));
    expect(material()).toMatchObject({ chromeOpacity: 0, chromeBlur: 0, glassBlur: 40 });
    expect(puts()).toHaveLength(0);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(puts()).toHaveLength(1);
    expect(JSON.parse(puts()[0]?.body ?? '{}')).toMatchObject({
      mode: 'dark',
      appearance: {
        chromeOpacity: 10,
        chromeBlur: 7,
        textScale: 125,
        dockPins: ['media:fixture'],
        themeColour: '#ae4869',
        accent: '#345678',
        darkMaterial: { chromeOpacity: 0, chromeBlur: 0, glassBlur: 40 },
        lightMaterial: { chromeOpacity: 82, chromeBlur: 18, glassBlur: 12 },
      },
    });
    expect(controls.syncState).toBe('saved');
    await act(async () => controls.update({ mode: 'light' }));
    expect(material()).toMatchObject({ chromeOpacity: 82, chromeBlur: 18, glassBlur: 12 });
  },
  'batched-edit-commit': async () => {
    await act(async () => {
      controls.updateAppearance({ textScale: 125 });
      controls.update({ density: 'compact' });
      await controls.commit({ serverName: 'Saved name' });
    });
    expect(JSON.parse(puts()[0]?.body ?? '{}')).toMatchObject({ density: 'compact', appearance: { textScale: 125 }, serverName: 'Saved name' });
    expect(controls.preferences.appearance.textScale).toBe(125);
    expect(controls.syncState).toBe('saved');
  },
  'retired-wallpaper-readback': async () => {
    expect(controls.preferences.appearance.wallpaperUnsplash).toBe('legacy-photo');
    await act(async () => {
      await controls.commitWallpaperChoice({ wallpaperMode: 'custom', wallpaperPreset: 'stone' });
    });
    const request = puts().at(-1);
    expect(request?.selection).toBeNull();
    const payload = JSON.parse(request?.body ?? '{}');
    expect(payload).toMatchObject({ wallpaperMode: 'custom', wallpaperPreset: 'stone' });
    expect(payload.appearance).not.toHaveProperty('wallpaperUnsplash');
    expect(server.appearance.wallpaperUnsplash).toBe('legacy-photo');
    expect(controls.preferences.appearance.wallpaperUnsplash).toBe('legacy-photo');
    expect(requests.some((entry) => entry.url.includes('/wallpaper/unsplash'))).toBe(false);
  },
  'newer-edit-during-save': async () => {
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    let saved!: Promise<void>;
    await act(async () => {
      saved = controls.commit({ preset: 'forest' });
    });
    await act(async () => {
      controls.update({ preset: 'ocean' });
      controls.update({ preset: 'frost' });
    });
    await act(async () => {
      pending.resolve(Response.json({}));
      await saved;
    });
    expect(controls.preferences.preset).toBe('frost');
    expect(controls.syncState).toBe('saving');
    intercept = undefined;
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(JSON.parse(puts().at(-1)?.body ?? '{}').preset).toBe('frost');
  },
  'queued-account-switch': async () => {
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = controls.commit({ serverName: 'First account' }).catch((e) => e);
      second = controls.commit({ density: 'compact' }).catch((e) => e);
    });
    const oldRequest = puts()[0];
    await switchSession();
    expect(oldRequest?.signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(Response.json({}));
      await Promise.all([first, second]);
    });
    expect(puts()).toHaveLength(1);
    expect(controls.preferences.serverName).toBe('Other account');
    expect(controls.preferences.density).toBe('comfortable');
    expect(controls.syncState).toBe('saved');
  },
  'autosave-account-switch': async () => {
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    await act(async () => {
      controls.updateAppearance({ textScale: 125 });
    });
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(puts()).toHaveLength(1);
    await switchSession();
    expect(puts()[0]?.signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(Response.json({}));
    });
    expect(controls.preferences.appearance.textScale).toBe(100);
    expect(controls.preferences.serverName).toBe('Other account');
    expect(controls.syncState).toBe('saved');
  },
  'onboarding-account-switch': async () => {
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    let saved!: Promise<unknown>;
    await act(async () => {
      saved = controls.completeOnboarding('Old setup').catch((e) => e);
    });
    await switchSession();
    await act(async () => {
      pending.resolve(Response.json({}));
      await saved;
    });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(controls.preferences.serverName).toBe('Other account');
  },
  'dirty-name-remote-refresh': async () => {
    await act(async () => {
      nameDraft.setName('Unsaved draft');
    });
    server = { ...server, serverName: 'Remote name' };
    await act(async () => {
      events.dispatchEvent(new Event('focus'));
    });
    expect(controls.preferences.serverName).toBe('Remote name');
    expect(nameDraft.name).toBe('Unsaved draft');
    await act(async () => {
      nameDraft.setName('Remote name');
    });
    server = { ...server, serverName: 'Next name' };
    await act(async () => {
      events.dispatchEvent(new Event('focus'));
    });
    expect(nameDraft.name).toBe('Next name');
  },
  'name-acknowledgement': async () => {
    await act(async () => {
      nameDraft.setName('  Saved name  ');
    });
    await act(async () => {
      await controls.commit({ serverName: 'Saved name' });
      nameDraft.acknowledge('  Saved name  ', 'Saved name');
    });
    expect(nameDraft.name).toBe('Saved name');
    const pending = deferred();
    intercept = (r) => (r.method === 'PUT' ? pending.promise : undefined);
    let saved!: Promise<void>;
    await act(async () => {
      nameDraft.setName('Submitted name');
      saved = controls.commit({ serverName: 'Submitted name' });
    });
    await act(async () => {
      nameDraft.setName('Newer draft');
    });
    await act(async () => {
      pending.resolve(Response.json({}));
      await saved;
      nameDraft.acknowledge('Submitted name', 'Submitted name');
    });
    expect(nameDraft.name).toBe('Newer draft');
  },
  'load-failure-recovery': async () => {
    intercept = (r) => (r.method === 'GET' ? Promise.resolve(new Response('', { status: 503 })) : undefined);
    session.invalidate();
    session = new PreferenceSession(true);
    await act(async () => {
      render();
    });
    expect(controls.syncState).toBe('error');
    expect(controls.preferences.serverName).toBe('Server');
    expect(puts()).toHaveLength(0);
  },
};
const scenario = process.argv[2] ?? '';
if (!scenarios[scenario]) throw new Error('Unknown scenario');
try {
  await act(async () => {
    render();
  });
  await scenarios[scenario]();
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  await act(async () => {
    root.unmount();
  });
}
