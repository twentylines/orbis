import { advanceSystemHealth, expireSystemHealth, type HealthSamples, type SystemHealth } from './system-health';

type Clock = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => () => void;
};
const browserClock: Clock = {
  now: Date.now,
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

export function createSystemHealthStore(clock: Clock = browserClock) {
  let state: SystemHealth = {};
  let snapshot = state;
  let snapshotSource = state;
  let cancelExpiry: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const visibleObservers = new Set<symbol>();
  const publish = (next: SystemHealth) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const scheduleExpiry = () => {
    cancelExpiry?.();
    cancelExpiry = undefined;
    if (!visibleObservers.size) return;
    const expiries = Object.values(state)
      .filter((condition) => condition.fresh)
      .map((condition) => condition.at + condition.freshForMs + 1);
    if (!expiries.length) return;
    cancelExpiry = clock.schedule(
      () => {
        cancelExpiry = undefined;
        publish(expireSystemHealth(state, clock.now()));
        scheduleExpiry();
      },
      Math.max(1, Math.min(...expiries) - clock.now()),
    );
  };
  return {
    subscribe: (listener: () => void, visible: boolean) => {
      publish(expireSystemHealth(state, clock.now()));
      listeners.add(listener);
      const observer = Symbol();
      if (visible) visibleObservers.add(observer);
      scheduleExpiry();
      return () => {
        listeners.delete(listener);
        visibleObservers.delete(observer);
        scheduleExpiry();
      };
    },
    getSnapshot: () => {
      if (snapshotSource !== state) {
        snapshotSource = state;
        snapshot = state;
      }
      // A resumed view reads the expired projection before its effects can run.
      snapshot = expireSystemHealth(snapshot, clock.now());
      return snapshot;
    },
    observe: (samples: HealthSamples, visible: boolean) => {
      const observer = Symbol();
      if (visible) visibleObservers.add(observer);
      const current = expireSystemHealth(state, clock.now());
      publish(visible ? advanceSystemHealth(current, samples, clock.now()) : current);
      scheduleExpiry();
      return () => {
        visibleObservers.delete(observer);
        scheduleExpiry();
      };
    },
  };
}

const sessions = new WeakMap<object, Map<string, ReturnType<typeof createSystemHealthStore>>>();

export function sessionSystemHealth(session: object, userId: number | string, source: string) {
  let servers = sessions.get(session);
  if (!servers) {
    servers = new Map();
    sessions.set(session, servers);
  }
  const key = JSON.stringify([userId, source]);
  let store = servers.get(key);
  if (!store) {
    store = createSystemHealthStore();
    servers.set(key, store);
  }
  return store;
}
