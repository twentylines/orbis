import { expect, test } from 'bun:test';
import { commandSearchSuggestion } from './command-search-suggestion';
import { calculate } from './search-calculator';
import { inferLocalCurrency, isCurrencyCode, parseCurrencyQuery } from './search-currency';

const draws = (...values: number[]) => {
  let index = 0;
  return () => values[index++] ?? 0;
};

test('the arithmetic examples are directly accepted by the search calculator', () => {
  const examples = [0, 0.25, 0.5, 0.75].map((choice) => commandSearchSuggestion(undefined, undefined, draws(0, choice)));
  expect(new Set(examples).size).toBe(4);
  for (const example of examples) expect(calculate(example)).toHaveProperty('value');
});

test('currency examples use distinct known codes and prefer an inferred target without assuming an unknown region', () => {
  const local = inferLocalCurrency('UTC', 'en', 'Asia/Singapore') ?? undefined;
  const conversion = parseCurrencyQuery(commandSearchSuggestion(undefined, local?.code, draws(0.6, 0.9, 0.5)), null);
  expect(conversion).toMatchObject({ to: 'SGD', inferred: false });
  expect(conversion?.from).not.toBe(conversion?.to);
  expect(isCurrencyCode(conversion?.from ?? '')).toBe(true);

  const unknown = inferLocalCurrency('UTC', 'en') ?? undefined;
  const fallback = [0, 0.4, 0.8].map((choice) =>
    parseCurrencyQuery(commandSearchSuggestion(undefined, unknown?.code, draws(0.65, choice, 0.1, choice)), null),
  );
  expect(new Set(fallback.map((pair) => pair?.to)).size).toBe(3);
  expect(new Set(fallback.map((pair) => pair?.amount)).size).toBe(3);
  for (const pair of fallback) {
    expect(pair?.inferred).toBe(false);
    expect(isCurrencyCode(pair?.to ?? '')).toBe(true);
    expect(isCurrencyCode(pair?.from ?? '')).toBe(true);
    expect(pair?.from).not.toBe(pair?.to);
  }
});

test('pending or unavailable apps leave utility choices, and cached available names participate on the next draw', () => {
  const disabled = { info: { name: 'Unavailable app', available: false } };
  const blank = { info: { name: ' ', available: true } };
  for (const installed of [undefined, [], [disabled, blank]]) {
    expect(parseCurrencyQuery(commandSearchSuggestion(installed, 'GBP', draws(0.9)), null)).toMatchObject({ to: 'GBP' });
  }

  const available = { info: { name: '  Jellyfin  ', available: true } };
  const different = { info: { name: 'Paperless-ngx', available: true } };
  const installed = [disabled, available, blank, available, different];
  expect(commandSearchSuggestion(installed, 'GBP', draws(0.9, 0))).toBe('Jellyfin');
  expect(commandSearchSuggestion(installed, 'GBP', draws(0.9, 0.9))).toBe('Paperless-ngx');
  expect(calculate(commandSearchSuggestion(installed, 'GBP', draws(0.1)))).toHaveProperty('value');
  expect(parseCurrencyQuery(commandSearchSuggestion(installed, 'GBP', draws(0.45)), null)).toMatchObject({ to: 'GBP' });
});

test('accessible settings participate with utilities and cached apps without replacing either category', () => {
  const installed = [{ info: { name: 'Jellyfin', available: true } }];
  const settings = ['Automatic Orbis updates', 'Text size', 'Text size', ' '];
  expect(commandSearchSuggestion(undefined, 'SGD', draws(0.9, 0), settings)).toBe('Automatic Orbis updates');
  expect(commandSearchSuggestion(installed, 'SGD', draws(0.99, 0.9), settings)).toBe('Text size');
  expect(commandSearchSuggestion(installed, 'SGD', draws(0.6), settings)).toBe('Jellyfin');
  expect(calculate(commandSearchSuggestion(installed, 'SGD', draws(0), settings))).toHaveProperty('value');
  expect(parseCurrencyQuery(commandSearchSuggestion(installed, 'SGD', draws(0.3), settings), null)).toMatchObject({ to: 'SGD' });
});
