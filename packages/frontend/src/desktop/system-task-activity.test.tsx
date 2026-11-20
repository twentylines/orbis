import { afterEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { defaultSettingsBackupSelection, settingsBackupJobSchema } from '@runtipi/common/schemas/settings-backup';
import { settingsBackupImportJobSchema, settingsBackupRestoreJobSchema } from '@runtipi/common/schemas/settings-backup-import';
import { readSettingsExports, SettingsBundleApiError } from '@/modules/system-backups/settings-bundle-api';
import { groupTaskCentreAttempts, taskCentreRecords } from './task-centre-model';
import { DesktopTaskPanel, TaskDetails } from './desktop-task-panel';
import { systemActivityRecords, systemActivityPollInterval, settingsExportActive, settingsImportActive } from './system-task-activity';
import { systemActivityReadIssue, systemActivityPollingOwner } from './use-system-task-activity';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const backup = (index = 1, status: 'ready' | 'running' | 'failed' = 'ready') =>
  settingsBackupJobSchema.assert({
    version: 1,
    id: id(index),
    createdAt: 1000 + index,
    status,
    stage: status === 'ready' ? 'complete' : 'encrypting',
    completedBytes: status === 'ready' ? 1024 : 512,
    totalBytes: 1024,
    bytes: status === 'ready' ? 1024 : 0,
    sha256: status === 'ready' ? 'a'.repeat(64) : null,
    selection: defaultSettingsBackupSelection(),
  });

test('a ready backup read through the existing bounded API appears as recent activity instead of a false empty state', async () => {
  const parsedJob = backup();
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    expect(String(input)).toBe('/api/system-backups/settings-bundles');
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
    return Response.json({ version: 1, jobs: [parsedJob] });
  }) as typeof fetch;
  const result = await readSettingsExports(new AbortController().signal);
  const activity = { records: systemActivityRecords({ exports: result.jobs }), notices: [], loading: false, incomplete: false };
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <DesktopTaskPanel
        tasks={[]}
        loading={false}
        failed={false}
        storageUnavailable={false}
        captureFailed={false}
        pendingRequests={0}
        criticalUpdate={false}
        retry={mock()}
        close={mock()}
        systemActivity={activity}
      />
    </MemoryRouter>,
  );
  expect(markup).toContain('Backup ready');
  expect(markup).not.toContain('0 B');
  expect(markup).toContain('data-task-key="export:');
  expect(markup).not.toContain('No recent activity');
  expect(markup).not.toContain('Download');
  expect(markup).not.toContain('Password');
});

test('activity preserves every available record while sorting without mutating server data', () => {
  const jobs = [1, 5, 2, 4, 3].map((index) => backup(index));
  const original = jobs.map((job) => job.id);
  const records = systemActivityRecords({ exports: [...jobs, backup(6, 'failed'), backup(7, 'running')] });
  expect(records.filter((record) => record.bucket === 'recent').map((record) => record.key)).toEqual([
    `export:${id(5)}`,
    `export:${id(4)}`,
    `export:${id(3)}`,
    `export:${id(2)}`,
    `export:${id(1)}`,
  ]);
  expect(records[0]?.bucket).toBe('active');
  expect(records[1]?.bucket).toBe('review');
  expect(jobs.map((job) => job.id)).toEqual(original);
});

test('imports retain server statuses and processed bytes without inventing a completed outcome', () => {
  const job = settingsBackupImportJobSchema.assert({
    id: id(1),
    status: 'uploaded',
    createdAt: 1000,
    updatedAt: 2000,
    uploadedBytes: 1024,
    completedBytes: 0,
    totalBytes: null,
    message: 'Review the archive.',
  });
  const record = systemActivityRecords({ imports: [job] })[0];
  expect(record).toMatchObject({ bucket: 'review', status: 'Ready for review', completed: 0, total: null, time: 2000 });
  expect(settingsImportActive(job)).toBe(false);
});

