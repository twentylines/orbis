import { createContext } from 'react';
import type { ClusterContextValue } from './cluster';

export const ClusterContext = createContext<ClusterContextValue | null>(null);
