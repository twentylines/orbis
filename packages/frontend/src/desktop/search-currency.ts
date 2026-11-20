import { convertCurrency } from './search-calculator';

export type LocalCurrency = { code: string; reason: string };
const regions: Record<string, string> = {
  SG: 'SGD',
  PH: 'PHP',
  US: 'USD',
  GB: 'GBP',
  AU: 'AUD',
  NZ: 'NZD',
  CA: 'CAD',
  JP: 'JPY',
  CN: 'CNY',
  HK: 'HKD',
  IN: 'INR',
  MY: 'MYR',
  TH: 'THB',
  ID: 'IDR',
  KR: 'KRW',
  CH: 'CHF',
  NO: 'NOK',
  SE: 'SEK',
  DK: 'DKK',
  IS: 'ISK',
  CZ: 'CZK',
  HU: 'HUF',
  PL: 'PLN',
  RO: 'RON',
  TR: 'TRY',
  ZA: 'ZAR',
  BR: 'BRL',
  MX: 'MXN',
  IL: 'ILS',
  AT: 'EUR',
  BE: 'EUR',
  HR: 'EUR',
  CY: 'EUR',
  EE: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  DE: 'EUR',
  GR: 'EUR',
  IE: 'EUR',
  IT: 'EUR',
  LV: 'EUR',
  LT: 'EUR',
  LU: 'EUR',
  MT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  SK: 'EUR',
  SI: 'EUR',
  ES: 'EUR',
};
const zones: Record<string, string> = {
  'Asia/Singapore': 'SGD',
  'Asia/Manila': 'PHP',
  'Asia/Tokyo': 'JPY',
  'Asia/Shanghai': 'CNY',
  'Asia/Hong_Kong': 'HKD',
  'Asia/Kolkata': 'INR',
  'Asia/Calcutta': 'INR',
  'Asia/Kuala_Lumpur': 'MYR',
  'Asia/Kuching': 'MYR',
  'Asia/Bangkok': 'THB',
  'Asia/Jakarta': 'IDR',
  'Asia/Makassar': 'IDR',
  'Asia/Jayapura': 'IDR',
  'Asia/Seoul': 'KRW',
  'Asia/Jerusalem': 'ILS',
  'Europe/London': 'GBP',
  'Europe/Zurich': 'CHF',
  'Europe/Oslo': 'NOK',
  'Europe/Stockholm': 'SEK',
  'Europe/Copenhagen': 'DKK',
  'Europe/Prague': 'CZK',
  'Europe/Budapest': 'HUF',
  'Europe/Warsaw': 'PLN',
  'Europe/Bucharest': 'RON',
  'Europe/Istanbul': 'TRY',
  'Africa/Johannesburg': 'ZAR',
  'Pacific/Auckland': 'NZD',
  'Atlantic/Reykjavik': 'ISK',
  ...Object.fromEntries(
    [
      'Paris',
      'Berlin',
      'Rome',
      'Madrid',
      'Amsterdam',
      'Brussels',
      'Vienna',
      'Dublin',
      'Lisbon',
      'Helsinki',
      'Athens',
      'Tallinn',
      'Riga',
      'Vilnius',
      'Luxembourg',
      'Malta',
      'Bratislava',
      'Ljubljana',
      'Zagreb',
    ].map((city) => [`Europe/${city}`, 'EUR']),
  ),
  'Asia/Nicosia': 'EUR',
};
function currencyForZone(timeZone: string): string | undefined {
  const zoneCurrency =
    zones[timeZone] ??
    (timeZone.startsWith('Australia/') ? 'AUD' : undefined) ??
    ([
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Anchorage',
      'Pacific/Honolulu',
      'America/Detroit',
      'America/Phoenix',
    ].includes(timeZone)
      ? 'USD'
      : undefined) ??
    (['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns'].includes(timeZone)
      ? 'CAD'
      : undefined);
  return zoneCurrency;
}
export function inferLocalCurrency(timeZone: string, locale: string, deviceTimeZone?: string): LocalCurrency | null {
  const deviceCurrency = deviceTimeZone ? currencyForZone(deviceTimeZone) : undefined;
  if (deviceCurrency) return { code: deviceCurrency, reason: `Device time zone: ${deviceTimeZone?.replaceAll('_', ' ')}` };
  const zoneCurrency = currencyForZone(timeZone);
  if (zoneCurrency) return { code: zoneCurrency, reason: `System time zone: ${timeZone.replaceAll('_', ' ')}` };
  try {
    const region = new Intl.Locale(locale).region;
    if (region && regions[region]) return { code: regions[region], reason: `Language region: ${region}` };
  } catch {
    /* A locale with no known region must not imply a currency. */
  }
  return null;
}
const knownCurrencies = new Set(Intl.supportedValuesOf('currency'));
export const isCurrencyCode = (code: string) => knownCurrencies.has(code);
export type CurrencyRequest = { amount: string; from: string; to: string | null; inferred: boolean };
export function parseCurrencyQuery(query: string, local: LocalCurrency | null): CurrencyRequest | null {
  if (query.length > 160) return null;
  const match = query
    .trim()
    .match(
      /^(?:([A-Za-z]{3})\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))|([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([A-Za-z]{3}))(?:\s*(?:to|in|→|=)\s*([A-Za-z]{3}))?$/i,
    );
  const amount = match?.[2] ?? match?.[3];
  const from = match?.[1] ?? match?.[4];
  if (!match || !amount || !from || (!match[5] && !isCurrencyCode(from.toUpperCase()))) return null;
  return {
    amount,
    from: from.toUpperCase(),
    to: match[5]?.toUpperCase() ?? local?.code ?? null,
    inferred: !match[5],
  };
}
export type ExchangeRates = { base: 'EUR'; asOf: string; source: 'ECB'; sourceUrl: string; stale: boolean; rates: Record<string, string> };
export const exchangeSource = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
export async function readExchangeRates(signal?: AbortSignal): Promise<ExchangeRates> {
  const response = await fetch('/api/system/exchange-rates', {
    credentials: 'same-origin',
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error('Exchange rates are unavailable. Try again later.');
  const value = await response.json();
  if (
    !value ||
    value.base !== 'EUR' ||
    value.source !== 'ECB' ||
    value.sourceUrl !== exchangeSource ||
    typeof value.stale !== 'boolean' ||
    typeof value.asOf !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf) ||
    !value.rates ||
    typeof value.rates !== 'object' ||
    Array.isArray(value.rates) ||
    Object.keys(value.rates).length > 64 ||
    Object.entries(value.rates).some(
      ([code, rate]) => !/^[A-Z]{3}$/.test(code) || typeof rate !== 'string' || !/^\d{1,8}(?:\.\d{1,8})?$/.test(rate) || Number(rate) <= 0,
    )
  )
    throw new Error('Exchange rates could not be verified.');
  return value;
}
export function currencyResult(request: CurrencyRequest, rates: ExchangeRates): { value: string; label: string } | { error: string } {
  if (!request.to) return { error: 'Choose a target currency.' };
  const from = rates.rates[request.from];
  const to = rates.rates[request.to];
  if (!from || !to) return { error: `ECB reference rates do not support ${from ? request.to : request.from}. Choose another currency.` };
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: request.to }).resolvedOptions().maximumFractionDigits ?? 2;
    const value = convertCurrency(request.amount, from, to, digits);
    return { value, label: `${value} ${request.to}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'This amount could not be converted.' };
  }
}
