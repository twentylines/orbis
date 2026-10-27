import type { UserContextDto } from '@/api-client';
import { userContextOptions, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { clearAccountQueries } from '@/lib/query-client';

interface UserContextValue extends UserContextDto {
  refreshUserContext: () => Promise<void>;
  setUserContext: (newUserContext: Partial<UserContextDto>) => void;
  endSession: () => Promise<void>;
}

const UserContext = createContext<UserContextValue | null>(null);

export const UserContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();

  const queryKey = userContextQueryKey();
  // Keep the existing session view during a transient restart; Suspense still handles initial failures.
  const { data: userContext } = useSuspenseQuery({ ...userContextOptions() });

  const refreshUserContext = async () => {
    await queryClient.invalidateQueries({ queryKey });
  };

  const value = {
    ...userContext,
    refreshUserContext: refreshUserContext,
    endSession: () => clearAccountQueries(queryClient, queryKey, { ...userContext, isLoggedIn: false }),
    setUserContext: (newUserContext: Partial<UserContextDto>) => {
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