test('latest restore retains its actual result without an invented timestamp', () => {
  const restore = settingsBackupRestoreJobSchema.assert({
    id: id(1),
    status: 'succeeded',
    stage: 'complete',
    needsRecovery: false,
    canRollback: false,
  });
  const records = systemActivityRecords({ restore });
  expect(records[0]?.time).toBeUndefined();
  const record = groupTaskCentreAttempts(taskCentreRecords({ tasks: [], system: records }))[0];
  if (!record) throw new Error('Missing restore fixture');
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TaskDetails record={record} close={mock()} />
    </MemoryRouter>,
  );
  expect(markup).toContain('Latest settings restore');
  expect(markup).toContain('Restore completed');
  expect(markup).not.toContain('<dt>Reported</dt>');
  expect(markup).not.toContain('<time');
  expect(markup).not.toContain('No system activity');
});

test.each([401, 403, 404, 503])('HTTP %s remains distinct from empty activity without exposing server diagnostics', async (status) => {
  globalThis.fetch = (async () => Response.json({ message: 'Private diagnostic must stay private' }, { status })) as unknown as typeof fetch;
  let error: unknown;
  try {
    await readSettingsExports(new AbortController().signal);
  } catch (value) {
    error = value;
  }
  expect(error).toBeInstanceOf(SettingsBundleApiError);
  expect((error as SettingsBundleApiError).status).toBe(status);
  const notice = systemActivityReadIssue('Settings backups', error);
  expect(notice).toContain(status === 404 ? 'not supported' : status === 401 || status === 403 ? 'not authorized' : 'unknown');
  expect(notice).not.toContain('Private diagnostic');
});

test('polling stops for hidden/closed views, failures and settled jobs', () => {
  expect(systemActivityPollInterval(true, false, settingsExportActive(backup(1, 'running')))).toBe(1500);
  expect(systemActivityPollInterval(true, false, settingsExportActive(backup()))).toBe(false);
  expect(systemActivityPollInterval(false, false, true)).toBe(false);
  expect(systemActivityPollInterval(true, true, true)).toBe(false);
});

test('stale core status retains a last-reported label and suppresses progress animation', () => {
  const records = systemActivityRecords({
    coreStale: true,
    core: { available: false, job: { id: id(1), targetTag: 'v0.1.0-beta.130', state: 'running' } },
  });
  const record = records[0];
  if (!record) throw new Error('Expected the existing core job');
  const projected = groupTaskCentreAttempts(taskCentreRecords({ tasks: [], system: [record] }))[0];
  if (!projected) throw new Error('Missing projected core fixture');
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TaskDetails record={projected} close={mock()} />
    </MemoryRouter>,
  );
  expect(markup).toContain('last reported');
  expect(markup).not.toContain('<progress');
  expect(markup).toContain('/updates');
});

test('additional feeds are operator/session/visibility gated and reuse cache keys while the projection list remains passive', async () => {
  const source = await Bun.file(new URL('./use-system-task-activity.ts', import.meta.url)).text();
  expect(source).toContain('open && visible && user.operator === true && !sessionAbortSignal.aborted');
  expect(source).toContain("['orbis-settings-bundles', user.id]");
  expect(source.match(/AbortSignal.any\(\[signal, sessionAbortSignal\]\)/g)?.length).toBe(4);
  expect(source).toMatch(/queryKey: \['time-machine-points', user.id\][\s\S]*?enabled,/);
  expect(source).toContain('const host = useHostUpdateWatch()');
  expect(source).not.toContain('/api/host-updates');
  const page = await Bun.file(new URL('../modules/tasks/pages/tasks.tsx', import.meta.url)).text();
  const trigger = await Bun.file(new URL('./desktop-task-link.tsx', import.meta.url)).text();
  expect(page).toContain("useSystemTaskActivity(!appScope, 'page')");
  expect(trigger).toContain('useSystemTaskActivity(open)');
});

test('one visible task/settings surface owns active-job polling while the popup observes its shared cache', () => {
  expect(systemActivityPollingOwner('popup', '/dashboard')).toBe(true);
  expect(systemActivityPollingOwner('popup', '/tasks')).toBe(false);
  expect(systemActivityPollingOwner('page', '/tasks')).toBe(true);
  expect(systemActivityPollingOwner('popup', '/tasks', '?app=jellyfin:main')).toBe(true);
  expect(systemActivityPollingOwner('popup', '/settings', '?tab=backups')).toBe(false);
  expect(systemActivityPollingOwner('page', '/settings', '?tab=backups')).toBe(false);
});
