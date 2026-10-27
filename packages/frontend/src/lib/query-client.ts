import { hashKey, MutationCache, QueryClient, type QueryKey } from '@tanstack/react-query';

export async function clearAccountQueries(client: QueryClient, sessionKey: QueryKey, signedOutSession: unknown) {
  await client.cancelQueries();
  const sessionHash = hashKey(sessionKey);
  client.removeQueries({ predicate: (query) => query.queryHash !== sessionHash });
  client.getMutationCache().clear();
  client.setQueryData(sessionKey, signedOutSession);
}

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
