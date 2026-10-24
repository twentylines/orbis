export type StorePreviewHistory = { storeReturnPath?: string; storePreviewDepth?: number };
export type AppPreviewHistory = StorePreviewHistory & { appsReturnPath?: string; appsPreviewDepth?: number };

export function storeReturnPath(state: StorePreviewHistory | null, search: string) {
  if (typeof state?.storeReturnPath === 'string' && /^\/app-store(?:\?[^#]*)?$/.test(state.storeReturnPath)) return state.storeReturnPath;
  const store = new URLSearchParams(search).get('store');
  return store ? `/app-store?${new URLSearchParams({ store })}` : '/app-store';
}

export function storePreviewDepth(state: StorePreviewHistory | null) {
  const value = state?.storePreviewDepth;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 50 ? value : 0;
}

export function nextStorePreviewHistory(state: StorePreviewHistory | null, search: string, insidePreview = false): StorePreviewHistory {
  const depth = storePreviewDepth(state);
  return { storeReturnPath: storeReturnPath(state, search), storePreviewDepth: depth ? (depth < 50 ? depth + 1 : 0) : insidePreview ? 0 : 1 };
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
