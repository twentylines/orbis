import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { HostTransferPanel, HostTransferWizard, ReceiveAccountVerification } from './host-transfer-panel';
import type { TransferJob, TransferSnapshot } from './transfer-api';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job: TransferJob = {
  id,
  importId: id,
  sourceOrigin: 'https://source.example.test',
  sourceFingerprint: 'a'.repeat(64),
  destinationFingerprint: 'b'.repeat(64),
  status: 'awaiting-source-approval',
  expiresAt: Date.now() + 60_000,
  completedBytes: 0,
  totalBytes: 1024,
  message: 'Compare fingerprints before starting.',
  requiresReview: true,
};
function render(snapshot: TransferSnapshot, operator = true, receive = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator } });
  client.setQueryData(['orbis-host-transfers', 7], snapshot);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <HostTransferWizard mode={receive ? 'receive' : 'both'} embedded={receive} />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}
test('destination waiting state exposes both full comparison values and an explicit native confirmation', () => {
  const markup = render({ offers: [], jobs: [job] });
  expect(markup).toContain('Destination fingerprint');
  expect(markup).toContain('Source fingerprint');
  expect(markup).toContain('name="confirm"');
  expect(markup).toContain('value="yes"');
  expect(markup).toContain('required=""');
  expect(markup).toContain('orbis-checkbox host-transfer-confirm');
  expect(markup).toContain('The source fingerprint matches, and I approved this destination on the source.');
  expect(markup).toContain('Start transfer');
  expect(markup).not.toContain('Review received backup');
  expect(markup).not.toContain('replace-server');
  expect(markup).not.toContain('claimToken');
});
test('receiving state shows actual byte progress and cancellation without a restore action', () => {
  const markup = render({ offers: [], jobs: [{ ...job, status: 'receiving', completedBytes: 512 }] });
  expect(markup).toContain('value="50"');
  expect(markup).toContain('Encrypted backup received');
  expect(markup).toContain('Cancel transfer');
  expect(markup).not.toContain('Review received backup');
});
test('completed receipt offers verification separately and source cards preserve both fingerprints after approval', () => {
  const markup = render({
    offers: [
      {
        id,
        backupId: id,
        sourceFingerprint: job.sourceFingerprint,
        destinationFingerprint: job.destinationFingerprint,
        status: 'approved',
        expiresAt: job.expiresAt,
        bytes: 1024,
        completedBytes: 0,
      },
    ],
    jobs: [{ ...job, status: 'complete', completedBytes: 1024 }],
  });
  expect(markup).toContain('Review received backup');
  expect(markup).toContain('value="100"');
  expect(markup).toContain('Source fingerprint');
  expect(markup).toContain('Destination fingerprint');
  expect(markup).not.toContain('replace-server');
});
test('receive starts with bounded source details and defers account verification within the embedded surface', () => {
  const markup = render({ offers: [], jobs: [] }, true, true);
  expect(markup).toContain('data-embedded="true"');
  expect(markup).toContain('Source server address');
  expect(markup).toContain('One-use transfer code');
  expect(markup).not.toContain('name="password"');
  expect(markup).not.toContain('name="confirm"');
  expect(markup).toContain('maxLength="64"');
  expect(markup).toContain('>Continue</button>');
  expect(markup).toContain('class="visually-hidden"');
  expect(markup).not.toContain('class="host-transfer-heading"');
  expect(markup).toContain('aria-label="Host transfer"');
  expect(markup).toContain('aria-labelledby=');
  expect(markup).toContain('Orbis-to-Orbis');
  expect(markup).toContain('Nearby servers');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('unverified address hints');
  expect(markup).not.toContain('>Cancel</button>');
  expect(markup).not.toContain('Discover');
});

test('source transfer screen offers optional collapsed visibility without opening a lease form automatically', () => {
  const markup = render({ offers: [], jobs: [] });
  expect(markup).toContain('Nearby visibility');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain('nearby-consent');
});
test('viewer accounts cannot render transfer controls', () => {
  expect(render({ offers: [], jobs: [job] }, false)).toBe('');
});

test('receive verification binds the chosen source and requires fresh local authentication and explicit review consent', () => {
  const markup = renderToStaticMarkup(
    <ReceiveAccountVerification source="https://source.example.test" code={'a'.repeat(64)} localCertificate disabled={false} />,
  );
  expect(markup).toContain('name="sourceOrigin" value="https://source.example.test"');
  expect(markup).toContain(`name="code" value="${'a'.repeat(64)}`);
  expect(markup).toContain('Local certificate fingerprint confirmed');
  expect(markup).toContain('name="password"');
  expect(markup).toContain('autoComplete="current-password"');
  expect(markup).toContain('type="password"');
  expect(markup).toContain('name="totpCode"');
  expect(markup).toContain('name="confirm"');
  expect(markup).toContain('required=""');
  expect(markup).toContain('I want to receive this backup for review on this server.');
  expect(markup).not.toContain('replace-server');
  expect(markup).not.toContain('trusted on this device');
  const busy = renderToStaticMarkup(
    <ReceiveAccountVerification source="https://source.example.test" code={'a'.repeat(64)} localCertificate={false} disabled />,
  );
  expect(busy).toContain('disabled=""');
  expect(busy).toContain('HTTPS certificate checked when connecting');
});

test('Settings offers a working restore window entry while retaining an unobtrusive source preparation path', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <HostTransferPanel />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  expect(markup).toContain('>Restore from another server</button>');
  expect(markup).toContain('Prepare this server as a source');
  expect(markup).not.toContain('Move to another server');
  expect(markup).not.toContain('Send from this server');
  expect(markup).not.toContain('name="password"');
});
