import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { AppContextProvider } from '@/context/app-context';
import { startExport } from './backup-api';
import { Dialog, retainDialogChildren } from '@/components/ui/Dialog/Dialog';
import { backupRemovalContents, BackupRemoveTrigger } from './backup-removal-confirmation';
import { placeBackupRemoval, restoreBackupRemovalFocus } from './backup-removal-position';
import type { BackupSnapshot, ExportJob, ImportJob, RestoreJob } from './contracts';
import {
  BackupDownloadReady,
  BackupEncryptionFields,
  BackupArchiveKeyFields,
  BackupFormError,
  prepareBackupSubmission,
  backupEncryptionPassphrase,
  SystemBackupsSettings,
} from './system-backups-settings';

function render(
  job: RestoreJob | null = null,
  embedded = true,
  recoveryActions?: React.ReactNode,
  imports: ImportJob[] = [],
  initialImportId?: string,
  statusError = false,
  exports: ExportJob[] = [],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true, totpEnabled: true } });
  const snapshot: BackupSnapshot = {
    exports: { available: true, retentionHours: 24, jobs: exports },
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

const completedExport: ExportJob = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  createdAt: 1,
  updatedAt: 2,
  message: 'Complete.',
  status: 'succeeded',
  stage: 'complete',
  completedBytes: 128,
  totalBytes: 128,
  needsRecovery: false,
  restartRequired: false,
};
test('a completed backup exposes one clear Download action for saving the encrypted archive locally', () => {
  const markup = render(null, false, undefined, [], undefined, false, [completedExport]);
  expect(markup).toContain('Save the encrypted backup to your computer.');
  expect(markup.match(/>Download<\/button>/g)).toHaveLength(1);
  expect(markup).toContain('system-backups-download-ready');
  expect(markup).not.toContain('/download');
  expect(markup).not.toContain('Download requested.');
});
test('download readiness stays absent for unfinished or failed exports and disabled while status is uncertain', () => {
  for (const status of ['running', 'failed', 'cancelled', 'interrupted'] as const)
    expect(
      renderToStaticMarkup(
        <BackupDownloadReady
          job={{ ...completedExport, status }}
          disabled={false}
          onDownload={() => {
            throw new Error('Unexpected action.');
          }}
        />,
      ),
    ).toBe('');
  const markup = renderToStaticMarkup(
    <BackupDownloadReady
      job={completedExport}
      disabled
      onDownload={() => {
        throw new Error('Unexpected action.');
      }}
    />,
  );
  expect(markup).toContain('disabled=""');
  expect(markup).toContain('Download');
  expect(markup).not.toContain('password');
});

