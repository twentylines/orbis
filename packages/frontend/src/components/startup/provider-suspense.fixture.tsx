import { expect, mock } from 'bun:test';
import { act, Component, Suspense, useLayoutEffect, type ReactNode } from 'react';
const doc = {
  nodeType: 9,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: null as object | null,
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
};
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  document: doc,
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  dispatchEvent() {
    return undefined;
  },
  setTimeout,
  clearTimeout,
  matchMedia: () => ({
    matches: true,
    addEventListener() {
      return undefined;
    },
    removeEventListener() {
      return undefined;
    },
  }),
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
let covers = 0;
mock.module('./startup-surface', () => ({
  StartupSurface: () => {
    useLayoutEffect(() => {
      covers++;
      return () => {
        covers--;
      };
    }, []);
    return null;
  },
}));
const operationStartup = await import('./operation-startup');
mock.module('./operation-startup', () => ({
  ...operationStartup,
  useOperationStartup: () => ({
    operation: null,
    complete() {
      return undefined;
    },
  }),
}));
mock.module('@/modules/theme-packs/use-theme-apply-startup', () => ({
  useThemeApplyStartup: () => ({
    pending: false,
    active: false,
    complete() {
      return undefined;
    },
  }),
}));
mock.module('@/modules/theme-packs/theme-apply-cover', () => ({ ThemeApplyCover: () => null }));
mock.module('@/desktop/motion-setting', () => ({ prefersReducedMotion: () => true }));
mock.module('@/components/providers/i18n/i18n-provider', () => ({ I18nProvider: ({ children }: { children: unknown }) => children }));
const { createRoot } = await import('react-dom/client');
const { StartupBoundary, useStartupReady } = await import('./startup-boundary');
const { ProviderLoadingBridge } = await import('@/components/providers/providers');
let suspended = true;
let resolve: () => void = () => undefined;
let waiting = new Promise<void>((done) => {
  resolve = done;
});
let failed = false;
function Content() {
  if (suspended) throw waiting;
  if (failed) throw new Error('fixture failure');
  useStartupReady(true);
  return null;
}
function Failure() {
  useStartupReady(true);
  return null;
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <Failure /> : this.props.children;
  }
}
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
const caught: unknown[] = [];
const root = createRoot(container as unknown as HTMLElement, {
  onCaughtError: (error) => {
    caught.push(error);
  },
});
let boundaryKey = 0;
const render = () =>
  root.render(
    <StartupBoundary>
      <Boundary key={boundaryKey}>
        <Suspense fallback={<ProviderLoadingBridge />}>
          <Content />
        </Suspense>
      </Boundary>
    </StartupBoundary>,
  );
const flush = (action: () => void) =>
  act(async () => {
    action();
    await Bun.sleep(20);
  });
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush(() => undefined);
};
await flush(render);
expect(covers).toBe(1);
suspended = false;
await flush(resolve);
await settle();
expect(covers).toBe(0);
suspended = true;
waiting = new Promise<void>((done) => {
  resolve = done;
});
await flush(render);
expect(covers).toBe(1);
suspended = false;
await flush(resolve);
await settle();
expect(covers).toBe(0);
failed = true;
await flush(render);
await settle();
expect(covers).toBe(0);
expect(caught).toHaveLength(1);
expect(caught[0]).toBeInstanceOf(Error);
expect((caught[0] as Error).message).toBe('fixture failure');
failed = false;
boundaryKey++;
await flush(render);
await settle();
expect(covers).toBe(0);
expect(caught).toHaveLength(1);
await flush(() => root.unmount());
expect(covers).toBe(0);
process.stdout.write('ready recovered');
