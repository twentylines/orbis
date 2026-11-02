import { expect, mock } from 'bun:test';
import { act, useState } from 'react';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import type { TimeMachineSnapshot } from './contracts';
const visibilityListeners = new Set<() => void>();
// The null host exercises real mounted hooks and handlers, without browser layout.
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') visibilityListeners.add(listener);
  },
  removeEventListener(type: string, listener: () => void) {
    if (type === 'visibilitychange') visibilityListeners.delete(listener);
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
const storage = new Map<string, string>();
Object.assign(globalThis, {
  window: win,
  document: doc,
  HTMLElement: win.HTMLElement,
  matchMedia: win.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const { createRoot } = await import('react-dom/client');
const { WindowVisibilityContext } = await import('@/desktop/window-visibility');
const session = new AbortController();
const epoch = {};
mock.module('@/context/app-context', () => ({ useAppContext: () => ({ user: { id: 17, operator: true } }) }));
mock.module('@/context/user-context', () => ({ useUserContext: () => ({ sessionEpoch: epoch, sessionAbortSignal: session.signal }) }));
const api = await import('./time-machine-api');
const requests: { resolve: (value: TimeMachineSnapshot) => void; reject: (failure: Error) => void; signal: AbortSignal }[] = [];
let activeReads = 0;
let maximumReads = 0;
mock.module('./time-machine-api', () => ({
  ...api,
  readTimeMachine: (signal: AbortSignal) =>
    new Promise<TimeMachineSnapshot>((resolve, reject) => {
      activeReads++;
      maximumReads = Math.max(maximumReads, activeReads);
      let settled = false;
      const finish = (value?: TimeMachineSnapshot, failure?: Error) => {
        if (settled) return;
        settled = true;
        activeReads--;
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (value) resolve(value);
      };
      const abort = () => finish(undefined, new DOMException('Hidden', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      requests.push({ resolve: (value) => finish(value), reject: (failure) => finish(undefined, failure), signal });
      if (signal.aborted) abort();
    }),
}));
const { useTimeMachine } = await import('./use-time-machine');
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, { delay: number; callback: () => void }>();
let timerId = 0;
globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
  if (typeof delay === 'number' && delay >= 1000) {
    const id = ++timerId;
    timers.set(id, { delay, callback });
    return id;
  }
  return nativeSetTimeout(callback, delay, ...args);
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
  if (!timers.delete(Number(id))) nativeClearTimeout(id);
}) as typeof clearTimeout;
const snapshot = (revision: number): TimeMachineSnapshot => ({
  capabilities: {} as TimeMachineSnapshot['capabilities'],
  preferences: { ...defaultTimeMachinePreferences(), revision },
  list: { version: 1, available: true, points: [], activeCaptureId: null },
});
let visible = true;
let machine: ReturnType<typeof useTimeMachine> | null = null;
const currentMachine = () => {
  if (!machine) throw new Error('Polling fixture has not mounted');
  return machine;
};
let draft = '';
let setDraft: (value: string) => void = () => undefined;
function Probe() {
  machine = useTimeMachine();
  [draft, setDraft] = useState('');
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
const flush = (action: () => unknown) =>
  act(async () => {
    await action();
    await Bun.sleep(2);
  });
const render = () =>
  root.render(
    <WindowVisibilityContext.Provider value={visible}>
      <Probe />
    </WindowVisibilityContext.Provider>,
  );
const fire = () => {
  const [id, timer] = [...timers.entries()][0] ?? [];
  if (!id || !timer) throw new Error('Polling timer missing');
  timers.delete(id);
  timer.callback();
};
try {
  await flush(render);
  expect(requests).toHaveLength(1);
  expect(timers.size).toBe(0);
  let retryOne: Promise<boolean> | undefined;
  let retryTwo: Promise<boolean> | undefined;
  await flush(() => {
    retryOne = currentMachine().retry();
    retryTwo = currentMachine().retry();
  });
  expect(requests).toHaveLength(1);
  await flush(() => requests[0]?.resolve(snapshot(1)));
  expect(await retryOne).toBe(true);
  expect(await retryTwo).toBe(true);
  await flush(() => setDraft('unsaved capture label'));
  expect([...timers.values()][0]?.delay).toBe(30_000);
  await flush(fire);
  expect(requests).toHaveLength(2);
  let finishMutation: () => void = () => undefined;
  const mutation = new Promise<void>((resolve) => {
    finishMutation = resolve;
  });
  let mutationStarted = false;
  let performed: Promise<boolean> | undefined;
  await flush(() => {
    performed = currentMachine().perform(async () => {
      mutationStarted = true;
      await mutation;
    }, 'Saved');
  });
  expect(mutationStarted).toBe(false);
  await flush(() => requests[1]?.resolve(snapshot(2)));
  expect(mutationStarted).toBe(true);
  await flush(fire);
  expect(requests).toHaveLength(2);
  expect([...timers.values()][0]?.delay).toBe(1000);
  await flush(finishMutation);
  expect(requests).toHaveLength(3);
  await flush(() => requests[2]?.resolve(snapshot(3)));
  expect(await performed).toBe(true);
  await flush(fire);
  await flush(() => requests[3]?.reject(new Error('Temporary connection failure')));
  expect(currentMachine().error).toBe('Temporary connection failure');
  expect(currentMachine().snapshot?.preferences.revision).toBe(3);
  await flush(fire);
  await flush(() => requests[4]?.resolve(snapshot(4)));
  expect(currentMachine().error).toBe('');
  expect(currentMachine().snapshot?.preferences.revision).toBe(4);
  await flush(fire);
  expect(requests).toHaveLength(6);
  visible = false;
  await flush(render);
  expect(requests[5]?.signal.aborted).toBe(true);
  expect(timers.size).toBe(0);
  expect(await currentMachine().retry()).toBe(false);
  expect(draft).toBe('unsaved capture label');
  visible = true;
  await flush(render);
  expect(requests).toHaveLength(7);
  await flush(() => requests[6]?.resolve(snapshot(5)));
  await flush(fire);
  let unsafeActionStarted = false;
  let refused: Promise<boolean> | undefined;
  await flush(() => {
    refused = currentMachine().perform(async () => {
      unsafeActionStarted = true;
    }, 'Saved');
  });
  await flush(() => requests[7]?.reject(new Error('Current status unavailable')));
  expect(await refused).toBe(false);
  expect(unsafeActionStarted).toBe(false);
  await flush(fire);
  await flush(() => requests[8]?.resolve(snapshot(6)));
  doc.visibilityState = 'hidden';
  await flush(() => {
    for (const listener of visibilityListeners) listener();
  });
  expect(currentMachine().visible).toBe(false);
  expect(timers.size).toBe(0);
  doc.visibilityState = 'visible';
  await flush(() => {
    for (const listener of visibilityListeners) listener();
  });
  expect(requests).toHaveLength(10);
  await flush(() => root.unmount());
  expect(requests[9]?.signal.aborted).toBe(true);
  expect(activeReads).toBe(0);
  expect(maximumReads).toBe(1);
  expect(timers.size).toBe(0);
  process.stdout.write(
    JSON.stringify({
      mountedReact: true,
      maximumPollingReads: maximumReads,
      automaticErrorRecovery: true,
      hiddenAndUnmountedPause: true,
      draftPreserved: true,
      layout: false,
    }),
  );
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
}
