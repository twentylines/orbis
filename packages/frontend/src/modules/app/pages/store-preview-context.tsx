import { createContext, useContext } from 'react';
import type { AppPreviewHistory } from './store-preview-navigation';

export type StorePreview = {
  closePath: string;
  split: boolean;
  selectedUrn: string | null;
  previewId: string;
  close: () => void;
  nextHistory: () => AppPreviewHistory;
};
export const StorePreviewContext = createContext<StorePreview | null>(null);
export const useStorePreview = () => useContext(StorePreviewContext);
