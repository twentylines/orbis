import { expect, test } from 'bun:test';
import { NearbySearch } from './nearby-search';
import { nearbyFallback, type NearbyCandidate } from './nearby-api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NearbyResult, NearbyServers } from './nearby-servers';

const eth = { id: 'eth0', address: '192.168.1.2', prefixLength: 24 };
const wifi = { id: 'wlan0', address: '192.168.2.2', prefixLength: 24 };
const candidate: NearbyCandidate = {
  id: 'a'.repeat(32),
  origin: 'https://orbis.test',
  address: '192.168.1.3',
  port: 443,
  expiresAt: new Date(60_000).toISOString(),
  verified: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('show fetches interfaces and automatically scans a single interface exactly once', async () => {
  const calls: string[] = [];
  const search = new NearbySearch(() => {}, {
    interfaces: async () => {
      calls.push('interfaces');
      return { available: true, interfaces: [eth] };
    },
    scan: async (id) => {
      calls.push(id);
      return { available: true, candidates: [candidate] };
    },
  });
  expect(calls).toEqual([]);
  await search.refresh();
  expect(calls).toEqual([]);
  const first = search.show();
  await search.show();
  await search.refresh();
  await first;
  expect(calls).toEqual(['interfaces', 'eth0']);
  expect(search.snapshot).toMatchObject({ selected: 'eth0', busy: false, candidates: [candidate] });
});

test('multiple interfaces wait for a valid choice and a choice starts its scan without another button', async () => {
  const scans: string[] = [];
  const search = new NearbySearch(() => {}, {
    interfaces: async () => ({ available: true, interfaces: [eth, wifi] }),
    scan: async (id) => {
      scans.push(id);
      return { available: true, candidates: [] };
    },
  });
  await search.show();
  expect(scans).toEqual([]);
  expect(search.snapshot.selected).toBe('');
  await search.select('foreign0');
  await search.select('wlan0');
  await search.select('wlan0');
  expect(scans).toEqual(['wlan0']);
  expect(search.snapshot.message).toContain('No nearby servers');
});

test('hidden or unmounted inventory is aborted and cannot replace a later visible activation', async () => {
  const old = deferred<{ available: true; interfaces: (typeof eth)[] }>();
  const fresh = deferred<{ available: true; interfaces: (typeof eth)[] }>();
  const signals: AbortSignal[] = [];
  const scans: string[] = [];
  let loads = 0;
  let notifications = 0;
  const search = new NearbySearch(() => notifications++, {
    interfaces: (signal) => {
      if (!signal) throw new Error('Missing cancellation signal');
      signals.push(signal);
      return ++loads === 1 ? old.promise : fresh.promise;
    },
    scan: async (id) => {
      scans.push(id);
      return { available: true, candidates: [] };
    },
  });
  const first = search.show();
  search.hide();
  expect(signals[0]?.aborted).toBe(true);
  const beforeLate = notifications;
  old.resolve({ available: true, interfaces: [eth] });
  await first;
  expect(notifications).toBe(beforeLate);
  await search.refresh();
  expect(loads).toBe(1);
  const second = search.show();
  fresh.resolve({ available: true, interfaces: [wifi] });
  await second;
  expect(scans).toEqual(['wlan0']);
  expect(search.snapshot.selected).toBe('wlan0');
});

test('rapid interface changes reject old success/error/finally without clearing the current scan', async () => {
  for (const failure of [false, true]) {
    const old = deferred<{ available: true; candidates: NearbyCandidate[] }>();
    const fresh = deferred<{ available: true; candidates: NearbyCandidate[] }>();
    const signals: AbortSignal[] = [];
    const search = new NearbySearch(() => {}, {
      interfaces: async () => ({ available: true, interfaces: [eth, wifi] }),
      scan: (id, signal) => {
        if (!signal) throw new Error('Missing cancellation signal');
        signals.push(signal);
        return id === 'eth0' ? old.promise : fresh.promise;
      },
    });
    await search.show();
    const first = search.select('eth0');
    const second = search.select('wlan0');
    expect(signals[0]?.aborted).toBe(true);
    if (failure) old.reject(new Error('old failure'));
    else old.resolve({ available: true, candidates: [candidate] });
    await first;
    expect(search.snapshot).toMatchObject({ selected: 'wlan0', busy: true, candidates: [], message: '' });
    fresh.resolve({ available: true, candidates: [{ ...candidate, id: 'b'.repeat(32) }] });
    await second;
    expect(search.snapshot).toMatchObject({ selected: 'wlan0', busy: false });
    expect(search.snapshot.candidates[0]?.id).toBe('b'.repeat(32));
    search.hide();
    expect(search.choose('b'.repeat(32), 1)).toBeUndefined();
  }
});

test('a scan from a prior visible activation cannot populate the same interface after resume', async () => {
  const old = deferred<{ available: true; candidates: NearbyCandidate[] }>();
  const fresh = deferred<{ available: true; candidates: NearbyCandidate[] }>();
  let scans = 0;
  let firstSignal: AbortSignal | undefined;
  const search = new NearbySearch(() => {}, {
    interfaces: async () => ({ available: true, interfaces: [eth] }),
    scan: (_id, signal) => {
      if (!scans++) firstSignal = signal;
      return scans === 1 ? old.promise : fresh.promise;
    },
  });
  const first = search.show();
  await Promise.resolve();
  expect(scans).toBe(1);
  search.hide();
  expect(firstSignal?.aborted).toBe(true);
  const second = search.show();
  await Promise.resolve();
  old.resolve({ available: true, candidates: [candidate] });
  await first;
  expect(search.snapshot).toMatchObject({ selected: 'eth0', busy: true, candidates: [] });
  fresh.resolve({ available: true, candidates: [] });
  await second;
  expect(scans).toBe(2);
  expect(search.snapshot.candidates).toEqual([]);
});

test('refresh revalidates inventory and discards prior choices and results', async () => {
  let loads = 0;
  const scans: string[] = [];
  const search = new NearbySearch(() => {}, {
    interfaces: async () => ({ available: true, interfaces: ++loads === 1 ? [eth] : [eth, wifi] }),
    scan: async (id) => {
      scans.push(id);
      return { available: true, candidates: [candidate] };
    },
  });
  await search.show();
  await search.refresh();
  expect(loads).toBe(2);
  expect(scans).toEqual(['eth0']);
  expect(search.snapshot).toMatchObject({ selected: '', candidates: [], busy: false });
  expect(search.choose(candidate.id, 1)).toBeUndefined();
});

test('unavailable and empty inventories keep the manual fallback and never scan', async () => {
  for (const result of [{ available: false as const }, { available: true as const, interfaces: [] }]) {
    let scans = 0;
    const search = new NearbySearch(() => {}, {
      interfaces: async () => result,
      scan: async () => {
        scans++;
        return { available: false };
      },
    });
    await search.show();
    expect(scans).toBe(0);
    expect(search.snapshot.busy).toBe(false);
    expect(search.snapshot.message).toContain('manually');
  }
  const search = new NearbySearch(() => {}, {
    interfaces: async () => {
      throw new Error('private helper detail');
    },
    scan: async () => ({ available: false }),
  });
  await search.show();
  expect(search.snapshot.message).toBe(nearbyFallback);
});

test('candidate selection remains an unverified origin hint and rejects expired or removed results', async () => {
  const search = new NearbySearch(() => {}, {
    interfaces: async () => ({ available: true, interfaces: [eth] }),
    scan: async () => ({ available: true, candidates: [candidate] }),
  });
  await search.show();
  expect(search.snapshot.candidates[0]?.verified).toBe(false);
  expect(search.choose(candidate.id, 1)).toBe(candidate.origin);
  expect(search.choose(candidate.id, 60_000)).toBeUndefined();
  expect(search.snapshot.candidates).toEqual([]);
  expect(search.snapshot.message).toContain('expired');
});

test('the production API path issues one interface GET and one bounded scan POST, with no trust or transfer requests', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(
        String(url).endsWith('/interfaces') ? { available: true, interfaces: [eth] } : { available: true, candidates: [candidate] },
      );
    },
    { preconnect: original.preconnect },
  );
  try {
    const search = new NearbySearch(() => {});
    await search.show();
    expect(calls.map((call) => call.url)).toEqual(['/api/nearby-discovery/interfaces', '/api/nearby-discovery/scan']);
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(calls[1]?.init).toMatchObject({ method: 'POST', body: JSON.stringify({ interface: 'eth0' }), credentials: 'same-origin' });
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});

