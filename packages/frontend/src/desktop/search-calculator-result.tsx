import { IconCalculator, IconCopy } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { KeyboardEventHandler } from 'react';
import { calculate } from './search-calculator';
import { currencyResult, inferLocalCurrency, isCurrencyCode, parseCurrencyQuery, readExchangeRates } from './search-currency';

type SearchCalculation = {
  detail: string;
  label?: string;
  copyValue?: string;
  error?: string;
  inferred?: string;
  waiting?: boolean;
  asOf?: string;
  sourceUrl?: string;
  stale?: boolean;
  approximation?: string;
  currency?: boolean;
};

export function useSearchCalculation(query: string, timeZone: string, locale: string, enabled: boolean): SearchCalculation | null {
  const deviceTimeZone = typeof window === 'undefined' ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = inferLocalCurrency(timeZone, locale, deviceTimeZone);
  const currency = parseCurrencyQuery(query, local);
  const calculation = currency ? null : calculate(query);
  const rates = useQuery({
    queryKey: ['orbis-search-exchange-rates'],
    queryFn: ({ signal }) => readExchangeRates(signal),
    enabled: enabled && currency !== null && currency.to !== null && isCurrencyCode(currency.from) && isCurrencyCode(currency.to),
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!enabled || (!currency && !calculation)) return null;
  if (currency) {
    const detail = `${currency.amount} ${currency.from}${currency.to ? ` → ${currency.to}` : ''}`;
    const inferred = currency.inferred && local ? `${currency.to} · ${local.reason}` : undefined;
    if (!currency.to) return { detail, currency: true, error: 'Choose a target currency.' };
    if (!isCurrencyCode(currency.from) || !isCurrencyCode(currency.to))
      return { detail, currency: true, error: 'Use a supported three-letter currency code, such as PHP or SGD.' };
    if (!rates.data)
      return {
        detail,
        currency: true,
        inferred,
        error: rates.isError ? 'Exchange rates are unavailable. Try again later.' : undefined,
        waiting: !rates.isError,
      };
    const result = currencyResult(currency, rates.data);
    const attribution = { asOf: rates.data.asOf, sourceUrl: rates.data.sourceUrl, stale: rates.data.stale || rates.isError };
    if ('error' in result) return { detail, currency: true, inferred, error: result.error, ...attribution };
    return { detail, currency: true, inferred, label: result.label, copyValue: result.label, ...attribution };
  }
  if (!calculation) return null;
  if ('error' in calculation) return { detail: query, error: calculation.error };
  return {
    detail: query,
    label: `${calculation.approximate ? '≈ ' : ''}${calculation.value}`,
    copyValue: calculation.value,
    approximation: calculation.approximate ? 'Rounded to 12 decimal places' : undefined,
  };
}
export function SearchCalculatorResult({
  result,
  onCopy,
  onKeyDown,
  message,
}: {
  result: NonNullable<ReturnType<typeof useSearchCalculation>>;
  onCopy: () => void;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
  message: string;
}) {
  return (
    <section className="desktop-search-calculator" aria-label="Calculator" aria-live="polite">
      <h3>
        <IconCalculator size={18} aria-hidden="true" />
        {result.currency ? 'Currency conversion' : 'Calculator'}
      </h3>
      {result.copyValue ? (
        <button type="button" data-search-result onClick={onCopy} onKeyDown={onKeyDown} aria-label={`Copy result: ${result.label}`}>
          <span className="desktop-search-calculation">
            <small>{result.detail}</small>
            <strong>{result.label}</strong>
          </span>
          <IconCopy size={21} aria-hidden="true" />
        </button>
      ) : (
        <div className="desktop-search-calculation-state">
          <small>{result.detail}</small>
          <p>{result.error ?? 'Loading exchange rates…'}</p>
        </div>
      )}
      {result.inferred ? <p>{result.inferred}</p> : null}
      {result.asOf ? (
        <p>
          <a href={result.sourceUrl} target="_blank" rel="noreferrer">
            ECB reference rates
          </a>{' '}
          · {result.asOf}
          {result.stale ? ' · Stale rates' : ''}. Estimate only; bank rates and fees differ.
        </p>
      ) : null}
      {result.approximation ? <p>{result.approximation}</p> : null}
      {result.copyValue ? <output>{message || 'Enter or click to copy result'}</output> : null}
    </section>
  );
}
