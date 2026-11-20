import { expect, mock, test } from 'bun:test';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { DesktopTaskPanel, TaskDetails, taskPanelPosition } from './desktop-task-panel';
import { groupTaskCentreAttempts, taskCentreRecords } from './task-centre-model';
import { RestoreRequestsContext } from '@/modules/host-transfer/receiver-request-context';
import type { IncomingRestoreRequest } from '@/modules/host-transfer/receiver-request-api';
import type { SetupFailureTask } from '@/components/welcome/setup-capture-task';
function task(status: TaskRecord['status'], index = 1): TaskRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    appUrn: 'jellyfin:main' as TaskRecord['appUrn'],
    displayName: 'Jellyfin',
    action: 'update',
    status,
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: `2026-11-13T00:${String(index).padStart(2, '0')}:00Z`,
    startedAt: null,
    finishedAt: null,
  };
}
function render(overrides: Partial<Parameters<typeof DesktopTaskPanel>[0]> = {}) {
  return renderToStaticMarkup(
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
        {...overrides}
      />
    </MemoryRouter>,
  );
}

test('default sections are mutually exclusive, and the full available list is accessible without a three-record cap', () => {
  const markup = render({ tasks: [1, 2, 3, 4, 5].map((i) => task('succeeded', i)) });
  expect(markup.match(/data-task-key=/g)).toHaveLength(5);
  expect(markup).toContain('Search task activity');
  expect(markup).toContain('Close task centre');
  expect(markup).not.toContain('latest 3');
  expect(markup).not.toContain('Open Time Machine');
  expect(markup).toContain('data-focus-surface="parent"');
});

test('every row keeps a details action even when activity visibility is unavailable', () => {
  const markup = render({ tasks: [task('failed'), task('succeeded', 2)] });
  expect(markup.match(/class="task-centre-row-action"/g)).toHaveLength(2);
  expect(markup).not.toContain('Dismiss Update Jellyfin from activity');
});

test('already dismissed setup records and history retention copy do not enter All', () => {
  const dismissed: SetupFailureTask = {
    ...task('failed'),
    setupFailureOutcome: 'capture-failed',
    setupFailureDismissed: true,
  };
  const markup = render({ tasks: [dismissed] });
  expect(markup).not.toContain('Failed · dismissed');
  expect(markup).not.toContain('300 operations');
  expect(markup).not.toContain('data-task-key=');
  expect(markup).toContain('<strong>1</strong><span>History</span>');
});

test('compact rows open details, keep failures grouped, and do not expose link clutter or invented progress', () => {
  const markup = render({ tasks: [task('failed'), task('failed', 2), task('unconfirmed', 3)] });
  expect(markup.match(/data-task-key=/g)).toHaveLength(2);
  expect(markup).toContain('2 attempts');
  expect(markup).toContain('Awaiting confirmation');
  expect(markup).not.toContain('View app tasks');
  expect(markup).not.toContain('0 B');
  expect(markup).not.toContain('<progress');
});

test('loading, missing services and storage failures remain distinct from nothing running', () => {
  const loading = render({ loading: true });
  expect(loading).toContain('Reading operations');
  expect(loading).not.toContain('class="task-centre-warning"');
  const empty = render();
  expect(empty).toContain('No recent activity');
  expect(empty).not.toContain('<small>available</small>');
  const markup = render({ failed: true, storageUnavailable: true });
  expect(markup).toContain('Limited activity');
  expect(markup).toContain('Retry unavailable activity sources');
  expect(markup).toContain('may be lost on restart');
  expect(markup).not.toContain('Nothing running');
  const partial = render({
    systemActivity: { records: [], notices: [{ message: 'Backups could not be refreshed.' }], loading: false, incomplete: true },
  });
  expect(partial).toContain('Backups could not be refreshed');
  expect(partial).not.toContain('Nothing running');
});

test('partial counts stay plain and failures share one collapsed warning with a real Retry affordance', () => {
  const markup = render({
    tasks: [task('failed'), task('succeeded', 2)],
    failed: true,
    captureFailed: true,
    systemActivity: {
      records: [],
      notices: [{ message: 'Orbis update status is unavailable.', retry: mock() }, { message: 'Settings backups could not be refreshed.' }],
      loading: false,
      incomplete: true,
    },
  });
  expect(markup).toContain('<strong>1</strong><span>Needs attention</span>');
  expect(markup).toContain('<strong>2</strong><span>History</span>');
  expect(markup.match(/class="task-centre-warning"/g)).toHaveLength(1);
  expect(markup).toContain('Counts are partial.');
  expect(markup).toMatch(/aria-hidden="true" inert=""><div class="task-centre-disclosure-content"><ul class="task-centre-warning-details">/);
  expect(markup).toContain('aria-label="Retry unavailable activity sources"');
  expect(markup).toContain('Orbis update status is unavailable.');
  expect(markup).toContain('Task history could not be refreshed.');
  expect(markup).toContain('Settings backups could not be refreshed.');
  expect(markup).toContain('Capture status could not be refreshed.');
  expect(markup).not.toContain('<small>available</small>');
  expect(markup).not.toContain('2+');
  expect(markup.match(/data-task-key=/g)).toHaveLength(2);
});

