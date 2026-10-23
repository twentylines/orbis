import { createContext, useContext } from 'react';

export type StorePreview = { closePath: string; split: boolean; selectedUrn: string | null; close: () => void };
export const StorePreviewContext = createContext<StorePreview | null>(null);
export const useStorePreview = () => useContext(StorePreviewContext);
