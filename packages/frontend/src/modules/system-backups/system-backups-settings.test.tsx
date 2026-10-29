import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import type { BackupSnapshot, RestoreJob } from './contracts';
import { SystemBackupsSettings } from './system-backups-settings';

function render(job: RestoreJob | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true, totpEnabled: true } });
  const snapshot: BackupSnapshot = {
    exports: { available: true, retentionHours: 24, jobs: [] },
    imports: { available: true, retentionHours: 24, jobs: [] },
    restore: { job },
  };
  client.setQueryData(['orbis-full-backups', 7], snapshot);
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <SystemBackupsSettings restoreOnly embedded />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}
test('embedded upload uses a real separate file button, aligned filename status and fresh authentication', () => {
  const markup = render();
  expect(markup).toContain('>Choose file</button>');
  expect(markup).toContain('No file chosen');
  expect(markup).toContain('type="file"');
  expect(markup).toContain('class="visually-hidden"');
  expect(markup).toContain('accept=".orbis,application/octet-stream"');
  expect(markup).toContain('name="password"');
  expect(markup).toContain('name="totpCode"');
  expect(markup).toContain('>Continue</button>');
  expect(markup).not.toContain('>Back</button>');
  expect(markup).not.toContain('>Cancel</button>');
  expect(markup).not.toContain('>Upload encrypted backup</button>');
});
test('restore remains in the embedded card with real preparation progress and recovery controls', () => {
  const markup = render({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'running',
    stage: 'preparing',
    phase: 'preparing',
    message: 'Checking the archive.',
    needsRecovery: false,
    progressUnavailable: false,
    canCancel: true,
    canRecover: false,
    preparation: { stage: 'files', completedBytes: 512, totalBytes: 1024, records: 0, totalRecords: null },
  });
  expect(markup).toContain('recovery-flight');
  expect(markup).toContain('value="50"');
  expect(markup).toContain('Cancel and recover');
  expect(markup).not.toContain('>Choose file</button>');
  expect(markup).toContain('data-embedded="true"');
  expect(markup).not.toContain('value="100"');
});
