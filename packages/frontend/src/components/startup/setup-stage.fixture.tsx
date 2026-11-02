import { expect, mock } from 'bun:test';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

const events = new EventTarget();
const doc = {
  nodeType: 9,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
  documentElement: { dataset: {} },
};
const win = {
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  setTimeout,
  clearTimeout,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });
let mounts = 0;
let unmounts = 0;
let current: { setupSpace?: boolean; label?: string; setupHandoff?: boolean; completing?: boolean } | null = null;
const handoffs: Array<{ setupSpace?: boolean; setupHandoff?: boolean; completing?: boolean }> = [];
mock.module('@/desktop/motion-setting', () => ({ prefersReducedMotion: () => true }));
mock.module('@/modules/theme-packs/use-theme-apply-startup', () => ({
  useThemeApplyStartup: () => ({ active: false, pending: false, complete: () => undefined }),
}));
mock.module('./operation-startup', () => ({ useOperationStartup: () => ({ operation: null, complete: () => undefined }) }));
mock.module('./startup-surface', () => ({
  StartupSurface: (props: { setupSpace?: boolean; label?: string; setupHandoff?: boolean; completing?: boolean }) => {
    useLayoutEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    useLayoutEffect(() => {
      current = props;
      if (props.setupHandoff) handoffs.push(props);
      return () => {
        current = null;
      };
    }, [props]);
    return null;
  },
}));
const { StartupBoundary, useStartupReady, useStartupSession } = await import('./startup-boundary');
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
const flush = async (action: () => void) =>
  act(async () => {
    action();
    await Bun.sleep(5);
  });
try {
  await flush(() =>
    root.render(
      <StartupBoundary>
        <Probe />
      </StartupBoundary>,
    ),
  );
  for (let i = 0; i < 5; i++) await flush(() => undefined);
  const before = mounts;
  await flush(() => session.begin('preparing-orbis', true, 'Saving preferences'));
  expect(current).toMatchObject({ setupSpace: true, label: 'Saving preferences' });
  expect(mounts).toBe(before + 1);
  const openedUnmounts = unmounts;
  for (const label of ['Starting Time Machine capture', 'Preparing Orbis']) {
    await flush(() => session.setSetupStage(label));
    expect(current).toMatchObject({ setupSpace: true, label });
    expect(mounts).toBe(before + 1);
    expect(unmounts).toBe(openedUnmounts);
  }
  let finished = false;
  await flush(() => {
    void session.finish().then(() => {
      finished = true;
    });
  });
  for (let i = 0; i < 5; i++) await flush(() => undefined);
  expect(finished).toBe(true);
  expect(handoffs.length).toBeGreaterThan(0);
  expect(handoffs.every((item) => item.setupSpace === false && item.completing === false)).toBe(true);
  expect(mounts).toBe(before + 1);
  expect(current).toBeNull();
  process.stdout.write(JSON.stringify({ singleMountedCover: true, spaceThroughout: true, compositor: false }));
} finally {
  await flush(() => root.unmount());
}
