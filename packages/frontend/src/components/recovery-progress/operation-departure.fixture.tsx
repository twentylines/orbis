import { expect, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { armStartedOperation, operationBootFragment, operationContinuityStorageName } from './operation-continuity';
import type { OperationJob } from './operation-continuity';

const doc = {
  nodeType: 9,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
  documentElement: { dataset: {} },
};
let callbacks = new Map<number, () => Promise<void>>();
let nextTimer = 0;
const destinations: string[] = [];
const win = {
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  setTimeout(callback: () => Promise<void>, delay: number) {
    expect(delay).toBe(0);
    callbacks.set(++nextTimer, callback);
    return nextTimer;
  },
  clearTimeout(id: number) {
    callbacks.delete(id);
  },
  location: { assign: (destination: string) => destinations.push(destination) },
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });
mock.module('@/desktop/motion-preferences', () => ({ useReducedMotion: () => true }));
let authority: { state: string } | number = { state: 'idle' };
Object.assign(globalThis, {
  fetch: async () => (typeof authority === 'number' ? new Response(null, { status: authority }) : Response.json(authority)),
});
const { useOperationDeparture } = await import('./use-operation-departure');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const running: OperationJob = { id, operation: 'update', status: 'running', needsRecovery: false };
let current = running;
let reconnecting = true;
function Probe() {
  useOperationDeparture(current, reconnecting);
  return null;
}
const container = () => ({
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  textContent: '',
  appendChild: () => undefined,
  removeChild: () => undefined,
});
const blocked = () => {
  throw new Error('Storage blocked');
};
for (const terminal of ['succeeded', 'returned'] as const) {
  for (const mode of ['blocked', 'read-only', 'normal'] as const) {
    const values = new Map<string, string>();
    const writable = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    if (mode === 'read-only') armStartedOperation(id, 'update', writable);
    Object.assign(globalThis, {
      sessionStorage:
        mode === 'normal'
          ? writable
          : {
              getItem: mode === 'read-only' ? writable.getItem : blocked,
              setItem: blocked,
              removeItem: blocked,
            },
    });
    const root = createRoot(container() as unknown as HTMLElement);
    current = running;
    reconnecting = true;
    await act(async () => root.render(<Probe />));
    expect(destinations).toHaveLength(0);
    reconnecting = false;
    current = { ...running, id: other, status: terminal };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(0);
    for (const status of ['failed', 'interrupted', 'recovery-required', 'rolled-back']) {
      current = { ...running, status };
      await act(async () => root.render(<Probe />));
      expect(callbacks.size).toBe(0);
    }
    current = { ...running, status: terminal, needsRecovery: true };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(0);
    for (const unavailable of [{ state: 'recovery' }, { state: 'checking' }, 503, 401, 404]) {
      authority = unavailable;
      current = { ...running, status: terminal };
      await act(async () => root.render(<Probe />));
      expect(callbacks.size).toBe(0);
      expect(destinations).toHaveLength(0);
    }
    authority = { state: 'idle' };
    current = { ...running, status: terminal };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(1);
    authority = { state: 'recovery' };
    const rejected = [...callbacks.values()][0];
    callbacks.clear();
    if (!rejected) throw new Error('Final idle check was not scheduled');
    await act(async () => rejected());
    expect(destinations).toHaveLength(0);
    authority = { state: 'idle' };
    current = { ...running, status: terminal };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(1);
    current = { ...running, operation: 'downgrade', status: terminal };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(0);
    current = { ...running, status: terminal };
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(1);
    const callback = [...callbacks.values()][0];
    callbacks.clear();
    if (!callback) throw new Error('Automatic handoff was not scheduled');
    await act(async () => callback());
    expect(destinations).toEqual([mode === 'normal' ? '/' : `/${operationBootFragment}`]);
    await act(async () => root.render(<Probe />));
    expect(callbacks.size).toBe(0);
    if (mode === 'normal') expect(JSON.parse(writable.getItem(operationContinuityStorageName) ?? '{}').phase).toBe('reload');
    await act(async () => root.unmount());
    destinations.length = 0;
    callbacks = new Map();
  }
}
process.stdout.write('automatic handoff verified');