type SubmitOptions = Parameters<typeof prepareBackupSubmission>[2];
function submitFixture(values: FormData) {
  const secrets = ['password', 'totpCode', 'passphrase', 'repeatPassphrase'].map((name) => ({ name, value: String(values.get(name) ?? '') }));
  const selectedFile = { name: 'encrypted.orbis', size: 100 };
  const calls: string[] = [];
  const form = {
    querySelectorAll(selector: string) {
      calls.push(selector);
      return secrets as unknown as NodeListOf<HTMLInputElement>;
    },
    reset() {
      throw new Error('The complete draft must not be reset.');
    },
  };
  const options: SubmitOptions = {
    kind: 'export',
    totpEnabled: false,
    useAccountPassword: false,
    archiveKeyMode: null,
    fileValid: true,
    restoreValid: true,
  };
  return { form, secrets, selectedFile, calls, options };
}
test('actual submit preparation rejects missing fresh auth before clearing any draft or selected file', () => {
  for (const [password, code, required, field] of [
    ['', '', false, 'password'],
    ['x'.repeat(1025), '', false, 'password'],
    ['local password', '', true, 'totpCode'],
    ['local password', '12345', true, 'totpCode'],
    ['local password', '123 56', false, 'totpCode'],
  ] as const) {
    const values = encryptionValues(password, 'separate backup key');
    values.set('totpCode', code);
    const fixture = submitFixture(values);
    const before = fixture.secrets.map((entry) => entry.value);
    try {
      prepareBackupSubmission(fixture.form, values, { ...fixture.options, totpEnabled: required });
      throw new Error('Expected local validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BackupFormError);
      expect((error as BackupFormError).field).toBe(field);
    }
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.secrets.map((entry) => entry.value)).toEqual(before);
    expect(fixture.selectedFile).toEqual({ name: 'encrypted.orbis', size: 100 });
  }
});
test('local key mismatch, missing explicit legacy mode, file and restore confirmation leave all secrets intact', () => {
  for (const [change, values, field] of [
    [{}, encryptionValues('local password', 'separate backup key', 'different backup key'), 'repeatPassphrase'],
    [{}, encryptionValues('local password', 'short'), 'passphrase'],
    [{ kind: 'review' }, encryptionValues('local password', 'archive backup key'), 'keyMode'],
    [{ kind: 'upload', fileValid: false }, encryptionValues('local password'), 'file'],
    [{ kind: 'restore', restoreValid: false }, encryptionValues('local password'), 'confirmation'],
  ] as const) {
    const fixture = submitFixture(values);
    const before = fixture.secrets.map((entry) => entry.value);
    try {
      prepareBackupSubmission(fixture.form, values, { ...fixture.options, ...change });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BackupFormError);
      expect((error as BackupFormError).field).toBe(field);
    }
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.secrets.map((entry) => entry.value)).toEqual(before);
  }
});
test('dispatch preparation preserves exact local auth and separate key while clearing only secret inputs', () => {
  const password = '  local password  ';
  const key = '  independent archive key  ';
  const values = encryptionValues(password, key);
  values.set('totpCode', '001234');
  const fixture = submitFixture(values);
  const result = prepareBackupSubmission(fixture.form, values, { ...fixture.options, totpEnabled: true });
  expect(result).toEqual({ credentials: { password, totpCode: '001234' }, passphrase: key });
  expect(fixture.secrets.every((entry) => entry.value === '')).toBe(true);
  expect(fixture.calls).toEqual(['input[type="password"], input[name="totpCode"]']);
  expect(fixture.selectedFile.name).toBe('encrypted.orbis');
  const legacy = encryptionValues('different local password', 'original source password');
  for (const archiveKeyMode of ['account-password', 'passphrase'] as const) {
    const other = submitFixture(legacy);
    expect(prepareBackupSubmission(other.form, legacy, { ...other.options, kind: 'review', archiveKeyMode }).passphrase).toBe(
      'original source password',
    );
  }
});
test('legacy archive key choice is explicit and its labels never claim detected metadata', () => {
  const fields = (mode: Parameters<typeof BackupArchiveKeyFields>[0]['mode']) =>
    renderToStaticMarkup(<BackupArchiveKeyFields id="legacy" mode={mode} disabled={false} onChange={() => {}} />);
  const unknown = fields(null);
  expect(unknown).toContain('Existing backups do not record this choice');
  expect(unknown).not.toContain('name="passphrase"');
  expect(unknown).not.toContain('aria-pressed="true"');
  expect(fields('account-password')).toContain('Original account password');
  expect(fields('passphrase')).toContain('Backup passphrase');
  for (const mode of ['account-password', 'passphrase'] as const) {
    expect(fields(mode)).toContain('name="passphrase"');
    expect(fields(mode)).not.toContain('name="password"');
  }
});

test('backup removal stays out of the job list until its anchored confirmation opens', () => {
  const markup = render(null, false, undefined, [selectedImport, unrelatedImport]);
  expect(markup.match(/data-backup-removal-trigger="true"/g)).toHaveLength(2);
  expect(markup.match(/backup-removal-trash/g)).toHaveLength(2);
  expect(markup).not.toContain('Remove uploaded backup?');
  expect(markup).not.toContain('permanently deletes');
  const trigger = renderToStaticMarkup(<BackupRemoveTrigger disabled onClick={() => {}} />);
  expect(trigger).toContain('disabled=""');
  expect(trigger).toContain('aria-hidden="true"');
});

