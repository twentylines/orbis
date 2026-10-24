import { expect, test } from 'bun:test';
import { QueryObserver } from '@tanstack/react-query';
import { createAppQueryClient } from './query-client';

function watchedQueries() {
  const client = createAppQueryClient();
  const requests = { apps: 0, monitoring: 0 };
  const unsubscribe = (['apps', 'monitoring'] as const).map((key) => {
    client.setQueryData([key], 0);
    return new QueryObserver(client, {
      queryKey: [key],
      queryFn: () => ++requests[key],
      staleTime: Number.POSITIVE_INFINITY,
    }).subscribe(() => undefined);
  });
  client.setQueryData(['inactive'], 'retained');
  return {
    client,
    requests,
    close: () => {
      for (const stop of unsubscribe) stop();
      client.clear();
    },
  };
}

test('read-only reviews preserve active and inactive query caches', async () => {
  const scope = watchedQueries();
  try {
    const mutation = scope.client.getMutationCache().build(scope.client, {
      meta: { invalidates: false },
      mutationFn: async () => ({ planId: 'review-only' }),
    });
    expect(await mutation.execute(undefined)).toEqual({ planId: 'review-only' });
    await Bun.sleep(0);
    expect(scope.requests).toEqual({ apps: 0, monitoring: 0 });
    expect(
      scope.client
        .getQueryCache()
        .getAll()
        .every((query) => !query.state.isInvalidated),
    ).toBe(true);
    expect(scope.client.getQueryData<string>(['inactive'])).toBe('retained');
  } finally {
    scope.close();
  }
});

test('state-changing operations retain the existing global refresh', async () => {
  const scope = watchedQueries();
  try {
    await scope.client
      .getMutationCache()
      .build(scope.client, { mutationFn: async () => 'saved' })
      .execute(undefined);
    await Bun.sleep(0);
    expect(scope.requests).toEqual({ apps: 1, monitoring: 1 });
    expect(scope.client.getQueryCache().find({ queryKey: ['inactive'] })?.state.isInvalidated).toBe(true);
  } finally {
    scope.close();
  }
});

test('a review can still refresh its own resource explicitly', async () => {
  const scope = watchedQueries();
  try {
    await scope.client
      .getMutationCache()
      .build(scope.client, {
        meta: { invalidates: false },
        mutationFn: async () => 'reviewed',
        onSuccess: () => scope.client.invalidateQueries({ queryKey: ['apps'] }),
      })
      .execute(undefined);
    expect(scope.requests).toEqual({ apps: 1, monitoring: 0 });
    expect(scope.client.getQueryCache().find({ queryKey: ['inactive'] })?.state.isInvalidated).toBe(false);
  } finally {
    scope.close();
  }
});

test('failed reviews do not disturb unrelated caches', async () => {
  const scope = watchedQueries();
  try {
    const mutation = scope.client.getMutationCache().build(scope.client, {
      meta: { invalidates: false },
      mutationFn: async () => {
        throw new Error('Compatibility unavailable');
      },
    });
    await expect(mutation.execute(undefined)).rejects.toThrow('Compatibility unavailable');
    expect(scope.requests).toEqual({ apps: 0, monitoring: 0 });
  } finally {
    scope.close();
  }
});
