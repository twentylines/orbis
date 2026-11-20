import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchCalculatorResult, useSearchCalculation } from './search-calculator-result';
import { exchangeSource } from './search-currency';
function render(query: string, client = new QueryClient(), enabled = true) {
  function Subject() {
    const result = useSearchCalculation(query, 'Asia/Singapore', 'en-US', enabled);
    return result ? <SearchCalculatorResult result={result} onCopy={() => undefined} onKeyDown={() => undefined} message="" /> : null;
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Subject />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}
test('arithmetic result is the copyable keyboard result with a clear accessible name', () => {
  const html = render('0.1+0.2');
  expect(html).toContain('Copy result: 0.3');
  expect(html).toContain('data-search-result');
  expect(html).toContain('Enter or click to copy result');
});
test('ordinary app searches and inactive search create no calculator or rate requests', () => {
  expect(render('Jellyfin')).toBe('');
  expect(render('600PHP', new QueryClient(), false)).toBe('');
});
test('cached real rate data discloses currency inference, source/date and stale status', () => {
  const client = new QueryClient();
  client.setQueryData(['orbis-search-exchange-rates'], {
    base: 'EUR',
    source: 'ECB',
    sourceUrl: exchangeSource,
    asOf: '2026-11-18',
    stale: true,
    rates: { PHP: '69.832', SGD: '1.4144', EUR: '1' },
  });
  const html = render('600PHP', client);
  expect(html).toContain('Copy result: 12.15 SGD');
  expect(html).toContain('System time zone: Asia/Singapore');
  expect(html).toContain('2026-11-18');
  expect(html).toContain('Stale rates');
  expect(html).toContain('Estimate only');
});
test('pending rates and division errors have no misleading copy action', () => {
  expect(render('600PHP')).toContain('Loading exchange rates');
  const error = render('1/0');
  expect(error).toContain('Cannot divide by zero');
  expect(error).not.toContain('data-search-result');
});
