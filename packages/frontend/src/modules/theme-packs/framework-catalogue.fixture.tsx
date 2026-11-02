import { expect, mock } from 'bun:test';
import { act } from 'react';
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
};
const timers = new Map<number, () => void>();
let timerId = 0;
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  setInterval(callback: () => void) {
    timers.set(++timerId, callback);
    return timerId;
  },
  clearInterval(id: number) {
    timers.delete(id);
  },
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const requests: { signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
mock.module('./framework-catalogue', () => ({
  readFrameworkCatalogue: (signal: AbortSignal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
}));
const { useFrameworkCatalogue } = await import('./use-framework-catalogue');
let active = true;
let state: ReturnType<typeof useFrameworkCatalogue> | undefined;
function Probe() {
  state = useFrameworkCatalogue(active);
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
const flush = (fn: () => unknown) =>
  act(async () => {
    await fn();
    await Bun.sleep(1);
  });
const render = () => root.render(<Probe />);
const empty = { schema: 'orbis.theme-framework-catalogue.v1' as const, themes: [] };
await flush(render);
expect(requests).toHaveLength(1);
await flush(() => requests[0]?.resolve({ status: 'ready', catalogue: empty, checkedAt: null, runtimeAvailable: false }));
expect(state?.data?.catalogue).toEqual(empty);
await flush(() => {
  [...timers.values()][0]?.();
});
expect(requests).toHaveLength(2);
await flush(() => requests[1]?.reject(new Error('offline')));
expect(state?.error).toBe('Theme catalogue could not be loaded.');
expect(state?.data?.catalogue).toEqual(empty);
await flush(() => {
  [...timers.values()][0]?.();
});
await flush(() => requests[2]?.resolve({ status: 'unavailable', catalogue: null, checkedAt: null, runtimeAvailable: false }));
expect(state?.data?.status).toBe('stale');
active = false;
await flush(render);
expect(timers.size).toBe(0);
active = true;
await flush(render);
expect(requests).toHaveLength(4);
await flush(() => root.unmount());
expect(requests[3]?.signal.aborted).toBe(true);
expect(timers.size).toBe(0);
process.stdout.write('mounted polling passed');
