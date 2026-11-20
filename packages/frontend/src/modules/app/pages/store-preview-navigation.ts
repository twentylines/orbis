import type { Location } from 'react-router';
import { recommendationCategories, type RecommendationCategory } from '../components/store-discover/store-recommendations';

export type StoreSuggestion = { kind: 'spotlight'; urn: string } | { kind: 'recommendation'; urn: string; category: RecommendationCategory };
export type StorePreviewHistory = { storeReturnPath?: string; storePreviewDepth?: number; storeSuggestion?: StoreSuggestion };
export type AppPreviewHistory = StorePreviewHistory & { appsReturnPath?: string; appsPreviewDepth?: number };

export function storeReturnPath(state: StorePreviewHistory | null, search: string) {
  if (typeof state?.storeReturnPath === 'string' && /^\/app-store(?:\?[^#]*)?$/.test(state.storeReturnPath)) return state.storeReturnPath;
  const params = new URLSearchParams(search);
  const filters = new URLSearchParams();
  const store = params.get('store');
  if (store) filters.set('store', store);
  if (params.get('view') === 'apps') filters.set('view', 'apps');
  return `/app-store${filters.size ? `?${filters}` : ''}`;
}

export function storePreviewDepth(state: StorePreviewHistory | null) {
  const value = state?.storePreviewDepth;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 50 ? value : 0;
}

export function storePreviewSuggestion(state: StorePreviewHistory | null, urn: string | null | undefined): StoreSuggestion | null {
  const suggestion = state?.storeSuggestion;
  if (!urn || suggestion?.urn !== urn) return null;
  if (suggestion.kind === 'spotlight') return suggestion;
  return suggestion.kind === 'recommendation' && recommendationCategories.some(({ category }) => category === suggestion.category)
    ? suggestion
    : null;
}

export function nextStorePreviewHistory(
  state: StorePreviewHistory | null,
  search: string,
  insidePreview = false,
  suggestion?: StoreSuggestion | null,
): StorePreviewHistory {
  const depth = storePreviewDepth(state);
  return {
    storeReturnPath: storeReturnPath(state, search),
    storePreviewDepth: depth ? (depth < 50 ? depth + 1 : 0) : insidePreview ? 0 : 1,
    ...(suggestion ? { storeSuggestion: suggestion } : {}),
  };
}

export function storePreviewLinkProps(location: Location, urn: string, suggestion?: StoreSuggestion) {
  const [appId, storeId] = urn.split(':');
  const pathname = `/app-store/${encodeURIComponent(storeId ?? '')}/${encodeURIComponent(appId ?? '')}`;
  const state = location.state as StorePreviewHistory | null;
  const current = storePreviewSuggestion(state, urn);
  const sameSuggestion =
    current?.kind === suggestion?.kind &&
    (current?.kind !== 'recommendation' || (suggestion?.kind === 'recommendation' && current.category === suggestion.category));
  // The same app can have different openers at the same URL. Keep history for an opener change.
  const replace = pathname === location.pathname && !location.hash && sameSuggestion;
  return {
    to: `${pathname}${location.search}`,
    state: replace ? state : nextStorePreviewHistory(state, location.search, location.pathname.startsWith('/app-store/'), suggestion),
    replace,
  };
}

export function appsReturnPath(state: AppPreviewHistory | null, search: string) {
  const saved = state?.appsReturnPath;
  const source = typeof saved === 'string' && /^\/apps(?:\?[^#]*)?$/.test(saved) ? saved.slice('/apps'.length) : search;
  const params = new URLSearchParams(source);
  const filters = new URLSearchParams();
  for (const key of ['q', 'category', 'sort']) {
    const value = params.get(key);
    if (value) filters.set(key, value);
  }
  return `/apps${filters.size ? `?${filters}` : ''}`;
}

export function appsPreviewDepth(state: AppPreviewHistory | null) {
  const value = state?.appsPreviewDepth;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 50 ? value : 0;
}

export function nextAppsPreviewHistory(state: AppPreviewHistory | null, search: string, insidePreview = false): AppPreviewHistory {
  const depth = appsPreviewDepth(state);
  return { appsReturnPath: appsReturnPath(state, search), appsPreviewDepth: depth ? (depth < 50 ? depth + 1 : 0) : insidePreview ? 0 : 1 };
}
