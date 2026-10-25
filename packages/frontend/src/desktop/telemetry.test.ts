/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { telemetryOptions } from './telemetry';

test('a hidden status view waits until visible before loading, then shares local data across views', async () => {
  const client = createAppQueryClient();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_input, _init) => {
    requests++;
    return Response.json({ sampledAt: 'current' });
  }) as typeof fetch;
  const home = new QueryObserver(client, telemetryOptions(false));
  const monitor = new QueryObserver(client, telemetryOptions(false, '/api/system/telemetry', 'local-server'));
  const offHome = home.subscribe(() => undefined);
  const offMonitor = monitor.subscribe(() => undefined);
  try {
    await Bun.sleep(0);
    expect(requests).toBe(0);
    home.setOptions(telemetryOptions(true));
    monitor.setOptions(telemetryOptions(true, '/api/system/telemetry', 'local-server'));
    await Bun.sleep(0);
    expect(requests).toBe(1);
    expect(home.getCurrentResult().data).toBe(monitor.getCurrentResult().data);
  } finally {
    offHome();
    offMonitor();
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test('remote readings retain their server cache and cancel their request when the view leaves', async () => {
  const client = createAppQueryClient();
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null = null;
  const signal = () => requestSignal;
  globalThis.fetch = (async (path, init) => {
    expect(path).toBe('/api/cluster/servers/other/read/telemetry');
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const remote = new QueryObserver(client, telemetryOptions(true, '/api/cluster/servers/other/read/telemetry', 'other'));
  const off = remote.subscribe(() => undefined);
  try {
    await Bun.sleep(0);
    expect(requestSignal).not.toBeNull();
    expect(signal()?.aborted).toBe(false);
    off();
    expect(signal()?.aborted).toBe(true);
    expect(client.getQueryData(telemetryOptions(false).queryKey)).toBeUndefined();
  } finally {
    off();
    client.clear();
    globalThis.fetch = originalFetch;
  }
});
