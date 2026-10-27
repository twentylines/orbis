import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppQueryClient } from '@/lib/query-client';
import { OrbisUpdateIcon } from './orbis-update-notice';

test('the update icon stays active during submission and stops after a rejected request', async () => {
  const client = createAppQueryClient();
  let rejectRequest: ((error: Error) => void) | undefined;
  const request = new Promise<never>((_resolve, reject) => {
    rejectRequest = reject;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ['orbis-compatibility', 'update', 1, 'v1.1.0', 'apply'],
    mutationFn: () => request,
    retry: false,
  });
  const submitted = mutation.execute(undefined).catch(() => undefined);
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <OrbisUpdateIcon />
      </QueryClientProvider>,
    );
  expect(render()).toContain('orbis-update-spinning');
  rejectRequest?.(new Error('Declared request failure'));
  await submitted;
  expect(render()).not.toContain('orbis-update-spinning');
  client.clear();
});

test('a compatibility review alone does not spin the update icon', async () => {
  const client = createAppQueryClient();
  let finish: (() => void) | undefined;
  const request = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ['orbis-compatibility', 'update', 1, 'v1.1.0'],
    mutationFn: () => request,
  });
  const submitted = mutation.execute(undefined);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <OrbisUpdateIcon />
    </QueryClientProvider>,
  );
  expect(markup).not.toContain('orbis-update-spinning');
  finish?.();
  await submitted;
  client.clear();
});
