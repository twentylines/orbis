import type { StoreSuggestion } from './store-preview-navigation';

/** Preserve the actual opener when an app appears in both discovery and the catalogue. */
export function resolvePreviewCard(
  pane: HTMLElement,
  urn: string,
  preferred?: HTMLElement | null,
  suggestion?: StoreSuggestion['kind'] | null,
): HTMLElement | null {
  const matchesApp = (card: HTMLElement) => card.dataset.storeApp === urn && !card.closest('[hidden],[inert]');
  const matchesSuggestion = (card: HTMLElement) => suggestion === undefined || (card.dataset.storeSuggestion ?? null) === suggestion;
  const previous = preferred?.isConnected && pane.contains(preferred) && matchesApp(preferred) ? preferred : null;
  if (previous && matchesSuggestion(previous)) return previous;
  const cards = [...pane.querySelectorAll<HTMLElement>('[data-store-app]')].filter(matchesApp);
  return cards.find(matchesSuggestion) ?? previous ?? cards[0] ?? null;
}
