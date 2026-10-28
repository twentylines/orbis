/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { HostSensors } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { telemetryOptions } from '@/desktop/telemetry';
import { QueryObserver } from '@tanstack/react-query';
import { appContextQueryKey, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { clearAccountQueries, createAppQueryClient } from '@/lib/query-client';
import { createSystemHealthStore, sessionSystemHealth } from './system-health-store';
import { sensorOptions } from './use-system-health';

const epoch = Date.parse('2026-01-01T00:00:00Z');
const samples = (at: number) => ({
  telemetry: {
    sampledAt: new Date(at).toISOString(),
    cpu: { scope: 'host-proc', totalPercent: 95, perCorePercent: [], uptimeSeconds: 100 },
    memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 5, swapTotalBytes: null, swapFreeBytes: null },
    filesystems: [],
    network: [],
  } satisfies Telemetry,
  sensors: {
    available: true,
    sampledAt: new Date(at).toISOString(),
    stale: false,
    limited: false,
    unreadable: 0,
    temperatures: [{ id: 'cpu', chip: 'coretemp', label: 'CPU', status: 'available', celsius: 95, criticalCelsius: 90 }],
    fans: [],
    gpus: [],
    omitted: { temperatures: 0, fans: 0, gpus: 0 },
    unavailable: [],
  } satisfies HostSensors,
});

function harness() {
  let now = epoch;
  let sequence = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const store = createSystemHealthStore({
    now: () => now,
    schedule: (callback, delay) => {
      const id = ++sequence;
      tasks.set(id, { at: now + delay, callback });
      return () => {
        tasks.delete(id);
      };
    },
  });
  return {
    store,
    tasks,
    setTime: (value: number) => {
      now = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= now).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) return;
        tasks.delete(due[0]);
        due[1].callback();
      }
    },
    sustain: () => {
      let stop: () => void = () => undefined;
      for (let seconds = 0; seconds <= 60; seconds++) {
        stop();
        now = epoch + seconds * 1000;
        stop = store.observe(samples(now), true);
      }
      return stop;
    },
  };
}

test('one-shot expiry labels stalled CPU and sensor alerts delayed without another sample or request', () => {
  const h = harness();
  const stop = h.sustain();
  let notifications = 0;
  const off = h.store.subscribe(() => notifications++, true);
  expect(h.store.getSnapshot().cpu).toMatchObject({ active: true, fresh: true });
  expect(h.store.getSnapshot()['temperature:cpu']).toMatchObject({ active: true, fresh: true });
  expect(h.tasks.size).toBe(1);
  h.advance(5001);
  expect(h.store.getSnapshot().cpu).toMatchObject({ active: true, fresh: false, highSince: null });
  expect(h.store.getSnapshot()['temperature:cpu']?.fresh).toBe(true);
  expect(notifications).toBe(1);
  expect(h.tasks.size).toBe(1);
  h.advance(85_000);
  expect(h.store.getSnapshot()['temperature:cpu']).toMatchObject({ active: true, fresh: false });
  expect(h.tasks.size).toBe(0);
  expect(notifications).toBe(2);
  stop();
  off();
});

test('hidden views cancel expiry timers and resumed rendering expires the snapshot before observing again', () => {
  const h = harness();
  const stop = h.sustain();
  stop();
  expect(h.tasks.size).toBe(0);
  h.setTime(epoch + 200_000);
  const resumedSnapshot = h.store.getSnapshot();
  expect(resumedSnapshot.cpu).toMatchObject({ active: true, fresh: false });
  expect(resumedSnapshot['temperature:cpu']).toMatchObject({ active: true, fresh: false });
  expect(h.store.getSnapshot()).toBe(resumedSnapshot);
  const hidden = h.store.observe(samples(epoch + 60_000), false);
  expect(h.tasks.size).toBe(0);
  hidden();
  const resumed = h.store.observe(samples(epoch + 60_000), true);
  expect(h.store.getSnapshot().cpu?.fresh).toBe(false);
  expect(h.tasks.size).toBe(0);
  resumed();
});

test('multiple visible observers share one timer and removing the last observer cancels it', () => {
  const h = harness();
  const reading = samples(epoch);
  const first = h.store.observe(reading, true);
  const second = h.store.observe(reading, true);
  expect(h.tasks.size).toBe(1);
  first();
  expect(h.tasks.size).toBe(1);
  second();
  expect(h.tasks.size).toBe(0);
});

test('a visible attention subscriber keeps only freshness expiry after the polling owner leaves', () => {
  const h = harness();
  const stopPolling = h.sustain();
  const offAttention = h.store.subscribe(() => undefined, true);
  stopPolling();
  expect(h.tasks.size).toBe(1);
  h.advance(5001);
  expect(h.store.getSnapshot().cpu).toMatchObject({ active: true, fresh: false });
  offAttention();
  expect(h.tasks.size).toBe(0);
  const offHidden = h.store.subscribe(() => undefined, false);
  expect(h.tasks.size).toBe(0);
  offHidden();
});

