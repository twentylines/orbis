import { createContext, useContext } from 'react';

export const WindowVisibilityContext = createContext(true);
export const useWindowVisible = () => useContext(WindowVisibilityContext);
