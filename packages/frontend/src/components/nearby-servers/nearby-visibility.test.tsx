import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { disableNearbyVisibility, enableNearbyVisibility, NearbyVisibility, readNearbyVisibility } from './nearby-visibility';

const origin = 'https://source.example.test';
const sharing = { interface: 'eth0', origin, expiresAt: new Date(Date.now() + 120_000).toISOString() };
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
test('visibility starts collapsed without network requests, default origin, interface or automatic advertising', async () => {
  await withFetch([], async (calls) => {
    const markup = renderToStaticMarkup(<NearbyVisibility />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('https://');
    expect(calls).toHaveLength(0);
  });
});
test('explicit visibility uses one selected interface and exactly a two-minute lease, then confirms actual status', async () => {
  await withFetch([Response.json({ available: true, sharing }), Response.json({ available: true, sharing })], async (calls) => {
    await expect(enableNearbyVisibility('eth0', origin)).resolves.toEqual({ available: true, sharing });
    expect(calls.map((call) => call.url)).toEqual(['/api/nearby-discovery/advertise', '/api/nearby-discovery']);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ interface: 'eth0', origin, leaseSeconds: 120 });
    expect(calls[1]?.init).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    expect(String(calls[0]?.init?.body)).not.toContain('code');
  });
});
test('visibility cannot be enabled without an explicit interface and safe HTTPS origin', async () => {
  await withFetch([], async (calls) => {
    for (const [selected, address] of [
      ['', origin],
      ['eth0', 'http://source.example.test'],
      ['eth0', 'https://user:password@source.example.test'],
    ])
      await expect(enableNearbyVisibility(selected ?? '', address ?? '')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
test('network failure, redirects or unmatched confirmation never claim visibility is off or established', async () => {
  for (const response of [new Error('Redirect blocked'), new Response(null, { status: 302, headers: { Location: 'https://other.example' } })]) {
    await withFetch([response], async () => {
      await expect(enableNearbyVisibility('eth0', origin)).rejects.toThrow('may remain on');
    });
  }
  await withFetch(
    [Response.json({ available: true, sharing }), Response.json({ available: true, sharing: { ...sharing, interface: 'wlan0' } })],
    async () => {
      await expect(enableNearbyVisibility('eth0', origin)).rejects.toThrow('could not be confirmed');
    },
  );
});
test('Hide confirms server state before saying visibility ended', async () => {
  await withFetch([Response.json({ available: true, sharing: null }), Response.json({ available: true, sharing: null })], async (calls) => {
    await expect(disableNearbyVisibility()).resolves.toEqual({ available: true, sharing: null });
    expect(calls[0]?.url).toBe('/api/nearby-discovery/disable');
    expect(calls[0]?.init?.body).toBe('{}');
  });
  await withFetch([Response.json({ available: true, sharing: null }), Response.json({ available: false })], async () => {
    await expect(disableNearbyVisibility()).rejects.toThrow('could not be confirmed off');
  });
});
test('malformed/private diagnostic status is rejected without echoing configuration', async () => {
  await withFetch([Response.json({ available: false, reason: 'private-diagnostic-sentinel' })], async () => {
    expect(await readNearbyVisibility()).toEqual({ available: false, sharing: null });
  });
  await withFetch([Response.json({ available: true, sharing: { ...sharing, origin: 'http://source.example.test' } })], async () => {
    await expect(readNearbyVisibility()).rejects.toThrow('Invalid nearby HTTPS');
  });
});
