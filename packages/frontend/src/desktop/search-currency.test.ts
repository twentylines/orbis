import { afterEach, expect, mock, test } from 'bun:test';
import { currencyResult, exchangeSource, inferLocalCurrency, parseCurrencyQuery, readExchangeRates, type ExchangeRates } from './search-currency';
const rates: ExchangeRates = {
  base: 'EUR',
  source: 'ECB',
  sourceUrl: exchangeSource,
  asOf: '2026-11-18',
  stale: false,
  rates: { EUR: '1', PHP: '69.832', SGD: '1.4144', JPY: '174.85' },
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test('Singapore system time zone takes precedence over browser or user language', () => {
  expect(inferLocalCurrency('Asia/Singapore', 'en-US')).toEqual({ code: 'SGD', reason: 'System time zone: Asia/Singapore' });
  expect(inferLocalCurrency('Asia/Manila', 'en-SG')?.code).toBe('PHP');
  expect(inferLocalCurrency('UTC', 'en-SG')?.code).toBe('SGD');
  expect(inferLocalCurrency('UTC', 'en', 'Asia/Singapore')).toEqual({ code: 'SGD', reason: 'Device time zone: Asia/Singapore' });
  expect(inferLocalCurrency('UTC', 'en')).toBeNull();
  expect(inferLocalCurrency('UTC', 'broken-locale-@')).toBeNull();
});
test('compact, case-insensitive, explicit source/target and default currency syntax', () => {
  const local = inferLocalCurrency('Asia/Singapore', 'en');
  for (const query of ['600PHP', '600 php', 'PHP 600'])
    expect(parseCurrencyQuery(query, local)).toEqual({ amount: '600', from: 'PHP', to: 'SGD', inferred: true });
  for (const query of ['600 PHP to JPY', '600PHP in jpy', 'PHP600→JPY', '600PHP=JPY'])
    expect(parseCurrencyQuery(query, local)).toEqual({ amount: '600', from: 'PHP', to: 'JPY', inferred: false });
  expect(parseCurrencyQuery('600 PHP', null)?.to).toBeNull();
  expect(parseCurrencyQuery('600PHP to SGD', null)?.to).toBe('SGD');
  for (const query of ['nextcloud', 'app1', 'syn123', '600', '1+1', 'PHP 600 extra', '600 $', '1e3PHP'])
    expect(parseCurrencyQuery(query, local)).toBeNull();
});
test('reference cross-rate conversions round to the currency minor unit and never approximate unsupported codes', () => {
  expect(currencyResult({ amount: '600', from: 'PHP', to: 'SGD', inferred: true }, rates)).toEqual({ value: '12.15', label: '12.15 SGD' });
  expect(currencyResult({ amount: '1', from: 'EUR', to: 'JPY', inferred: false }, rates)).toEqual({ value: '175', label: '175 JPY' });
  expect(currencyResult({ amount: '600', from: 'PHP', to: 'XYZ', inferred: false }, rates)).toHaveProperty('error');
});
test('same-origin authenticated rate request validates real feed metadata and fails clearly for old backends', async () => {
  const fetcher = mock(async (_url: RequestInfo | URL, _options?: RequestInit) => Response.json(rates));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(await readExchangeRates()).toEqual(rates);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/system/exchange-rates');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
  globalThis.fetch = mock(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
  await expect(readExchangeRates()).rejects.toThrow('unavailable');
  globalThis.fetch = mock(async () => Response.json({ ...rates, rates: { PHP: '-1' } })) as unknown as typeof fetch;
  await expect(readExchangeRates()).rejects.toThrow('verified');
});
