import { expect, mock } from 'bun:test';
import { PreferenceSession } from './preference-save-queue';
import { usePreferenceNameDraft } from './preference-name-draft';
import { act } from 'react';
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
mock.module('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true, sessionEpoch: session.epoch, sessionAbortSignal: session.signal }),
  UserContextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
for (const [path, name] of [
  ['@/components/providers/i18n/i18n-provider', 'I18nProvider'],
  ['@/components/providers/sentry/sentry-provider', 'SentryProvider'],
  ['@/components/providers/theme/auto-theme-provider', 'AutoThemeProvider'],
  ['@/components/providers/theme/theme-provider', 'ThemeProvider'],
] as const)
  mock.module(path, () => ({ [name]: ({ children }: { children: React.ReactNode }) => children }));
mock.module('@/components/debug-panel/debug-panel', () => ({ DebugPanel: () => null }));
mock.module('@/components/error/error-page', () => ({ ErrorPage: () => null }));
const { createRoot } = await import('react-dom/client');
const { DesktopPreferencesProvider, useDesktopPreferences, defaultDesktopPreferences } = await import('./preferences');
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
function Probe({ id = 'main' }: { id?: string }) {
  controls = (refreshedPreferences?.useDesktopPreferences ?? useDesktopPreferences)();
  clients.set(id, controls);
  nameDraft = usePreferenceNameDraft(controls.preferences.serverName);
  return null;
}
type RequestRecord = { url: string; method: string; body: string; signal: AbortSignal | null | undefined; generation: string | null };
const requests: RequestRecord[] = [];
let server = structuredClone(defaultDesktopPreferences);
let onboardingComplete =
  !process.argv[2]?.startsWith('onboarding-capture-') && process.argv[2] !== 'provider-composition' && process.argv[2] !== 'two-clients-onboarding';
let generation: string | null = null;
let intercept: ((r: RequestRecord) => Promise<Response> | undefined) | undefined;
Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      signal: init?.signal,
      generation: new Headers(init?.headers).get('X-Orbis-Reset-Generation'),
    };
    requests.push(r);
    const result = intercept?.(r);
    if (result) return result;
    if (r.url.endsWith('/onboarding')) {
      if (r.method === 'POST' && generation && r.generation !== generation) return new Response('', { status: 409 });
      if (r.method === 'POST') onboardingComplete = true;
      return Response.json({ complete: onboardingComplete, ...(generation ? { generation } : {}) });
    }
    if (r.method === 'PUT') {
      if (generation && r.generation !== generation) return new Response('', { status: 409 });
      server = JSON.parse(r.body);
    }
    return Response.json(server, { headers: { 'X-Orbis-Reset-Generation': generation ?? 'none' } });
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
