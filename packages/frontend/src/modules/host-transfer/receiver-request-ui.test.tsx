import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { DesktopTaskLink } from '@/desktop/desktop-task-link';
import {
  ReceiverRequestProvider,
  RestoreRequestsContext,
  emptyRestoreRequests,
  pendingRestoreRequests,
  requestPollingAllowed,
  restoreRequestPresentation,
  RestoreRequestNoticeState,
} from './receiver-request-context';
import { RestoreRequestApiError } from './receiver-request-api';
import { ReceiverRequestWizard, receiverRequestHoldsWindow, dismissUnavailableRequest } from './receiver-request-wizard';
import { SourceRestoreRequests } from './source-restore-requests';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incoming = {
  version: 1 as const,
  id,
  nonce: id,
  sourceFingerprint: 'a'.repeat(64),
  destinationFingerprint: 'b'.repeat(64),
  status: 'awaiting-approval' as const,
  expiresAt: Date.now() + 60000,
  totalBytes: null,
  completedBytes: 0,
};
const snapshot = { ...emptyRestoreRequests, incoming: [incoming] };
const context = { authority: {}, snapshot, pendingCount: 1, available: true, error: null, refresh: () => {}, remember: () => {}, review: () => {} };
function render(child: React.ReactNode, provider = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, username: 'operator', operator: true }, userSettings: { domain: 'orbis.home.arpa' } });
  client.setQueryData(['tasks'], { tasks: [] });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AppContextProvider>
            {provider ? (
              <ReceiverRequestProvider>{child}</ReceiverRequestProvider>
            ) : (
              <RestoreRequestsContext.Provider value={context}>{child}</RestoreRequestsContext.Provider>
            )}
          </AppContextProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}
