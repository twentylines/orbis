/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider, useAppContext } from '@/context/app-context';
import { createAppQueryClient } from '@/lib/query-client';
import { sessionSystemHealth } from './system-health-store';

test('a new authenticated provider cannot reuse health state even when the account query cache is retained', () => {
  const client = createAppQueryClient();
  client.setQueryData(appContextQueryKey(), { user: { id: 1 } });
  const identities: object[] = [];
  function ReadSession() {
    identities.push(useAppContext().sessionIdentity);
    return null;
  }
  const renderSession = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AppContextProvider>
          <ReadSession />
          <ReadSession />
        </AppContextProvider>
      </QueryClientProvider>,
    );
  renderSession();
  const previous = identities[0];
  if (!previous) throw new Error('Session identity was not provided');
  expect(identities[1]).toBe(previous);
  const oldStore = sessionSystemHealth(previous, 1, '/api/system/telemetry');
  renderSession();
  const current = identities[2];
  if (!current) throw new Error('New session identity was not provided');
  expect(identities[3]).toBe(current);
  expect(current).not.toBe(previous);
  const newStore = sessionSystemHealth(current, 1, '/api/system/telemetry');
  expect(newStore).not.toBe(oldStore);
  expect(newStore.getSnapshot()).toEqual({});
  expect(client.getQueryData<{ user: { id: number } }>(appContextQueryKey())).toEqual({ user: { id: 1 } });
  client.clear();
});