test('mounted Home query observers feed a subscription-only attention consumer without duplicate requests', async () => {
  const h = harness();
  const client = createAppQueryClient();
  const originalFetch = globalThis.fetch;
  const requests = { telemetry: 0, sensors: 0 };
  let sampledAt = epoch;
  globalThis.fetch = (async (input, _init) => {
    if (input === '/api/system/telemetry') {
      requests.telemetry++;
      return Response.json(samples(sampledAt).telemetry);
    }
    if (input === '/api/system/host-sensors') {
      requests.sensors++;
      return Response.json(samples(sampledAt).sensors);
    }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const homeTelemetry = new QueryObserver(client, telemetryOptions(true));
  const homeSensors = new QueryObserver(client, sensorOptions(true));
  let releaseObservation: () => void = () => undefined;
  const observe = () => {
    releaseObservation();
    releaseObservation = h.store.observe({ telemetry: homeTelemetry.getCurrentResult().data, sensors: homeSensors.getCurrentResult().data }, true);
  };
  const offTelemetry = homeTelemetry.subscribe(observe);
  const offSensors = homeSensors.subscribe(observe);
  let offAttention: () => void = () => undefined;
  let attentionUpdates = 0;
  try {
    await Bun.sleep(0);
    expect(requests).toEqual({ telemetry: 1, sensors: 1 });
    // Attach attention after the first requests finish, so in-flight deduplication cannot hide an extra owner.
    offAttention = h.store.subscribe(() => attentionUpdates++, true);
    await Bun.sleep(0);
    expect(requests).toEqual({ telemetry: 1, sensors: 1 });
    expect(
      client
        .getQueryCache()
        .find({ queryKey: telemetryOptions(true).queryKey, exact: true })
        ?.getObserversCount(),
    ).toBe(1);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: sensorOptions(true).queryKey, exact: true })
        ?.getObserversCount(),
    ).toBe(1);
    for (let seconds = 1; seconds <= 60; seconds++) {
      sampledAt = epoch + seconds * 1000;
      h.setTime(sampledAt);
      await homeTelemetry.refetch();
      if (seconds % 30 === 0) await homeSensors.refetch();
    }
    expect(requests).toEqual({ telemetry: 61, sensors: 3 });
    expect(h.store.getSnapshot().cpu).toMatchObject({ active: true, fresh: true });
    expect(h.store.getSnapshot()['temperature:cpu']).toMatchObject({ active: true, fresh: true });
    expect(attentionUpdates).toBeGreaterThan(0);
    expect(h.tasks.size).toBe(1);
    offTelemetry();
    offSensors();
    releaseObservation();
    offAttention();
    await client.invalidateQueries();
    expect(requests).toEqual({ telemetry: 61, sensors: 3 });
    expect(h.tasks.size).toBe(0);
  } finally {
    offTelemetry();
    offSensors();
    releaseObservation();
    offAttention();
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test('health state is isolated by user, server and the app-context query removed on real sign-out', async () => {
  const client = createAppQueryClient();
  const contextKey = appContextQueryKey();
  const sessionKey = userContextQueryKey();
  const identity = { user: { id: 1 } };
  client.setQueryData(contextKey, identity);
  client.setQueryData(sessionKey, { isLoggedIn: true });
  const previousSession = client.getQueryCache().find({ queryKey: contextKey, exact: true });
  if (!previousSession) throw new Error('App context query was not created');
  const previous = sessionSystemHealth(previousSession, 1, '/api/system/telemetry');
  const stop = previous.observe(samples(Date.now()), true);
  expect(previous.getSnapshot().cpu?.value).toBe(95);
  expect(sessionSystemHealth(previousSession, 1, '/api/system/telemetry')).toBe(previous);
  expect(sessionSystemHealth(previousSession, 2, '/api/system/telemetry').getSnapshot()).toEqual({});
  expect(sessionSystemHealth(previousSession, 1, '/remote/telemetry').getSnapshot()).toEqual({});
  stop();
  await clearAccountQueries(client, sessionKey, { isLoggedIn: false });
  expect(client.getQueryCache().find({ queryKey: contextKey, exact: true })).toBeUndefined();
  client.setQueryData(contextKey, identity);
  const nextSession = client.getQueryCache().find({ queryKey: contextKey, exact: true });
  if (!nextSession) throw new Error('New app context query was not created');
  expect(nextSession).not.toBe(previousSession);
  const next = sessionSystemHealth(nextSession, 1, '/api/system/telemetry');
  expect(next).not.toBe(previous);
  expect(next.getSnapshot()).toEqual({});
  client.clear();
});
