import { describe, expect, test } from 'bun:test';
import { observeNavigationPreload } from './navigation-preload';

function fixture(idleSupported = true) {
  const names = ['window', 'document', 'navigator'];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const events = () => {
    const callbacks = new Map<string, Set<() => void>>();
    return {
      addEventListener(name: string, callback: () => void) {
        if (!callbacks.has(name)) callbacks.set(name, new Set());
        callbacks.get(name)?.add(callback);
      },
      removeEventListener(name: string, callback: () => void) {
        callbacks.get(name)?.delete(callback);
      },
      dispatch(name: string) {
        for (const callback of callbacks.get(name) ?? []) callback();
      },
      get listeners() {
        return [...callbacks.values()].reduce((total, callbacks) => total + callbacks.size, 0);
      },
    };
  };
  const pending = new Map<number, () => void>();
  let sequence = 0;
  const schedule = (callback: () => void) => {
    pending.set(++sequence, callback);
    return sequence;
  };
  const cancel = (id: number) => pending.delete(id);
  const connection = { ...events(), saveData: false, effectiveType: '4g' };
  const navigator = { onLine: true, connection };
  const document = { ...events(), visibilityState: 'visible' };
  const window = {
    ...events(),
    setTimeout: schedule,
    clearTimeout: cancel,
    ...(idleSupported ? { requestIdleCallback: schedule, cancelIdleCallback: cancel } : {}),
  };
  for (const [name, value] of Object.entries({ window, document, navigator }))
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  return {
    connection,
    navigator,
    document,
    window,
    pending,
    flush() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe('idle category preparation', () => {
  test('waits for idle, coalesces repeated signals and removes all observers when the layout leaves', () => {
    const page = fixture();
    const values: boolean[] = [];
    let stop = () => {};
    try {
      stop = observeNavigationPreload((ready) => values.push(ready));
      expect(values).toEqual([]);
      expect(page.pending.size).toBe(1);
      page.connection.dispatch('change');
      page.document.dispatch('visibilitychange');
      expect(page.pending.size).toBe(1);
      page.flush();
      expect(values).toEqual([true]);
      page.connection.dispatch('change');
      expect(page.pending.size).toBe(0);
      stop();
      stop = () => {};
      expect(page.window.listeners + page.document.listeners + page.connection.listeners).toBe(0);
      page.window.dispatch('online');
      page.flush();
      expect(values).toEqual([true]);
    } finally {
      stop();
      page.restore();
    }
  });

  test('defers hidden, offline, Data Saver and slow-connection sessions, and resumes when they recover', () => {
    const page = fixture();
    const values: boolean[] = [];
    let stop = () => {};
    try {
      page.document.visibilityState = 'hidden';
      stop = observeNavigationPreload((ready) => values.push(ready));
      expect(page.pending.size).toBe(0);
      page.document.visibilityState = 'visible';
      page.document.dispatch('visibilitychange');
      expect(page.pending.size).toBe(1);
      page.connection.saveData = true;
      page.connection.dispatch('change');
      expect(page.pending.size).toBe(0);
      page.connection.saveData = false;
      for (const type of ['slow-2g', '2g']) {
        page.connection.effectiveType = type;
        page.connection.dispatch('change');
        expect(page.pending.size).toBe(0);
      }
      page.connection.effectiveType = '3g';
      page.connection.dispatch('change');
      page.navigator.onLine = false;
      page.window.dispatch('offline');
      expect(page.pending.size).toBe(0);
      page.navigator.onLine = true;
      page.window.dispatch('online');
      page.flush();
      expect(values).toEqual([true]);
      page.document.visibilityState = 'hidden';
      page.document.dispatch('visibilitychange');
      expect(values).toEqual([true, false]);
      page.document.visibilityState = 'visible';
      page.document.dispatch('visibilitychange');
      page.flush();
      expect(values).toEqual([true, false, true]);
    } finally {
      stop();
      page.restore();
    }
  });

  test('the timer fallback is also cancellable before route teardown', () => {
    const page = fixture(false);
    const values: boolean[] = [];
    let stop = () => {};
    try {
      stop = observeNavigationPreload((ready) => values.push(ready));
      expect(page.pending.size).toBe(1);
      stop();
      stop = () => {};
      expect(page.pending.size).toBe(0);
      page.flush();
      expect(values).toEqual([]);
    } finally {
      stop();
      page.restore();
    }
  });
});
