import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { startExport } from './backup-api';
import type { BackupSnapshot, ImportJob, RestoreJob } from './contracts';
import { BackupEncryptionFields, backupEncryptionPassphrase, SystemBackupsSettings } from './system-backups-settings';

function render(
  job: RestoreJob | null = null,
  embedded = true,
  recoveryActions?: React.ReactNode,
  imports: ImportJob[] = [],
  initialImportId?: string,
  statusError = false,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true, totpEnabled: true } });
  const snapshot: BackupSnapshot = {
    exports: { available: true, retentionHours: 24, jobs: [] },
    imports: { available: true, retentionHours: 24, jobs: imports },
    restore: { job },
  };
  const queryKey = ['orbis-full-backups', 7];
  client.setQueryData(queryKey, snapshot);
  if (statusError)
    client
      .getQueryCache()
      .find({ queryKey })
      ?.setState({ error: new Error('Status unavailable.'), status: 'error', fetchStatus: 'idle' });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <SystemBackupsSettings restoreOnly={embedded} embedded={embedded} recoveryActions={recoveryActions} initialImportId={initialImportId} />
      </AppContextProvider>
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}
const selectedImport: ImportJob = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: 1,
  updatedAt: 2,
  message: 'Selected import ready.',
  status: 'reviewed',
  stage: 'complete',
  completedBytes: 128,
  totalBytes: 128,
  uploadedBytes: 128,
  review: {
    formatVersion: 1,
    createdAt: 2,
    orbisVersion: '1.0.0',
    runtipiVersion: '1.0.0',
    architecture: 'arm64',
    fileCount: 1,
    appCount: 0,
    expandedBytes: 128,
    manifestSha256: 'a'.repeat(64),
    databaseValidation: 'validated',
    compatibility: { compatible: true, blockers: [], architectureChanged: false },
  },
  reviewExpiresAt: Date.now() + 60_000,
};
const unrelatedImport: ImportJob = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  createdAt: 3,
  updatedAt: 4,
  message: 'Unrelated older import.',
  status: 'uploaded',
  stage: 'complete',
  completedBytes: 64,
  totalBytes: 64,
  uploadedBytes: 64,
};

test('guided onboarding keeps the selected restore actionable and hides unrelated import history', () => {
  const markup = render(null, true, undefined, [selectedImport, unrelatedImport], selectedImport.id);
  expect(markup).toContain('class="visually-hidden"');
  expect(markup).not.toContain('class="system-backups-heading"');
  expect(markup).toContain('aria-labelledby=');
  expect(markup).toContain('Selected import ready.');
  expect(markup).toContain('Backup details');
  expect(markup).not.toContain('Uploaded backups');
  expect(markup).not.toContain('Unrelated older import.');
  expect(markup).toContain('>Restore</button>');
  expect(markup.match(/>Restore<\/button>/g)).toHaveLength(1);
});

test('ordinary backup settings still show all uploaded import history', () => {
  const markup = render(null, false, undefined, [selectedImport, unrelatedImport]);
  expect(markup).toContain('Full backup &amp; recovery');
  expect(markup).toContain('Selected import ready.');
  expect(markup).toContain('Unrelated older import.');
});

test('guided onboarding retains Refresh when backup status fails', () => {
  const markup = render(null, true, undefined, [selectedImport], selectedImport.id, true);
  expect(markup).toContain('class="system-backups-heading"');
  expect(markup).toContain('>Refresh</button>');
  expect(markup).toContain('Status unavailable.');
});

test('embedded upload uses a real separate file button, aligned filename status and fresh authentication', () => {
  const markup = render();
  expect(markup).toContain('noValidate=""');
  expect(markup).toContain('name="password"');
  expect(markup).toContain('name="totpCode"');
  expect(markup).toContain('required=""');
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
  expect(markup).toContain('>Cancel</button>');
  expect(markup).not.toContain('>Choose file</button>');
  expect(markup).toContain('data-embedded="true"');
  expect(markup).not.toContain('value="100"');
});

