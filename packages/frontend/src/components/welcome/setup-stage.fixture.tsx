import { expect, mock } from 'bun:test';
import { act, type ReactNode } from 'react';
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
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
  defaultView: null as object | null,
};
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
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
Object.assign(globalThis, { window: win, document: doc, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let callback: ResizeObserverCallback = () => undefined;
let disconnected = false;
let layoutReads = 0;
let contentRenders = 0;
let stageRenders = 0;
let targetHeight = 0;
const target = {
  get offsetHeight() {
    layoutReads++;
    return 100;
  },
} as HTMLElement;
const stageRef = { current: {} as HTMLDivElement };
Object.assign(globalThis, {
  getComputedStyle: () => ({ paddingTop: '8', paddingBottom: '8' }),
  requestAnimationFrame: (frame: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, frame);
    return id;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class {
    constructor(next: ResizeObserverCallback) {
      callback = next;
    }
    observe() {
      return undefined;
    }
    disconnect() {
      disconnected = true;
    }
  },
});
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, animate }: { children: ReactNode; animate: { height?: number } }) => {
      stageRenders++;
      targetHeight = animate.height ?? 0;
      return children;
    },
  },
}));
const { createRoot } = await import('react-dom/client');
const { SetupStage } = await import('./setup-stage');
function Content() {
  contentRenders++;
  return null;
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
const root = createRoot(container as unknown as HTMLElement);
await act(async () => {
  root.render(
    <SetupStage stageRef={stageRef} stepElement={target} reduced={false}>
      <Content />
    </SetupStage>,
  );
});
expect(targetHeight).toBe(116);
expect(contentRenders).toBe(1);
const initialReads = layoutReads;
const initialRenders = stageRenders;
const resized = (height: number) =>
  callback([{ target, borderBoxSize: [{ blockSize: height }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
for (let height = 101; height <= 200; height++) resized(height);
expect(frames.size).toBe(1);
expect(layoutReads).toBe(initialReads);
await act(async () => {
  const queued = [...frames.values()];
  frames.clear();
  for (const frame of queued) frame(0);
});
expect(targetHeight).toBe(216);
expect(contentRenders).toBe(1);
expect(stageRenders).toBe(initialRenders + 1);
resized(300);
expect(frames.size).toBe(1);
await act(async () => {
  root.unmount();
});
expect(disconnected).toBe(true);
expect(frames.size).toBe(0);
process.stdout.write(
  JSON.stringify({
    resizeCallbacks: 100,
    batchedUpdates: 1,
    contentRenders,
    noResizeLayoutReads: layoutReads === initialReads,
    unmountCancelsFrame: true,
  }),
);
