import { expect, mock } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { themeApplyHandoffKey } from './theme-apply-handoff';

const scenario = process.argv[2] ?? '';
const events = new EventTarget();
const attrs = new Map<string, string>();
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
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
const win = {
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  localStorage: storage,
  setTimeout,
  clearTimeout,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};
doc.defaultView = win;
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
Object.assign(globalThis, {
  window: win,
  document: doc,
  localStorage: storage,
  sessionStorage: storage,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  },
  cancelAnimationFrame: (id: number) => {
    frames.delete(id);
  },
});
type Surface = { signingIn?: boolean; loggingOff?: boolean; status?: { title: string } };
type Cover = { error?: string; onCancel: () => void };
let surface: Surface | null = null;
let cover: Cover | null = null;
mock.module('@/desktop/motion-setting', () => ({ prefersReducedMotion: () => true }));
mock.module('@/components/startup/startup-surface', () => ({
  StartupSurface: (props: Surface) => {
    useLayoutEffect(() => {
      surface = props;
      return () => {
        surface = null;
      };
    }, [props]);
    return null;
  },
}));
mock.module('./theme-apply-cover', () => ({
  ThemeApplyCover: (props: Cover) => {
    useLayoutEffect(() => {
      cover = props;
      return () => {
        cover = null;
      };
    }, [props]);
    return null;
  },
}));
const { StartupBoundary, useStartupReady, useStartupSession } = await import('@/components/startup/startup-boundary');
const pack = bundledThemePacks.find((item) => item.id === 'tideline' && item.version === '1.1.0');
if (!pack) throw new Error('Missing pack');
let requests = 0;
Object.assign(globalThis, {
  fetch: async () => {
    requests++;
    return scenario === 'startup-error'
      ? new Response('', { status: 503 })
      : Response.json({
          catalogue: bundledThemePacks,
          state: {
            formatVersion: 1,
            selected: { id: pack.id, version: pack.version },
            installed: [
              {
                manifest: pack,
                digest: 'a'.repeat(64),
                installedAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                previous: null,
              },
            ],
          },
        });
  },
});
let session!: ReturnType<typeof useStartupSession>;
function Probe() {
  useStartupReady(true);
  session = useStartupSession();
  return null;
}
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
const currentSurface = (): Surface | null => surface;
const currentCover = (): Cover | null => cover;
const settle = async () => {
  for (let index = 0; index < 4; index++)
    await act(async () => {
      await Bun.sleep(5);
    });
};
const tick = () => {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
};
if (scenario !== 'startup-sessions') {
  values.set(themeApplyHandoffKey, JSON.stringify({ version: 1, savedAt: Date.now(), selected: { id: pack.id, version: pack.version } }));
  attrs.set('data-orbis-theme-reload', 'pending');
}
try {
  await act(async () => {
    root.render(
      <StartupBoundary>
        <Probe />
      </StartupBoundary>,
    );
  });
  if (scenario === 'startup-sessions') {
    await settle();
    expect(surface).toBeNull();
    expect(cover).toBeNull();
    expect(requests).toBe(0);
    for (const transition of ['signing-in', 'logging-out'] as const) {
      await act(async () => {
        session.begin(transition);
      });
      expect(transition === 'signing-in' ? currentSurface()?.signingIn : currentSurface()?.loggingOff).toBe(true);
      let done = false;
      await act(async () => {
        void session.finish().then(() => {
          done = true;
        });
      });
      await settle();
      expect(done).toBe(true);
      expect(surface).toBeNull();
      expect(cover).toBeNull();
    }
  } else if (scenario === 'startup-gated') {
    await settle();
    expect(cover).not.toBeNull();
    expect(surface).not.toBeNull();
    expect(attrs.has('data-orbis-theme-reload')).toBe(true);
    await act(async () => {
      tick();
    });
    expect(cover).not.toBeNull();
    await act(async () => {
      tick();
    });
    expect(cover).toBeNull();
    expect(currentSurface()?.status?.title).toBe('Loading theme…');
    expect(attrs.has('data-orbis-theme-reload')).toBe(false);
    await settle();
    expect(surface).toBeNull();
    expect(values.has(themeApplyHandoffKey)).toBe(false);
  } else if (scenario === 'startup-error') {
    await settle();
    expect(currentCover()?.error).toContain('could not be confirmed');
    expect(surface).not.toBeNull();
    await act(async () => {
      currentCover()?.onCancel();
    });
    await settle();
    expect(cover).toBeNull();
    expect(surface).toBeNull();
    expect(attrs.has('data-orbis-theme-reload')).toBe(false);
  } else throw new Error('Unknown scenario');
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, compositor: false, network: false }));
} finally {
  await act(async () => {
    root.unmount();
  });
}
