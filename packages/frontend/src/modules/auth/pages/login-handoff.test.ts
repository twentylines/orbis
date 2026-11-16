import { expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';

async function sessionQuery() {
  const client = createAppQueryClient();
  let authenticated = false;
  let requests = 0;
  const queryKey = ['verified-sign-in-session'];
  const options = {
    queryKey,
    queryFn: async () => {
      requests++;
      return { isLoggedIn: authenticated };
    },
    staleTime: Number.POSITIVE_INFINITY,
  };
  await client.fetchQuery(options);
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => undefined);
  return {
    client,
    queryKey,
    requests: () => requests,
    authenticate: () => {
      authenticated = true;
    },
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
}

test('ordinary successful mutations still refetch active queries before their local success callback', async () => {
  const h = await sessionQuery();
  try {
    let requestsAtLocalSuccess = 0;
    const mutation = h.client.getMutationCache().build(h.client, {
      mutationFn: async () => {
        h.authenticate();
        return { success: true };
      },
      onSuccess: () => {
        requestsAtLocalSuccess = h.requests();
      },
    });
    await mutation.execute(undefined);
    expect(requestsAtLocalSuccess).toBe(2);
    expect(h.client.getQueryData<{ isLoggedIn: boolean }>(h.queryKey)).toEqual({ isLoggedIn: true });
  } finally {
    h.close();
  }
});

test('verified sign-in can hold the unauthenticated view through the visible handoff before refreshing its session', async () => {
  const h = await sessionQuery();
  let finishHandoff: () => void = () => undefined;
  const handoff = new Promise<void>((resolve) => {
    finishHandoff = resolve;
  });
  let enteredSuccess: () => void = () => undefined;
  const successEntered = new Promise<void>((resolve) => {
    enteredSuccess = resolve;
  });
  try {
    const mutation = h.client.getMutationCache().build(h.client, {
      meta: { invalidates: false },
      mutationFn: async () => {
        h.authenticate();
        return { success: true };
      },
      onSuccess: async () => {
        enteredSuccess();
        await handoff;
        await h.client.invalidateQueries({ queryKey: h.queryKey });
      },
    });
    const signingIn = mutation.execute(undefined);
    await successEntered;
    expect(h.requests()).toBe(1);
    expect(h.client.getQueryData<{ isLoggedIn: boolean }>(h.queryKey)).toEqual({ isLoggedIn: false });
    expect(mutation.state.status).toBe('pending');
    finishHandoff();
    await signingIn;
    expect(h.requests()).toBe(2);
    expect(h.client.getQueryData<{ isLoggedIn: boolean }>(h.queryKey)).toEqual({ isLoggedIn: true });
    expect(mutation.state.status).toBe('success');
  } finally {
    finishHandoff();
    h.close();
  }
});
