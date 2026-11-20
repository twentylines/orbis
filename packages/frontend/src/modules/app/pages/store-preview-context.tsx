import { createContext, useContext, type ReactNode } from 'react';
import type { AppPreviewHistory, StoreSuggestion } from './store-preview-navigation';

export type StorePreview = {
  closePath: string;
  split: boolean;
  selectedUrn: string | null;
  suggestion?: StoreSuggestion | null;
  onCardMount: (card: HTMLAnchorElement | null) => void;
  onDetailsMount: (element: HTMLDivElement | null) => void;
  previewId: string;
  close: () => void;
  nextHistory: () => AppPreviewHistory;
  openPanel?: (title: string, content: ReactNode) => void;
  closePanel?: () => void;
};
export const StorePreviewContext = createContext<StorePreview | null>(null);
export const useStorePreview = () => useContext(StorePreviewContext);
