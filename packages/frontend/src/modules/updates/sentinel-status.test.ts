import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  parseSentinelStatus,
  readSentinelRecoveryAccess,
  readSentinelStatus,
  sentinelRecoveryAccessOptions,
  SentinelStatusError,
  sentinelStatusLabel,
  sentinelStatusOptions,
} from './sentinel-status';
import type { SentinelStatus } from './sentinel-status';

const healthy = { available: true, installedVersion: '0.1.0-dev.11', availableVersion: null, state: 'healthy' as const };
const unavailable = { available: false, installedVersion: null, availableVersion: null, state: 'unknown' as const };

test('reads recovery access only from the fixed authenticated route and rejects unsafe portal links', async () => {
  const original = globalThis.fetch;
  const configured = { state: 'configured', portalUrl: 'https://independent.example:8443/sentinel/recovery/', unitState: 'active' } as const;
  let body: unknown = configured;
  globalThis.fetch = Object.assign(
    async (url: unknown, options?: RequestInit) => {
      expect(url).toBe('/api/system/sentinel/recovery-access');
      expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      return Response.json(body);
    },
    { preconnect: original.preconnect },
  );
  try {
    const signal = new AbortController().signal;
    expect(await readSentinelRecoveryAccess(signal)).toEqual(configured);
    body = { ...configured, enrollment: 'key-prepared' };
    expect(await readSentinelRecoveryAccess(signal)).toMatchObject({ enrollment: 'key-prepared' });
    for (body of [
      { ...configured, portalUrl: 'https://independent.example@other.example/sentinel/recovery/' },
      { ...configured, portalUrl: 'https://independent.example/other/' },
      { ...configured, portalUrl: 'https://independent.example/Sentinel/recovery/' },
      { ...configured, portalUrl: 'https://independent.example/sentinel/recovery/\n' },
      { ...configured, state: 'unavailable' },
      { ...configured, unitState: 'ready' },
      { ...configured, enrollment: 'untrusted' },
      { ...configured, unitState: 'unknown', enrollment: 'activated' },
      { ...configured, extra: 'private data' },
    ])
      await expect(readSentinelRecoveryAccess(signal)).rejects.toBeInstanceOf(SentinelStatusError);
  } finally {
    globalThis.fetch = original;
  }
});

test('recovery polling pauses while inactive and stops after an auth failure', () => {
  const client = new QueryClient();
  const active = sentinelRecoveryAccessOptions(true);
  const inactive = sentinelRecoveryAccessOptions(false);
  const query = client.getQueryCache().build(client, {
    queryKey: [...active.queryKey],
    queryFn: ({ signal }) => readSentinelRecoveryAccess(signal),
  });
  try {
    if (
      typeof active.enabled !== 'function' ||
      typeof inactive.enabled !== 'function' ||
      typeof active.refetchInterval !== 'function' ||
      typeof inactive.refetchInterval !== 'function'
    )
      throw new Error('Expected visibility and authentication-aware recovery polling');
    expect(active.enabled(query)).toBe(true);
    expect(active.refetchInterval(query)).toBe(15_000);
    expect(inactive.enabled(query)).toBe(false);
    expect(inactive.refetchInterval(query)).toBe(false);
    expect(active.refetchIntervalInBackground).toBe(false);
    for (const status of [401, 403]) {
      query.setState({ status: 'error', error: new SentinelStatusError(status) });
      expect(active.enabled(query)).toBe(false);
      expect(active.refetchInterval(query)).toBe(false);
    }
  } finally {
    client.clear();
  }
});