test('backup confirmation preserves the selected archive and nearby error throughout closing', () => {
  const snapshot = { current: null as React.ReactNode };
  const prompt = backupRemovalContents({
    kind: 'import',
    busy: false,
    disabled: false,
    error: 'Deletion failed. Try again.',
    onCancel: () => {},
    onRemove: () => {},
  });
  retainDialogChildren(snapshot, true, prompt);
  const closed = retainDialogChildren(
    snapshot,
    false,
    backupRemovalContents({ kind: 'export', busy: false, disabled: false, error: null, onCancel: () => {}, onRemove: () => {} }),
  );
  const markup = renderToStaticMarkup(<Dialog open>{closed}</Dialog>);
  expect(markup).toContain('Remove uploaded backup?');
  expect(markup).not.toContain('Remove server backup copy?');
  expect(markup).toContain('Files already saved on your device are unaffected.');
  expect(markup).toContain('backup-removal-error');
  expect(markup).toContain('Deletion failed. Try again.');
  expect(markup).toContain('>Cancel</button>');
  expect(markup).toContain('backup-removal-trash');
  expect(markup).toContain('btn-outline-danger');
});

test('backup confirmation locks both matching actions while deletion is pending', () => {
  const markup = renderToStaticMarkup(
    <Dialog open>
      {backupRemovalContents({ kind: 'export', busy: true, disabled: false, error: null, onCancel: () => {}, onRemove: () => {} })}
    </Dialog>,
  );
  expect(markup.match(/disabled=""/g)).toHaveLength(2);
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain('Remove server backup copy?');
  const blocked = renderToStaticMarkup(
    <Dialog open>
      {backupRemovalContents({ kind: 'import', busy: false, disabled: true, error: null, onCancel: () => {}, onRemove: () => {} })}
    </Dialog>,
  );
  expect(blocked.match(/disabled=""/g)).toHaveLength(1);
});

test('backup popout follows the clicked row and flips above a bottom row', () => {
  const bounds = { left: 0, top: 40, right: 1000, bottom: 700 };
  expect(placeBackupRemoval({ left: 700, top: 200, right: 780, bottom: 244 }, { width: 320, height: 230 }, bounds)).toEqual({
    left: 460,
    top: 252,
    width: 320,
    maxHeight: 440,
    side: 'bottom',
  });
  expect(placeBackupRemoval({ left: 700, top: 620, right: 780, bottom: 664 }, { width: 320, height: 230 }, bounds)).toEqual({
    left: 460,
    top: 382,
    width: 320,
    maxHeight: 564,
    side: 'top',
  });
});

test('backup popout clamps narrow and enlarged layouts to the visible scrolling boundary', () => {
  for (const bounds of [
    { left: 0, top: 44, right: 320, bottom: 580 },
    { left: 24, top: 100, right: 414, bottom: 420 },
  ]) {
    const position = placeBackupRemoval({ left: 240, top: 330, right: 320, bottom: 374 }, { width: 320, height: 720 }, bounds);
    expect(position.left).toBeGreaterThanOrEqual(bounds.left + 8);
    expect(position.left + position.width).toBeLessThanOrEqual(bounds.right - 8);
    expect(position.top).toBeGreaterThanOrEqual(bounds.top + 8);
    expect(position.top + Math.min(720, position.maxHeight)).toBeLessThanOrEqual(bounds.bottom - 8);
    expect(position.maxHeight).toBeGreaterThan(140);
  }
});

test('backup dismissal preserves scroll and skips a removed or disabled opener', () => {
  const calls: unknown[] = [];
  const element = (connected: boolean, disabled = false) =>
    ({
      isConnected: connected,
      matches: () => disabled,
      getClientRects: () => [1],
      focus: (options: unknown) => calls.push(options),
    }) as unknown as HTMLElement;
  expect(restoreBackupRemovalFocus([element(false), element(true, true), element(true)])).toBe(true);
  expect(calls).toEqual([{ preventScroll: true }]);
  expect(restoreBackupRemovalFocus([null, element(false)])).toBe(false);
});
