import type { UserContextDto } from '@/api-client';
import { userContextOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createContext, useContext, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { PreferenceSession } from '@/desktop/preference-save-queue';
import { clearAccountQueries } from '@/lib/query-client';

interface UserContextValue extends UserContextDto {
  refreshUserContext: () => Promise<void>;
  setUserContext: (newUserContext: Partial<UserContextDto>) => void;
  endSession: () => Promise<void>;
  sessionEpoch: object;
  sessionAbortSignal: AbortSignal;
}

const UserContext = createContext<UserContextValue | null>(null);

export const UserContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  const queryKey = userContextQueryKey();
  // Keep the existing session view during a transient restart; Suspense still handles initial failures.
  const { data: userContext } = useSuspenseQuery({ ...userContextOptions() });

  const [session, setSession] = useState(() => new PreferenceSession(userContext.isLoggedIn));
  const currentSession = useRef({ authenticated: userContext.isLoggedIn, session });
  const changeSession = useCallback((authenticated: boolean) => {
    currentSession.current.session.invalidate();
    const next = new PreferenceSession(authenticated);
    currentSession.current = { authenticated, session: next };
    setSession(next);
  }, []);

  useLayoutEffect(() => {
    if (currentSession.current.authenticated !== userContext.isLoggedIn) changeSession(userContext.isLoggedIn);
  }, [userContext.isLoggedIn, changeSession]);

  const refreshUserContext = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const value = {
    ...userContext,
    sessionEpoch: session.epoch,
    sessionAbortSignal: session.signal,
    refreshUserContext: refreshUserContext,
    endSession: () => {
      changeSession(false);
      return clearAccountQueries(queryClient, queryKey, { ...userContext, isLoggedIn: false });
    },
    setUserContext: (newUserContext: Partial<UserContextDto>) => {
      if (typeof newUserContext.isLoggedIn === 'boolean') changeSession(newUserContext.isLoggedIn);
      queryClient.setQueryData(queryKey, { ...userContext, ...newUserContext });
    },
  };

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
};

export const useUserContext = () => {
  const context = useContext(UserContext);
  if (context === null) {
    throw new Error('useUserContext must be used within an UserContextProvider');
  }
  return context;
};
