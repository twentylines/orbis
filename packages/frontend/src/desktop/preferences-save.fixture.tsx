import { expect, mock } from 'bun:test';
import { PreferenceSession } from './preference-save-queue';
import { usePreferenceNameDraft } from './preference-name-draft';
import { act } from 'react';
const events = new EventTarget();
// React mounts its real provider/hooks; the null-output host does not model browser layout.
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  activeElement: null,
  documentElement: {
    dataset: {},
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
}));
const { createRoot } = await import('react-dom/client');
const { DesktopPreferencesProvider, useDesktopPreferences, defaultDesktopPreferences } = await import('./preferences');
let controls: ReturnType<typeof useDesktopPreferences>;
let nameDraft: ReturnType<typeof usePreferenceNameDraft>;
function Probe() {
  controls = useDesktopPreferences();
  nameDraft = usePreferenceNameDraft(controls.preferences.serverName);
  return null;
}
type RequestRecord = { url: string; method: string; body: string; signal: AbortSignal | null | undefined };
const requests: RequestRecord[] = [];
let server = structuredClone(defaultDesktopPreferences);
let intercept: ((r: RequestRecord) => Promise<Response> | undefined) | undefined;
Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''), signal: init?.signal };
    requests.push(r);
    const result = intercept?.(r);
    if (result) return result;
    if (r.url.endsWith('/onboarding')) return Response.json({ complete: true });
    if (r.method === 'PUT') server = JSON.parse(r.body);
    return Response.json(server);
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
const root = createRoot(container as unknown as HTMLElement);
const render = () =>
  root.render(
    <DesktopPreferencesProvider>
      <Probe />
    </DesktopPreferencesProvider>,
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
