import { expect, test } from 'bun:test';
import {
  beginResetStartup,
  completeResetStartup,
  readResetStartupPhase,
  resetStartupBootstrap,
  resetStartupPending,
  subscribeResetStartup,
} from './reset-startup';

test('reset presentation survives only a recent same-tab handoff and never accepts a future or invalid marker', () => {
  const now = Date.now();
  for (const [value, expected] of [
    [null, false],
    ['not a timestamp', false],
    [String(now + 100000), false],
    [String(now - 5 * 60 * 1000 - 1), false],
    [String(now - 1000), true],
  ] as const) {
    const storage = { getItem: () => value };
    expect(resetStartupPending(storage, now)).toBe(expected);
    const root = { dataset: {} as Record<string, string> };
    new Function('sessionStorage', 'document', resetStartupBootstrap)(storage, { documentElement: root });
    expect(root.dataset.orbisResetStartup === 'true').toBe(expected);
  }
});

test('accepted reset covers synchronously before onboarding changes and survives reload until confirmed handoff', () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const root = { dataset: {} as Record<string, string> };
  set('document', { documentElement: root });
  set('window', new EventTarget());
  set('sessionStorage', storage);
  const events: string[] = [];
  const stop = subscribeResetStartup(() => events.push(readResetStartupPhase() ?? 'complete'));
  try {
    beginResetStartup('accepted');
    events.push('onboarding update');
    expect(events).toEqual(['accepted', 'onboarding update']);
    const reloaded = { dataset: {} as Record<string, string> };
    new Function('sessionStorage', 'document', resetStartupBootstrap)(storage, { documentElement: reloaded });
    expect(reloaded.dataset.orbisResetPhase).toBe('accepted');
    beginResetStartup('handoff');
    expect(readResetStartupPhase()).toBe('handoff');
    completeResetStartup();
    expect(readResetStartupPhase()).toBeNull();
    expect(values.size).toBe(0);
  } finally {
    stop();
    for (const [name, previous] of saved) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('blocked same-tab storage cannot break initial startup', () => {
  const storage = {
    getItem: () => {
      throw new Error('unavailable');
    },
  };
  expect(resetStartupPending(storage)).toBe(false);
  expect(() => new Function('sessionStorage', 'document', resetStartupBootstrap)(storage, { documentElement: { dataset: {} } })).not.toThrow();
});
