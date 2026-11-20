import { expect, test } from 'bun:test';
import { resolvePreviewCard } from './preview-card-anchor';

const card = (urn: string, connected = true, hidden = false, storeSuggestion?: string) =>
  ({ dataset: { storeApp: urn, storeSuggestion }, isConnected: connected, closest: () => (hidden ? {} : null) }) as unknown as HTMLElement;
const pane = (...cards: HTMLElement[]) =>
  ({ contains: (element: HTMLElement) => cards.includes(element), querySelectorAll: () => cards }) as unknown as HTMLElement;

test('duplicate app URNs retain the actual catalogue opener instead of jumping to the spotlight', () => {
  const spotlight = card('app:store');
  const catalogue = card('app:store');
  expect(resolvePreviewCard(pane(spotlight, catalogue), 'app:store', catalogue)).toBe(catalogue);
  expect(resolvePreviewCard(pane(spotlight, catalogue), 'app:store', spotlight)).toBe(spotlight);
});

test('removed, hidden, foreign and different-app openers fall back to a surviving visible matching card', () => {
  const surviving = card('app:store');
  for (const previous of [card('app:store', false), card('app:store', true, true), card('other:store'), card('app:store')]) {
    expect(resolvePreviewCard(pane(surviving), 'app:store', previous)).toBe(surviving);
  }
  expect(resolvePreviewCard(pane(card('app:other-store'), card('app:store', true, true)), 'app:store')).toBeNull();
});

test('browser history selects the opener source for a same-app preview, even when the previous opener still exists', () => {
  const urn = 'app:store';
  const spotlight = card(urn, true, false, 'spotlight');
  const recommendation = card(urn, true, false, 'recommendation');
  const catalogue = card(urn);
  const cataloguePane = pane(spotlight, recommendation, catalogue);
  expect(resolvePreviewCard(cataloguePane, urn, catalogue, 'spotlight')).toBe(spotlight);
  expect(resolvePreviewCard(cataloguePane, urn, spotlight, 'recommendation')).toBe(recommendation);
  expect(resolvePreviewCard(cataloguePane, urn, spotlight, null)).toBe(catalogue);
  expect(resolvePreviewCard(pane(catalogue), urn, null, 'recommendation')).toBe(catalogue);
});
