import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const feed = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const sourceUrl = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
const bodyLimit = 32_768;
const refreshAfter = 60 * 60 * 1000;
const retryAfter = 60_000;
const day = 86_400_000;
type Rates = { base: 'EUR'; asOf: string; source: 'ECB'; sourceUrl: string; rates: Record<string, string> };

/** Parse only the bounded daily ECB vocabulary, without resolving XML entities. */
export function parseExchangeRates(xml: string, now = Date.now()): Rates {
  if (xml.length > bodyLimit || /<!/i.test(xml) || !xml.includes('http://www.ecb.int/vocabulary/2002-08-01/eurofxref'))
    throw new Error('Invalid rate feed');
  const dates = [...xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/g)];
  if (dates.length !== 1) throw new Error('Invalid rate date');
  const asOf = dates[0]?.[1];
  if (!asOf) throw new Error('Invalid rate date');
  const date = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== asOf || date > now + day || now - date > 7 * day)
    throw new Error('Outdated rate feed');
  const rates: Record<string, string> = { EUR: '1' };
  const rows = [...xml.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d{1,8}(?:\.\d{1,8})?)['"]\s*\/>/g)];
  if (rows.length < 2 || rows.length > 63 || (xml.match(/\bcurrency\s*=/g) ?? []).length !== rows.length) throw new Error('Invalid rate rows');
  for (const row of rows) {
    const code = row[1];
    const rate = row[2];
    if (!code || !rate || Object.hasOwn(rates, code) || Number(rate) <= 0) throw new Error('Invalid rate');
    rates[code] = rate;
  }
  return { base: 'EUR', asOf, source: 'ECB', sourceUrl, rates };
}
async function readBoundedBody(response: Response) {
  if (Number(response.headers.get('content-length')) > bodyLimit || !response.body) throw new Error('Invalid rate response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > bodyLimit) throw new Error('Rate response too large');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
@Injectable()
export class ExchangeRatesService {
  private cache: { rates: Rates; fetchedAt: number } | null = null;
  private inFlight: Promise<void> | null = null;
  private nextAttempt = 0;

  async read() {
    const now = Date.now();
    if ((!this.cache || now - this.cache.fetchedAt >= refreshAfter) && now >= this.nextAttempt) {
      if (!this.inFlight) {
        this.nextAttempt = now + retryAfter;
        this.inFlight = this.refresh().finally(() => {
          this.inFlight = null;
        });
      }
      await this.inFlight;
    } else if (this.inFlight) await this.inFlight;
    const cache = this.cache;
    if (!cache || Date.now() - Date.parse(`${cache.rates.asOf}T00:00:00Z`) > 7 * day)
      throw new ServiceUnavailableException('Exchange rates are unavailable. Try again later.');
    return {
      ...cache.rates,
      stale: Date.now() - cache.fetchedAt >= refreshAfter || Date.now() - Date.parse(`${cache.rates.asOf}T00:00:00Z`) > 4 * day,
    };
  }
  private async refresh() {
    try {
      // No caller-controlled origin, query, redirect, credentials or cookies leave the server.
      const response = await fetch(feed, { redirect: 'error', signal: AbortSignal.timeout(6000), headers: { Accept: 'application/xml, text/xml' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Rate service unavailable');
      }
      const rates = parseExchangeRates(await readBoundedBody(response));
      this.cache = { rates, fetchedAt: Date.now() };
      this.nextAttempt = Date.now() + refreshAfter;
    } catch {
      // Preserve only bounded, dated last-known rates; read() marks fallback data as stale.
    }
  }
}
