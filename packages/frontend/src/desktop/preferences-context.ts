import { createContext } from 'react';
import type { PreferenceContext } from './preferences';

export const DesktopPreferencesContext = createContext<PreferenceContext | null>(null);
