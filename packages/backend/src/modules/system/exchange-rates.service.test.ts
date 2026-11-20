import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExchangeRatesService, parseExchangeRates } from './exchange-rates.service';
const now = Date.parse('2026-11-19T08:00:00Z');
const xml = (date = '2026-11-18') =>
  `<?xml version="1.0"?><gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time='${date}'><Cube currency='PHP' rate='69.832'/><Cube currency='SGD' rate='1.4144'/></Cube></Cube></gesmes:Envelope>`;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('official ECB reference rates', () => {
  it('preserves decimal rates, EUR base and actual date/source', () => {
    expect(parseExchangeRates(xml(), now)).toMatchObject({
      base: 'EUR',
      source: 'ECB',
      asOf: '2026-11-18',
      rates: { EUR: '1', PHP: '69.832', SGD: '1.4144' },
    });
  });
  it('rejects entities, duplicate/malformed rates, oversize, impossible/future/expired dates', () => {
    for (const value of [
      xml().replace('<?xml version="1.0"?>', '<!DOCTYPE rates>'),
      `${xml()}<Cube currency="PHP" rate="1"/>`,
      xml().replace('69.832', '-1'),
      xml('2026-02-30'),
      xml('2026-12-01'),
      xml('2026-11-01'),
      xml() + ' '.repeat(33_000),
    ])
      expect(() => parseExchangeRates(value, now)).toThrow();
  });
  it('deduplicates concurrent reads and caches fixed-origin HTTPS fetches for an hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetcher = vi.fn(async () => new Response(xml()));
    vi.stubGlobal('fetch', fetcher);
    const service = new ExchangeRatesService();
    const results = await Promise.all([service.read(), service.read(), service.read()]);
    expect(results.every((result) => result.stale === false)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    await service.read();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('marks fallback cache stale on refresh failure, stops serving old data and limits outage retries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetcher = vi.fn(async () => new Response(xml()));
    vi.stubGlobal('fetch', fetcher);
    const service = new ExchangeRatesService();
    await service.read();
    vi.setSystemTime(now + 3_600_001);
    fetcher.mockRejectedValue(new Error('offline'));
    expect((await service.read()).stale).toBe(true);
    await service.read();
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now + 8 * 86_400_000);
    await expect(service.read()).rejects.toThrow('Exchange rates are unavailable');
  });
  it('rejects redirects, HTTP errors, unbounded streams and unavailable data without inventing rates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    for (const response of [
      new Response('redirect', { status: 302 }),
      new Response(xml(), { status: 503 }),
      new Response('x'.repeat(33_000)),
      new Response(xml(), { headers: { 'content-length': '50000' } }),
    ]) {
      const fetcher = vi.fn(async () => response);
      vi.stubGlobal('fetch', fetcher);
      const service = new ExchangeRatesService();
      await expect(service.read()).rejects.toThrow('Exchange rates are unavailable');
      await expect(service.read()).rejects.toThrow('Exchange rates are unavailable');
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