test('the picker starts without a separate search setup action and retains manual verification guidance', () => {
  const markup = renderToStaticMarkup(createElement(NearbyServers, { onSelect: () => {} }));
  expect(markup).toContain('>Refresh</button>');
  expect(markup).not.toContain('>Search</button>');
  expect(markup).not.toContain('Find nearby servers');
  expect(markup).toContain('Verify the selected server');
  expect(markup).toContain('enter its address manually');
});

test('address-only results are visible but cannot select, rewrite a URL or start transfer', async () => {
  const hint: NearbyCandidate = {
    kind: 'address',
    id: 'c'.repeat(32),
    address: '192.168.1.3',
    port: 8080,
    expiresAt: candidate.expiresAt,
    verified: false,
  };
  const search = new NearbySearch(() => {}, {
    interfaces: async () => ({ available: true, interfaces: [eth] }),
    scan: async () => ({ available: true, candidates: [hint] }),
  });
  await search.show();
  expect(search.snapshot.candidates).toEqual([hint]);
  expect(search.choose(hint.id, 1)).toBeUndefined();
  let selections = 0;
  const markup = renderToStaticMarkup(createElement(NearbyResult, { item: hint, disabled: false, onSelect: () => selections++ }));
  expect(markup).toContain('192.168.1.3:8080');
  expect(markup).toContain('Unverified · HTTPS required');
  expect(markup).not.toContain('<button');
  expect(markup).not.toContain('href=');
  expect(markup).not.toContain('https://192.168.1.3');
  expect(selections).toBe(0);
  const secure = renderToStaticMarkup(createElement(NearbyResult, { item: candidate, disabled: false, onSelect: () => selections++ }));
  expect(secure).toContain('>Select</button>');
  expect(secure).toContain('Unverified');
});