test('restricted sources explain missing activity without a pretend Retry action', () => {
  const markup = render({
    systemActivity: {
      records: [],
      notices: [{ message: 'System activity is restricted to an authorized operator session.' }],
      loading: false,
      incomplete: true,
    },
  });
  expect(markup).toContain('System activity is restricted');
  expect(markup).toContain('Counts are partial.');
  expect(markup).not.toContain('Retry unavailable activity sources');
});

test('detail view retains exact attempts and supported diagnostics without decorative retry or cancel controls', () => {
  const record = groupTaskCentreAttempts(taskCentreRecords({ tasks: [task('failed'), task('failed', 2)] }))[0];
  if (!record) throw Error('Missing fixture');
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TaskDetails record={record} close={mock()} />
    </MemoryRouter>,
  );
  expect(markup).toContain('2 attempts');
  expect(markup).toContain(task('failed').id);
  expect(markup).toContain(task('failed', 2).id);
  expect(markup).toContain('/apps/main/jellyfin');
  expect(markup).toContain('/settings?tab=logs');
  expect(markup).toContain('did not provide an error message');
  expect(markup).not.toContain('>Retry<');
  expect(markup).not.toContain('>Cancel<');
});

test('capture uses actual bytes while unknown or stale totals stay indeterminate', () => {
  const capture: TimeMachinePoint = {
    id: task('running').id,
    createdAt: Date.now(),
    status: 'capturing',
    stage: 'copying-files',
    completedBytes: 512,
    totalBytes: 1024,
    issue: null,
    backupJobId: null,
    metadata: null,
  };
  const markup = render({ capture });
  expect(markup).toContain('value="512"');
  expect(markup).toContain('max="1024"');
  expect(markup).toContain('Copying');
  expect(render({ capture, captureFailed: true })).not.toContain('<progress');
  expect(render({ capture: { ...capture, totalBytes: null } })).not.toContain('<progress');
});

test('incoming restore controls remain mounted for actual cancellation and transfer progress', () => {
  const request: IncomingRestoreRequest = {
    version: 1,
    id: task('running').id,
    nonce: task('running', 2).id,
    sourceFingerprint: 'a'.repeat(64),
    destinationFingerprint: 'b'.repeat(64),
    status: 'exporting',
    expiresAt: Date.now() + 60000,
    completedBytes: 0,
    totalBytes: null,
    exportProgress: { stage: 'encrypting', completedBytes: 512, totalBytes: 1024 },
  };
  const requests = {
    authority: {},
    snapshot: { version: 1 as const, incoming: [request], outgoing: [] },
    pendingCount: 0,
    available: true,
    error: null,
    refresh: mock(),
    remember: mock(),
    review: mock(),
  };
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <RestoreRequestsContext.Provider value={requests}>
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
          restoreRequests={requests}
        />
      </RestoreRequestsContext.Provider>
    </MemoryRouter>,
  );
  expect(markup).toContain('Export backup to another server');
  expect(markup).toContain('512 B of 1 KiB');
  expect(markup).toContain('Cancel');
  expect(markup).toContain('task-centre-requests');
  expect(requests.remember).not.toHaveBeenCalled();
});

test('phone and desktop positioning maintains outer gutters for the new panel width', () => {
  for (const viewport of [320, 390, 1280])
    for (const left of [16, viewport / 2, viewport - 60]) {
      const width = Math.min(540, viewport - 32);
      const position = taskPanelPosition({ left, right: left + 44, bottom: 64 }, width, viewport);
      expect(position.left).toBeGreaterThanOrEqual(16);
      expect(position.left + width).toBeLessThanOrEqual(viewport - 16);
      expect(position.top).toBe(72);
    }
});

test('popup and full Tasks page use the same record aggregation and rendered view', async () => {
  const page = await Bun.file(new URL('../modules/tasks/pages/tasks.tsx', import.meta.url)).text();
  const trigger = await Bun.file(new URL('./desktop-task-link.tsx', import.meta.url)).text();
  const panel = await Bun.file(new URL('./desktop-task-panel.tsx', import.meta.url)).text();
  const shared = await Bun.file(new URL('./task-centre-records.ts', import.meta.url)).text();
  expect(page).toContain('<DesktopTaskPanel');
  expect(trigger).toContain('<DesktopTaskPanel');
  expect(panel).toContain('<SourceRestoreRequests requestId=');
  expect(shared).toContain('setupFailureTasks(ownerId, undefined, true)');
  expect(shared).not.toContain('refetchInterval');
  expect(trigger).toContain('modal={false}');
});

test('filters sit below the activity summary and retain collapsed controls outside the keyboard order', () => {
  const markup = render();
  const summary = markup.indexOf('class="task-centre-summary"');
  const filters = markup.indexOf('class="task-centre-filter-bar"');
  expect(summary).toBeGreaterThan(-1);
  expect(filters).toBeGreaterThan(summary);
  expect(markup).toMatch(/aria-hidden="true" inert=""><div class="task-centre-disclosure-content"><div class="task-centre-filters">/);
});
