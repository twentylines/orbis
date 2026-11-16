import { expect, test } from 'bun:test';
import { waitForWorkspaceReady } from './workspace-ready';

function harness() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
  const originalHeight = Object.getOwnPropertyDescriptor(globalThis, 'innerHeight');
  let changed = () => {};
  let releaseFonts = () => {};
  const state = { dataReady: false, childPending: false, images: [] as HTMLImageElement[], ready: 0, slow: 0 };
  const home = {
    getAttribute: () => String(state.dataReady),
    querySelector: () => (state.childPending ? {} : null),
    querySelectorAll: () => state.images,
  };
  const surface = Object.assign(new EventTarget(), {
    querySelector: (selector: string) => (selector === '.workspace' ? home : {}),
    ownerDocument: {
      fonts: {
        ready: new Promise<void>((resolve) => {
          releaseFonts = resolve;
        }),
      },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        changed = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  return {
    state,
    changed: () => changed(),
    releaseFonts: () => releaseFonts(),
    start: (timeout = 1000) =>
      waitForWorkspaceReady(
        surface as unknown as HTMLElement,
        () => state.ready++,
        () => state.slow++,
        timeout,
      ),
    restore: () => {
      for (const [name, descriptor] of [
        ['window', originalWindow],
        ['MutationObserver', originalObserver],
        ['innerHeight', originalHeight],
      ] as const)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    },
  };
}

test('Home stays covered until both its widgets and its fonts have settled', async () => {
  const h = harness();
  const stop = h.start();
  try {
    h.state.dataReady = true;
    h.state.childPending = true;
    h.changed();
    expect(h.state.ready).toBe(0);
    h.releaseFonts();
    await Bun.sleep(0);
    expect(h.state.ready).toBe(0);
    h.state.childPending = false;
    h.changed();
    expect(h.state.ready).toBe(1);
    h.changed();
    expect(h.state.ready).toBe(1);
  } finally {
    stop();
    h.restore();
  }
});

test('visible app images must finish decoding before Home is revealed', async () => {
  const h = harness();
  let releaseImage = () => {};
  h.state.images = [
    {
      loading: 'eager',
      complete: true,
      naturalWidth: 48,
      src: '/icon.png',
      getBoundingClientRect: () => ({ top: 100, bottom: 148 }),
      decode: () =>
        new Promise<void>((resolve) => {
          releaseImage = resolve;
        }),
    } as unknown as HTMLImageElement,
  ];
  const stop = h.start();
  try {
    h.state.dataReady = true;
    h.releaseFonts();
    await Bun.sleep(0);
    expect(h.state.ready).toBe(0);
    releaseImage();
    await Bun.sleep(0);
    expect(h.state.ready).toBe(1);
  } finally {
    stop();
    h.restore();
  }
});

test('a stalled Home reports a retry state instead of claiming readiness', async () => {
  const h = harness();
  const stop = h.start(10);
  try {
    h.releaseFonts();
    await Bun.sleep(25);
    expect(h.state).toMatchObject({ ready: 0, slow: 1 });
    h.state.dataReady = true;
    h.changed();
    expect(h.state.ready).toBe(0);
  } finally {
    stop();
    h.restore();
  }
});

test('cancelling a transition prevents a late font or data completion from revealing Home', async () => {
  const h = harness();
  const stop = h.start();
  try {
    stop();
    h.state.dataReady = true;
    h.releaseFonts();
    h.changed();
    await Bun.sleep(0);
    expect(h.state).toMatchObject({ ready: 0, slow: 0 });
  } finally {
    stop();
    h.restore();
  }
});
