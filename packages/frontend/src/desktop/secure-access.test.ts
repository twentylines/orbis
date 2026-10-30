import { afterEach, expect, test } from 'bun:test';
import {
  safeReturnTo,
  secureAccessOrigin,
  publicSecureAccessOrigin,
  readLocalCertificate,
  secureAccessEntryPath,
  secureAccessPath,
} from './secure-access';

test('keeps protected routes and queries through sign-in without allowing external returns', () => {
  expect(safeReturnTo('/settings?tab=security&secure_setup=1')).toBe('/settings?tab=security&secure_setup=1');
  expect(new URL(secureAccessEntryPath, 'https://orbis.example').searchParams.get('return_to')).toBe(secureAccessPath);
  expect(safeReturnTo('/apps/store/my-app?section=logs#latest')).toBe('/apps/store/my-app?section=logs#latest');
  for (const value of [
    null,
    '',
    '//external.example',
    'https://external.example',
    '/\\external.example',
    '/login',
    '/api/auth/logout',
    '/settings/../../external',
    '/settings\n',
    `/settings/${'x'.repeat(2048)}`,
  ])
    expect(safeReturnTo(value)).toBeNull();
});

test('only offers configured HTTPS hostnames, with standard ports omitted', () => {
  expect(secureAccessOrigin('orbis.home.example')).toBe('https://orbis.home.example');
  expect(secureAccessOrigin('ORBIS.home.example', 8443)).toBe('https://orbis.home.example:8443');
  expect(secureAccessOrigin('orbis.lan', 443)).toBe('https://orbis.lan');
  for (const name of [
    '',
    'orbis.invalid',
    'localhost',
    '192.168.0.10',
    '0x7f000001',
    '[::1]',
    'https://home.example',
    'user@home.example',
    'home.example:443',
    'home.example/path',
    'home.example?key=value',
    'home.example#section',
    'home.example%',
    '-bad.example',
    'bad-.example',
  ])
    expect(secureAccessOrigin(name)).toBeNull();
  for (const port of [0, 65536, '443', Number.NaN]) expect(secureAccessOrigin('orbis.lan', port)).toBeNull();
  expect(publicSecureAccessOrigin('orbis.example.net')).toBe('https://orbis.example.net');
  for (const name of ['tipi.local', 'orbis.lan', 'orbis.home.arpa', 'orbis.internal', 'orbis.test', 'orbis.onion'])
    expect(publicSecureAccessOrigin(name)).toBeNull();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('downloads only a bounded public certificate response and preserves cancellation', async () => {
  const signal = new AbortController().signal;
  const certificate = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n';
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_url, init) => {
    request = init;
    return new Response(certificate);
  }) as typeof fetch;
  expect(await (await readLocalCertificate(signal)).text()).toBe(certificate);
  expect(request?.signal).toBe(signal);
  expect(request?.credentials).toBe('same-origin');
  for (const [body, status] of [
    ['', 404],
    ['<html>Login required</html>', 200],
    [`${certificate}PRIVATE KEY`, 200],
    ['x'.repeat(65537), 200],
  ] as const) {
    globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
    await expect(readLocalCertificate(signal)).rejects.toThrow();
  }
});

test('public certificate stream stops at64KiB and rejects noncertificate trailing instructions', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40000));
      controller.enqueue(new Uint8Array(40000));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = Object.assign(async () => new Response(body), { preconnect: originalFetch.preconnect });
  await expect(readLocalCertificate(new AbortController().signal)).rejects.toThrow('exceeds');
  expect(cancelled).toBe(true);
  const cert = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n';
  for (const content of [`${cert}run this command`, `<html>${cert}</html>`]) {
    globalThis.fetch = Object.assign(async () => new Response(content), { preconnect: originalFetch.preconnect });
    await expect(readLocalCertificate(new AbortController().signal)).rejects.toThrow('usable public certificate');
  }
});
