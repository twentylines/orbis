export type StorePreviewHistory = { storeReturnPath?: string; storePreviewDepth?: number };

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
