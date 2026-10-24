import { MutationCache, QueryClient } from '@tanstack/react-query';

export function createAppQueryClient() {
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_data, _variables, _context, mutation) => {
        if (mutation.meta?.invalidates === false) return;
        void queryClient.invalidateQueries();
      },
    }),
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  return queryClient;
}