describe('Sentinel status contract', () => {
  test('preserves reported versions and explicit unknown observations without inferring an update', () => {
    expect(parseSentinelStatus(healthy)).toEqual(healthy);
    expect(parseSentinelStatus(unavailable)).toEqual(unavailable);
    expect(parseSentinelStatus({ ...healthy, installedVersion: null, state: 'unknown' })).toEqual({
      ...healthy,
      installedVersion: null,
      state: 'unknown',
    });
    expect(parseSentinelStatus({ ...healthy, availableVersion: '0.2.0-beta.1+build.4' }).availableVersion).toBe('0.2.0-beta.1+build.4');
    const result = parseSentinelStatus(healthy);
    result.state = 'recovering';
    expect(healthy.state).toBe('healthy');
  });

  test('rejects malformed, ambiguous and inconsistent service observations', () => {
    for (const value of [
      null,
      [],
      { ...healthy, extra: true },
      { ...healthy, available: 'yes' },
      { ...healthy, state: 'running' },
      { ...healthy, installedVersion: undefined },
      { ...healthy, installedVersion: 'v1.2.3' },
      { ...healthy, installedVersion: '1.2.3\n' },
      { ...healthy, availableVersion: `1.2.3-${'x'.repeat(128)}` },
      { ...healthy, available: false },
      { ...unavailable, availableVersion: '1.2.3' },
    ])
      expect(() => parseSentinelStatus(value)).toThrow(SentinelStatusError);
  });

  test('never labels unknown or unreadable state as running or up to date', () => {
    expect(sentinelStatusLabel(undefined)).toBe('Status unavailable');
    expect(sentinelStatusLabel(unavailable)).toBe('Status unavailable');
    for (const [state, label] of [
      ['healthy', 'Running'],
      ['unknown', 'Status unknown'],
      ['unavailable', 'Unavailable'],
      ['updating', 'Updating'],
      ['recovering', 'Recovering'],
    ] as const)
      expect(sentinelStatusLabel({ ...healthy, state })).toBe(label);
  });
});

describe('Sentinel status request', () => {
  test('reads only the authenticated status resource with cancellation and no HTTP cache', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url, options) => {
      calls++;
      expect(url).toBe('/api/system/sentinel');
      expect(options?.method).toBe('GET');
      expect(options?.credentials).toBe('same-origin');
      expect(options?.cache).toBe('no-store');
      expect(options?.body).toBeUndefined();
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(healthy);
    }) as typeof fetch;
    try {
      expect(await readSentinelStatus(new AbortController().signal)).toEqual(healthy);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('authentication, legacy and server errors stay errors without leaking response diagnostics', async () => {
    const original = globalThis.fetch;
    try {
      for (const status of [401, 403, 404, 503]) {
        globalThis.fetch = Object.assign(async () => new Response('/private/server/diagnostic', { status }), { preconnect: original.preconnect });
        const result = await readSentinelStatus(new AbortController().signal).catch((error: unknown) => error);
        expect(result).toBeInstanceOf(SentinelStatusError);
        expect((result as SentinelStatusError).status).toBe(status);
        expect((result as Error).message).not.toContain('/private');
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('rejects corrupt JSON, invalid UTF-8 and oversized bodies instead of rendering them', async () => {
    const original = globalThis.fetch;
    try {
      for (const body of ['{', new Uint8Array([0xff, 0xfe]), JSON.stringify({ ...healthy, extra: 'x'.repeat(4096) })]) {
        globalThis.fetch = Object.assign(async () => new Response(body), { preconnect: original.preconnect });
        await expect(readSentinelStatus(new AbortController().signal)).rejects.toThrow();
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('passes caller cancellation through to a pending request', async () => {
    const original = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = ((_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      })) as typeof fetch;
    try {
      const promise = readSentinelStatus(controller.signal);
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('cancels oversized response streams', async () => {
    const original = globalThis.fetch;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = Object.assign(async () => new Response(stream), { preconnect: original.preconnect });
    try {
      await expect(readSentinelStatus(new AbortController().signal)).rejects.toBeInstanceOf(SentinelStatusError);
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('authentication and unsupported endpoints stop polling, while active operations are sampled sooner', () => {
    const client = new QueryClient();
    const options = sentinelStatusOptions(true);
    const query = client.getQueryCache().build(client, {
      queryKey: ['orbis-sentinel-status'],
      queryFn: async (): Promise<SentinelStatus> => healthy,
    });
    const interval = options.refetchInterval;
    if (typeof interval !== 'function') throw new Error('Expected a status-aware polling interval');
    try {
      for (const status of [401, 403, 404]) {
        query.setState({ status: 'error', error: new SentinelStatusError(status) });
        expect(interval(query)).toBe(false);
      }
      query.setState({ status: 'error', error: new SentinelStatusError(503) });
      expect(interval(query)).toBe(30_000);
      for (const state of ['updating', 'recovering'] as const) {
        query.setState({ status: 'success', error: null, data: { ...healthy, state } });
        expect(interval(query)).toBe(4000);
      }
    } finally {
      client.clear();
    }
  });

  test('hidden Updates panels neither start requests nor poll in the background', () => {
    const inactive = sentinelStatusOptions(false);
    expect(inactive.enabled).toBe(false);
    expect(inactive.refetchInterval).toBe(false);
    expect(inactive.refetchIntervalInBackground).toBe(false);
    expect(inactive.retry).toBe(false);
    expect(sentinelStatusOptions(true).enabled).toBe(true);
  });
});
