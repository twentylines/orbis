import { expect, mock } from 'bun:test';
import { act, Children, isValidElement, type ReactNode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PreferenceSession } from '@/desktop/preference-save-queue';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import type { ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';
import { themeApplyHandoffKey } from './theme-apply-handoff';

// These fixtures mount real React hooks; frame callbacks and the display host are controlled, not browser compositor evidence.
const scenario = process.argv[2] ?? '';
const events = new EventTarget();
const attrs = new Map<string, string>();
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const doc = {
  nodeType: 9,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
  documentElement: {
    setAttribute: (key: string, value: string) => {
      attrs.set(key, value);
    },
    removeAttribute: (key: string) => {
      attrs.delete(key);
    },
  },
};
const local = new Map<string, string>();
const tab = new Map<string, string>();
let blocked = false;
const storage = (values: Map<string, string>, deny = false) => ({
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (deny && blocked) throw new Error('Denied');
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
});
let reloads = 0;
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  localStorage: storage(local, true),
  sessionStorage: storage(tab),
  location: {
    reload: () => {
      reloads++;
    },
  },
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};
doc.defaultView = win;
Object.assign(globalThis, {
  window: win,
  HTMLElement: win.HTMLElement,
  document: doc,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  },
  cancelAnimationFrame: (id: number) => {
    frames.delete(id);
  },
});
let session = new PreferenceSession(true);
mock.module('@/context/user-context', () => ({
  useUserContext: () => ({ sessionEpoch: session.epoch, sessionAbortSignal: session.signal, isLoggedIn: true }),
}));
mock.module('react-hot-toast', () => ({ default: { error: () => undefined, dismiss: () => undefined } }));
const { useThemeApply } = await import('./use-theme-apply');
const { useThemeApplyStartup } = await import('./use-theme-apply-startup');
const { ThemeApplyCover } = await import('./theme-apply-cover');
const pack = bundledThemePacks.find((item) => item.id === 'tideline' && item.version === '1.1.0');
if (!pack) throw new Error('Missing fixture pack');
const target = { id: pack.id, version: pack.version };
const before: ThemePackSnapshot = {
  catalogue: bundledThemePacks,
  state: {
    formatVersion: 1,
    selected: null,
    installed: [
      { manifest: pack, digest: 'a'.repeat(64), installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', previous: null },
    ],
  },
};
const after: ThemePackSnapshot = { ...before, state: { ...before.state, selected: target } };
let server = before;
const requests: string[] = [];
let hold: Promise<Response> | undefined;
Object.assign(globalThis, {
  fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push(method);
    if (hold && method === 'GET') return hold;
    if (method === 'PUT') server = after;
    return Response.json(server);
  },
});
let apply!: ReturnType<typeof useThemeApply>;
let startup!: ReturnType<typeof useThemeApplyStartup>;
function ApplyProbe() {
  apply = useThemeApply();
  return null;
}
function StartupProbe() {
  startup = useThemeApplyStartup();
  return null;
}
function nodes(value: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(value).flatMap((item) =>
    isValidElement<Record<string, unknown>>(item) ? [item, ...nodes(item.props.children as ReactNode)] : [],
  );
}
const clickApply = () => {
  const node = nodes(apply.confirmation).find((item) => item.props.children === 'Apply' && typeof item.props.onClick === 'function');
  if (!node) throw new Error('Missing Apply button');
  (node.props.onClick as () => void)();
};
const cover = () => {
  const node = nodes(apply.confirmation).find((item) => item.type === ThemeApplyCover);
  if (!node) throw new Error('Missing cover');
  return node.props as { onPaint: () => void; onRetry: () => void; onCancel: () => void; error?: string };
};
const stage = () => apply.stage({ kind: 'select', source: null, target, name: pack.name });
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  textContent: '',
  appendChild: () => undefined,
  removeChild: () => undefined,
};
const root = createRoot(container as unknown as HTMLElement);
const render = () => root.render(scenario.startsWith('startup') ? <StartupProbe /> : <ApplyProbe />);
const tick = () => {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
};
const scenarios: Record<string, () => Promise<void>> = {
  'current-noop': async () => {
    await act(async () => {
      apply.stage({ kind: 'select', source: target, target: { ...target }, name: pack.name });
    });
    expect(apply.busy).toBe(false);
    expect(requests).toHaveLength(0);
  },
  'confirmation-paint-reload': async () => {
    await act(async () => {
      stage();
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      clickApply();
      clickApply();
    });
    expect(requests).toHaveLength(0);
    expect(reloads).toBe(0);
    await act(async () => {
      cover().onPaint();
    });
    expect(requests).toEqual(['GET', 'PUT']);
    expect(reloads).toBe(1);
    expect(JSON.parse(tab.get(themeApplyHandoffKey) ?? '{}').selected).toEqual(target);
  },
  'session-abort': async () => {
    let release!: (response: Response) => void;
    hold = new Promise<Response>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      stage();
    });
    await act(async () => {
      clickApply();
    });
    await act(async () => {
      cover().onPaint();
    });
    expect(requests).toEqual(['GET']);
    await act(async () => {
      session.invalidate();
      session = new PreferenceSession(true);
      render();
      release(Response.json(after));
    });
    expect(requests).toEqual(['GET']);
    expect(reloads).toBe(0);
    expect(apply.busy).toBe(false);
    expect(tab.has(themeApplyHandoffKey)).toBe(false);
    hold = undefined;
    await act(async () => {
      stage();
    });
    await act(async () => {
      clickApply();
    });
    await act(async () => {
      cover().onPaint();
    });
    expect(reloads).toBe(1);
  },
  'storage-retry-duplicate': async () => {
    blocked = true;
    await act(async () => {
      stage();
    });
    await act(async () => {
      clickApply();
    });
    await act(async () => {
      cover().onPaint();
    });
    expect(cover().error).toContain('prepare the reload');
    expect(reloads).toBe(0);
    expect(requests).toEqual(['GET', 'PUT']);
    blocked = false;
    await act(async () => {
      cover().onRetry();
      cover().onRetry();
    });
    expect(requests).toEqual(['GET', 'PUT']);
    await act(async () => {
      cover().onPaint();
    });
    expect(requests).toEqual(['GET', 'PUT', 'GET']);
    expect(reloads).toBe(1);
  },
  'cancel-no-rollback': async () => {
    blocked = true;
    tab.set('unrelated', 'keep');
    await act(async () => {
      stage();
    });
    await act(async () => {
      clickApply();
    });
    await act(async () => {
      cover().onPaint();
    });
    await act(async () => {
      cover().onCancel();
    });
    expect(apply.busy).toBe(false);
    expect(requests).toEqual(['GET', 'PUT']);
    expect(server.state.selected).toEqual(target);
    expect(tab.get('unrelated')).toBe('keep');
    expect(reloads).toBe(0);
  },
  'startup-verified': async () => {
    expect(startup.pending).toBe(true);
    expect(attrs.get('data-orbis-theme-reload')).toBe('checking');
    await act(async () => {
      tick();
    });
    expect(startup.pending).toBe(true);
    await act(async () => {
      tick();
    });
    expect(startup.pending).toBe(false);
    expect(startup.active).toBe(true);
    expect(attrs.has('data-orbis-theme-reload')).toBe(false);
    await act(async () => {
      startup.complete();
    });
    expect(startup.active).toBe(false);
    expect(tab.has(themeApplyHandoffKey)).toBe(false);
  },
  'startup-recovery': async () => {
    expect(startup.pending).toBe(true);
    expect(startup.error).toBe(true);
    expect(attrs.has('data-orbis-theme-reload')).toBe(true);
    server = after;
    await act(async () => {
      startup.retry();
    });
    await act(async () => {
      tick();
      tick();
    });
    expect(startup.pending).toBe(false);
    expect(startup.error).toBe(false);
    await act(async () => {
      startup.cancel();
    });
    expect(tab.has(themeApplyHandoffKey)).toBe(false);
    expect(attrs.has('data-orbis-theme-reload')).toBe(false);
  },
};
if (!scenarios[scenario]) throw new Error('Unknown fixture scenario');
if (scenario.startsWith('startup')) {
  tab.set(themeApplyHandoffKey, JSON.stringify({ version: 1, savedAt: Date.now(), selected: target }));
  attrs.set('data-orbis-theme-reload', 'pending');
  if (scenario === 'startup-verified') server = after;
}
try {
  await act(async () => {
    render();
  });
  await scenarios[scenario]();
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, compositor: false, network: false }));
} finally {
  await act(async () => {
    root.unmount();
  });
}
