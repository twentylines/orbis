import type { AppContextDto } from '@/api-client';
import { appContextOptions, appContextQueryKey, systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { type QueryClient, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { patchAppContext } from './app-context-cache';

interface AppContextValue extends AppContextDto {
  refreshAppContext: () => Promise<void>;
  setAppContext: (newAppContext: Partial<AppContextDto>) => void;
  sessionIdentity: object;
}

const AppContext = createContext<AppContextValue | null>(null);

const prefetch = (queryClient: QueryClient) => {
  void queryClient.prefetchQuery(systemLoadOptions());
};

export const AppContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const sessionIdentity = useRef({}).current;

  useEffect(() => {
    prefetch(queryClient);
  }, [queryClient]);

  // Suspense handles an initial failure; cached context keeps the desktop usable during a server restart.
  const { data: appContext } = useSuspenseQuery({ ...appContextOptions() });

  const refreshAppContext = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
  }, [queryClient]);

  const setAppContext = useCallback(
    (patch: Partial<AppContextDto>) => {
      patchAppContext(queryClient, patch, appContext);
    },
    [queryClient, appContext],
  );

  const value = useMemo(
    () => ({
      ...appContext,
      sessionIdentity,
      refreshAppContext,
      setAppContext,
    }),
    [appContext, sessionIdentity, refreshAppContext, setAppContext],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useAppContext must be used within an AppContextProvider');
  }
  return context;
};