function encryptionValues(password: string, passphrase = '', repeatPassphrase = passphrase) {
  const values = new FormData();
  values.set('password', password);
  values.set('passphrase', passphrase);
  values.set('repeatPassphrase', repeatPassphrase);
  return values;
}
test('account-password encryption uses the exact submitted fresh password and retains the existing strength policy', () => {
  const password = '  example account password  ';
  expect(backupEncryptionPassphrase(encryptionValues(password, 'ignored separate phrase'), 'export', true)).toBe(password);
  for (const value of ['short', ' '.repeat(20), 'x'.repeat(11), 'x'.repeat(1025)]) {
    expect(() => backupEncryptionPassphrase(encryptionValues(value), 'export', true)).toThrow('Choose a separate backup passphrase');
  }
  expect(backupEncryptionPassphrase(encryptionValues('x'.repeat(12)), 'export', true)).toBe('x'.repeat(12));
  expect(backupEncryptionPassphrase(encryptionValues('x'.repeat(1024)), 'export', true)).toHaveLength(1024);
});
test('separate encryption and legacy restore never silently substitute the local account password', () => {
  const values = encryptionValues('different local password', 'original encryption phrase');
  expect(backupEncryptionPassphrase(values, 'export', false)).toBe('original encryption phrase');
  expect(backupEncryptionPassphrase(values, 'review', true)).toBe('original encryption phrase');
  expect(() =>
    backupEncryptionPassphrase(
      encryptionValues('different local password', 'original encryption phrase', 'mismatched confirmation'),
      'export',
      false,
    ),
  ).toThrow('did not match');
  expect(() => backupEncryptionPassphrase(encryptionValues('different local password', ''), 'review', true)).toThrow('between 12 and 1024');
});
test('the default encryption choice explains immutable backup passwords and the explicit fallback retains confirmation', () => {
  const main = renderToStaticMarkup(<BackupEncryptionFields id="encryption" useAccountPassword disabled={false} onChange={() => {}} />);
  expect(main).toContain('Use my account password to encrypt this backup');
  expect(main).toContain('checked=""');
  expect(main).toContain('Changing your account password later won’t change this backup.');
  expect(main).not.toContain('name="passphrase"');
  const fallback = renderToStaticMarkup(<BackupEncryptionFields id="encryption" useAccountPassword={false} disabled onChange={() => {}} />);
  expect(fallback).toContain('name="passphrase"');
  expect(fallback).toContain('name="repeatPassphrase"');
  expect(fallback).toContain('minLength="12"');
  expect(fallback).toContain('maxLength="1024"');
  expect(fallback).toContain('disabled=""');
});
test('new account-encrypted backups use the existing authenticated same-origin export contract without URL or storage changes', async () => {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: 1,
        updatedAt: 1,
        message: 'Preparing.',
        completedBytes: 0,
        totalBytes: null,
        status: 'running',
        stage: 'preparing',
        needsRecovery: false,
        restartRequired: false,
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    const password = 'example account password';
    const values = encryptionValues(password);
    await startExport({ password, totpCode: '123456' }, backupEncryptionPassphrase(values, 'export', true));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/system-backups/export');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ password, totpCode: '123456', passphrase: password });
  } finally {
    globalThis.fetch = original;
  }
});
test('Settings retains backup actions without exposing an inline credential expander', () => {
  const markup = render(null, false);
  expect(markup).toContain('>Create</button>');
  expect(markup).toContain('>Restore</button>');
  expect(markup).not.toContain('name="password"');
  expect(markup).not.toContain('name="passphrase"');
  expect(markup).not.toContain('<form');
});

test('server restore actions are grouped within full backup and recovery, without appearing inside setup', () => {
  const action = (
    <section aria-label="Restore from another server">
      <button type="button">Restore from another server</button>
    </section>
  );
  const settings = render(null, false, action);
  expect(settings).toContain('aria-label="Restore from another server"');
  expect(settings.lastIndexOf('Restore from another server')).toBeLessThan(settings.lastIndexOf('</section>'));
  expect(render(null, true, action)).not.toContain('aria-label="Restore from another server"');
});