test('receiver source screen starts with discovery/manual HTTPS without code preparation', () => {
  const markup = render(<ReceiverRequestWizard />);
  expect(markup).toContain('noValidate=""');
  expect(markup).toContain('name="sourceOrigin"');
  expect(markup).toContain('required=""');
  expect(markup).toContain('Source private HTTPS address');
  expect(markup).toContain('Its operator will approve');
  expect(markup).not.toContain('one-use');
  expect(markup).not.toContain('Create code');
  expect(markup).not.toContain('name="code"');
  expect(markup).toContain('Continue');
});
test('resumable requests stay collapsed and only eligible requests are counted', () => {
  const outgoing = (requestId: string, status: 'awaiting-source-approval' | 'complete', expiresAt: number) => ({
    version: 1 as const,
    id: requestId,
    importId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sourceOrigin: 'https://source.home.arpa',
    sourceFingerprint: 'a'.repeat(64),
    destinationFingerprint: 'b'.repeat(64),
    status,
    expiresAt,
    totalBytes: status === 'complete' ? 52 : null,
    completedBytes: status === 'complete' ? 52 : 0,
    message: '',
    requiresReview: true as const,
    canStart: false,
    ...(status === 'complete' ? { encryption: 'source-account-password' as const } : {}),
  });
  const markup = render(
    <RestoreRequestsContext.Provider
      value={{
        ...context,
        snapshot: {
          ...snapshot,
          outgoing: [
            outgoing('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'awaiting-source-approval', Date.now() + 60_000),
            outgoing('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'complete', Date.now() + 120_000),
            outgoing('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'complete', 1),
          ],
        },
      }}
    >
      <ReceiverRequestWizard />
    </RestoreRequestsContext.Provider>,
  );
  expect(markup).toContain('Resume (2)');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain('aria-controls=');
  expect(markup).not.toContain('source.home.arpa');
  expect(markup).not.toContain('Available until');
});
test('one pending request is one normal task badge and real review row, never a duplicate unread alert', () => {
  const markup = render(
    <>
      <DesktopTaskLink />
      <SourceRestoreRequests />
    </>,
  );
  expect(markup).toContain('1 pending restore request');
  expect(markup).toContain('>1</span>');
  expect(markup).not.toContain('data-alert="true"');
  expect(markup).toContain('A destination is waiting for approval');
  expect(markup).toContain('>View request</button>');
});
test('source requests have no empty setup card', () => {
  const markup = render(
    <RestoreRequestsContext.Provider value={{ ...context, snapshot: emptyRestoreRequests, pendingCount: 0 }}>
      <SourceRestoreRequests />
    </RestoreRequestsContext.Provider>,
  );
  expect(markup).toBe('');
});
test('ordinary private HTTP without browser crypto can mount the global provider and keeps navigation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    expect(render(<span>Navigation remains available</span>, true)).toContain('Navigation remains available');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
test('one visible operator query stops on unsupported API/auth failures and source expiry is not a UI timer grant', () => {
  for (const status of [401, 403, 404]) expect(requestPollingAllowed(true, true, new RestoreRequestApiError(status))).toBe(false);
  expect(requestPollingAllowed(false, true, null)).toBe(false);
  expect(requestPollingAllowed(true, false, null)).toBe(false);
  expect(requestPollingAllowed(true, true, null)).toBe(true);
  expect(pendingRestoreRequests({ ...snapshot, incoming: [{ ...incoming, expiresAt: 1 }] })).toHaveLength(0);
  const source = readFileSync(new URL('./receiver-request-context.tsx', import.meta.url), 'utf8');
  expect(source.match(/useQuery\(/g)).toHaveLength(1);
  for (const boundary of ['sessionIdentity', 'user?.id', 'user?.username', 'user?.operator', 'window.location.origin'])
    expect(source).toContain(boundary);
  expect(source).not.toContain('crypto.');
});

test.each([401, 403, 404, 503])('successful cached requests followed by %s withhold counts/rows and dismiss the old notice', (status) => {
  const notice = new RestoreRequestNoticeState();
  const before = restoreRequestPresentation(snapshot, true, false);
  expect(before.pending).toHaveLength(1);
  expect(notice.update(before.snapshot, true).request?.id).toBe(id);
  expect(notice.update(before.snapshot, true).request).toBeUndefined();
  const failure = restoreRequestPresentation(snapshot, true, true);
  expect(failure.snapshot.incoming).toEqual([]);
  expect(failure.pending).toHaveLength(0);
  expect(notice.update(failure.snapshot, false)).toEqual({ dismiss: true, request: undefined });
  expect(notice.size).toBe(0);
  const markup = render(
    <RestoreRequestsContext.Provider value={{ ...context, snapshot: failure.snapshot, pendingCount: failure.pending.length, available: false }}>
      <DesktopTaskLink />
      <SourceRestoreRequests />
    </RestoreRequestsContext.Provider>,
  );
  expect(markup).not.toContain('pending restore request');
  expect(markup).not.toContain('>View request</button>');
  expect(markup).not.toContain('desktop-task-count');
  expect(requestPollingAllowed(true, true, new RestoreRequestApiError(status))).toBe(status === 503);
  expect(notice.update(before.snapshot, true).request?.id).toBe(id);
});
test('seen request IDs are bounded by current records and notices use a real aligned button', () => {
  const notice = new RestoreRequestNoticeState();
  for (let batch = 0; batch < 50; batch++) {
    const records = Array.from({ length: 16 }, (_, index) => ({ ...incoming, id: `${batch}:${index}` }));
    notice.update({ ...snapshot, incoming: records }, true);
    expect(notice.size).toBe(16);
  }
  notice.update(emptyRestoreRequests, true);
  expect(notice.size).toBe(0);
  const source = readFileSync(new URL('./receiver-request-context.tsx', import.meta.url), 'utf8');
  expect(source).toContain('variant="outline"');
  const css = readFileSync(new URL('./receiver-request-panel.css', import.meta.url), 'utf8');
  expect(css).toContain('justify-content: center');
  expect(css).toContain('min-height: 44px');
});

test('unavailable API releases only the local waiting window and clears credentials without claiming remote cancellation', () => {
  const waiting = {
    ...incoming,
    importId: id,
    sourceOrigin: 'https://source.home.arpa',
    status: 'awaiting-source-approval' as const,
    message: 'Waiting.',
    requiresReview: true as const,
    canStart: false,
  };
  expect(receiverRequestHoldsWindow(waiting, false, true)).toBe(true);
  expect(receiverRequestHoldsWindow(waiting, true, false)).toBe(false);
  let password = 'local credential';
  let aborted = false;
  let active = true;
  let closed = false;
  expect(
    dismissUnavailableRequest(
      false,
      () => {
        password = '';
        aborted = true;
      },
      (value) => {
        active = value;
      },
      () => {
        closed = true;
      },
    ),
  ).toBe(true);
  expect({ password, aborted, active, closed }).toEqual({ password: '', aborted: true, active: false, closed: true });
  expect(
    dismissUnavailableRequest(
      true,
      () => {
        throw new Error('Must use authenticated cancellation');
      },
      undefined,
      undefined,
    ),
  ).toBe(false);
  const markup = render(
    <RestoreRequestsContext.Provider value={{ ...context, snapshot: emptyRestoreRequests, pendingCount: 0, available: false }}>
      <ReceiverRequestWizard />
    </RestoreRequestsContext.Provider>,
  );
  expect(markup).toContain('remote cancellation has not been confirmed');
  expect(markup).toContain('>Cancel</button>');
  expect(markup).not.toContain('name="password"');
  expect(markup).not.toContain('name="totpCode"');
  expect(markup).not.toContain('Continue');
  const source = readFileSync(new URL('./receiver-request-wizard.tsx', import.meta.url), 'utf8');
  expect(source).toContain("stage !== 'review'");
});
