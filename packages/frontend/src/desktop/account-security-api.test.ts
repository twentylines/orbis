import { afterEach, expect, mock, test } from 'bun:test';
import { readAccountSecurity, saveAccountSecurity } from './account-security-api';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test('account policy transport uses the current session and sends fresh proof only when explicitly provided', async () => {
  const fetcher = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ version: 1, revision: 1, requireCaptureAuthentication: true }),
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const signal = new AbortController().signal;
  await readAccountSecurity(signal);
  await saveAccountSecurity({ expectedRevision: 0, requireCaptureAuthentication: true }, {}, signal);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/account-security');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 0, requireCaptureAuthentication: true });
  await saveAccountSecurity(
    { expectedRevision: 1, requireCaptureAuthentication: false },
    { password: 'unit-test-proof', totpCode: '123456' },
    signal,
  );
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
    expectedRevision: 1,
    requireCaptureAuthentication: false,
    password: 'unit-test-proof',
    totpCode: '123456',
  });
});
