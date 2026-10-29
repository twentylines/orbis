import { expect, test } from 'bun:test';
import { confirmedSourceCertificate, displayCertificateFingerprint, readSourceCertificate, sourceCertificateLimit } from './source-certificate';

const der = Uint8Array.from([0x30, 0x02, 0x01, 0x00]);
const encoded = btoa(String.fromCharCode(...der));
const pem = `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`;
const file = (text: string, size = new TextEncoder().encode(text).length) => ({ size, text: async () => text });

test('fingerprints exact DER bytes without pretending to validate its authority or granting consent', async () => {
  const result = await readSourceCertificate(file(pem));
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', der)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  expect(result).toEqual({ pem, sha256: expected, confirmed: false });
  expect(displayCertificateFingerprint(expected)).toMatch(/^[A-F0-9]{2}(?::[A-F0-9]{2}){31}$/);
  expect(() => confirmedSourceCertificate(result)).toThrow('Compare the certificate fingerprint');
  expect(confirmedSourceCertificate({ ...result, confirmed: true })).toEqual({
    sourceCertificatePem: pem,
    sourceCertificateSha256: expected,
    confirmSourceCertificate: true,
  });
});

test('refuses private-key material, extra blocks, malformed encoding and unrelated data', async () => {
  for (const text of [
    pem + pem,
    `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
    `unrelated\n${pem}`,
    `${pem}unrelated`,
    pem.replace(encoded, '!!!!'),
    pem.replace(encoded, 'AA=='),
  ]) {
    await expect(readSourceCertificate(file(text))).rejects.toThrow();
  }
});

test('enforces the byte limit before reading and retains normal trusted certificate flows', async () => {
  let read = false;
  await expect(
    readSourceCertificate({
      size: sourceCertificateLimit + 1,
      text: async () => {
        read = true;
        return pem;
      },
    }),
  ).rejects.toThrow('64 KB');
  expect(read).toBe(false);
  await expect(readSourceCertificate(file(''))).rejects.toThrow();
  expect(confirmedSourceCertificate(null)).toEqual({});
});

test('ordinary private HTTP fingerprints a locally checked public PEM through same-origin inspection without granting confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const sha256 = new Bun.CryptoHasher('sha256').update(der).digest('hex');
  const calls: { url: unknown; options?: RequestInit }[] = [];
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
      calls.push({ url, options });
      return Response.json({ sha256 });
    }) as unknown as typeof fetch;
    const inspected = await readSourceCertificate(file(pem));
    expect(inspected).toEqual({ pem, sha256, confirmed: false });
    expect(() => confirmedSourceCertificate(inspected)).toThrow('Compare');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/system-backups/transfers/certificates/fingerprint');
    expect(calls[0]?.options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.options?.body))).toEqual({ certificatePem: pem });
    expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    for (const text of [pem + pem, `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`, `${pem}trailing`])
      await expect(readSourceCertificate(file(text))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('HTTP inspection rejects authentication errors, malformed/bloated fingerprints, redirects and failed requests', async () => {
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    for (const response of [
      Response.json({}, { status: 403 }),
      Response.json({ sha256: 'bad' }),
      Response.json({ sha256: 'a'.repeat(64), confirmed: true }),
      new Response('x'.repeat(257)),
    ]) {
      globalThis.fetch = (async () => response) as unknown as typeof fetch;
      await expect(readSourceCertificate(file(pem))).rejects.toThrow();
    }
    globalThis.fetch = (async () => {
      const value = Response.json({ sha256: 'a'.repeat(64) });
      Object.defineProperty(value, 'redirected', { value: true });
      return value;
    }) as unknown as typeof fetch;
    await expect(readSourceCertificate(file(pem))).rejects.toThrow();
    globalThis.fetch = (async () => {
      throw new Error('private connection detail');
    }) as unknown as typeof fetch;
    await expect(readSourceCertificate(file(pem))).rejects.toThrow('Could not inspect the public certificate');
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
