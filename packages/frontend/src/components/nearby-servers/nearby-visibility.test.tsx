import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NearbyVisibility, readNearbyVisibility, setNearbyVisibility } from './nearby-visibility';

const sharing = { interface: 'eth0', origin: 'https://source.example.test', expiresAt: new Date(Date.now() + 180_000).toISOString() };
const allowed = { available: true, policyVersion: 1, enabled: true, sharing } as const;
const off = { available: true, policyVersion: 1, enabled: false, sharing: null } as const;
async function withFetch(responses: (Response | Error)[], run: (calls: { url: unknown; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected test request');
      if (response instanceof Error) throw response;
      return response;
    },
    { preconnect: original.preconnect },
  );
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
test('visibility renders a disabled unconfirmed switch, without a manual interface/origin/lease form', async () => {
  await withFetch([], async (calls) => {
    const html = renderToStaticMarkup(<NearbyVisibility />);
    expect(html).toContain('Allow nearby discovery');
    expect(html).toContain('disabled');
    expect(html).toContain('not been confirmed');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('two minutes');
    expect(html).not.toContain('https://');
    expect(calls).toHaveLength(0);
  });
});
test('persistent policy sends only the boolean and confirms actual readback before success', async () => {
  for (const [enabled, expected] of [
    [true, allowed],
    [false, off],
  ] as const) {
    await withFetch([Response.json(expected), Response.json(expected)], async (calls) => {
      expect(await setNearbyVisibility(enabled)).toEqual(expected);
      expect(calls.map((call) => call.url)).toEqual(['/api/nearby-discovery/policy', '/api/nearby-discovery']);
      expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled });
    });
  }
});
test('a failed or contradictory readback never reports saved/active visibility', async () => {
  for (const response of [Response.json(off), Response.json({ ...allowed, sharing: null }), Response.json({ available: false })]) {
    await withFetch([Response.json(allowed), response], async () => {
      await expect(setNearbyVisibility(true)).rejects.toThrow('could not be confirmed');
    });
  }
  await withFetch([new Error('offline')], async () => {
    await expect(setNearbyVisibility(false)).rejects.toThrow();
  });
});
test('older helpers, malformed policy or private diagnostics cannot produce an enabled status', async () => {
  await withFetch([Response.json({ available: false, reason: 'private-diagnostic' })], async () => {
    expect(await readNearbyVisibility()).toEqual({ available: false, sharing: null });
  });
  for (const value of [
    { available: true, sharing: null },
    { ...allowed, enabled: false },
    { ...allowed, policyVersion: 2 },
    { ...allowed, sharing: { ...sharing, origin: 'http://source.example.test' } },
  ]) {
    await withFetch([Response.json(value)], async () => {
      await expect(readNearbyVisibility()).rejects.toThrow();
    });
  }
});

test('a confirmed address-only lease needs no HTTPS name but never accepts an origin or untrusted public address', async () => {
  const hint = { kind: 'address', interface: 'eth0', address: '192.168.50.20', port: 8080, expiresAt: sharing.expiresAt } as const;
  const value = { ...allowed, hintVersion: 2 as const, sharing: hint };
  await withFetch([Response.json(value), Response.json(value)], async () => {
    expect(await setNearbyVisibility(true)).toEqual(value);
  });
  for (const changed of [
    { ...value, hintVersion: undefined },
    { ...value, sharing: { ...hint, origin: 'http://192.168.50.20' } },
    { ...value, sharing: { ...hint, address: '8.8.8.8' } },
    { ...value, sharing: { ...hint, port: 0 } },
  ]) {
    await withFetch([Response.json(changed)], async () => {
      await expect(readNearbyVisibility()).rejects.toThrow();
    });
  }
});

test('unavailable discovery keeps only a known capability code and treats an absent endpoint as unsupported', async () => {
  for (const reasonCode of ['host-unavailable', 'unsupported', 'https-required', 'interface-unavailable'] as const) {
    await withFetch([Response.json({ available: false, reasonCode, reason: '/private/host/diagnostic' })], async () => {
      expect(await readNearbyVisibility()).toEqual({ available: false, sharing: null, reasonCode });
    });
  }
  await withFetch([Response.json({ available: false, reasonCode: '/private/host/diagnostic' })], async () => {
    expect(await readNearbyVisibility()).toEqual({ available: false, sharing: null });
  });
  await withFetch([new Response('', { status: 404 })], async () => {
    expect(await readNearbyVisibility()).toEqual({ available: false, sharing: null, reasonCode: 'unsupported' });
  });
});
