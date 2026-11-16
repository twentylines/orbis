import { expect, mock, test } from 'bun:test';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { DesktopTaskPanel, taskPanelGroups, taskPanelPosition } from './desktop-task-panel';
import { RestoreRequestsContext } from '@/modules/host-transfer/receiver-request-context';
import type { IncomingRestoreRequest } from '@/modules/host-transfer/receiver-request-api';

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
  const retry = mock();
  const close = mock();
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
        retry={retry}
        close={close}
        {...overrides}
      />
    </MemoryRouter>,
  );
  expect(retry).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  return markup;
}

test('groups all lifecycle statuses without losing attention records or mutating the source', () => {
  const records = [task('queued'), task('running', 2), task('failed', 3), task('interrupted', 4), task('unconfirmed', 5), task('succeeded', 6)];
  const original = [...records];
  const groups = taskPanelGroups(records);
  expect(groups.map((group) => group.tasks.map((record) => record.status))).toEqual([
    ['running', 'queued'],
    ['unconfirmed', 'interrupted', 'failed'],
    ['succeeded', 'unconfirmed', 'interrupted', 'failed'],
  ]);
  expect(records).toEqual(original);
});

test('reports lifecycle states without invented percentages and keeps real review destinations', () => {
  const markup = render({ tasks: [task('running'), task('unconfirmed', 2), task('succeeded', 3)] });
  expect(markup).toContain('Active operations');
  expect(markup).toContain('Needs review');
  expect(markup).toContain('Recent activity');
  expect(markup).toContain('Update Jellyfin');
  expect(markup).toContain('Awaiting confirmation');
  expect(markup).toContain('outcome is not confirmed');
  expect(markup).toContain('/tasks?app=jellyfin%3Amain');
  expect(markup).toContain('/settings?tab=logs');
  expect(markup).not.toContain('<progress');
  expect(markup).not.toMatch(/\d+%[ <]/);
});

test('caps each section while retaining its total without a redundant footer or close button', () => {
  const markup = render({ tasks: [1, 2, 3, 4, 5].map((index) => task('succeeded', index)) });
  expect(markup.match(/<li /g)?.length).toBe(3);
  expect(markup).toContain('Showing the latest 3 of 5');
  expect(markup).not.toContain('Open task centre');
  expect(markup).not.toContain('Close task centre');
  expect(markup).not.toContain('desktop-task-panel-footer');
});

test('loading, empty, stale history and storage failures remain explicit', () => {
  expect(render({ loading: true })).toContain('Reading operations');
  expect(render()).toContain('No active tasks');
  expect(render()).toContain('Nothing needs attention');
  expect(render()).toContain('No recent activity');
  const markup = render({ tasks: [task('running')], failed: true, storageUnavailable: true });
  expect(markup).toContain('last reported state');
  expect(markup).toContain('In progress · last reported');
  expect(markup).toContain('Retry task history');
  expect(markup).toContain('may be lost on restart');
  expect(markup).not.toContain('No active tasks');
});

test('all terminal actions appear in recent activity and shared setup failures retain their actual recovery actions', () => {
  const failed = { ...task('failed'), displayName: 'Time Machine preferences', setupFailureOutcome: 'preferences-save-failed' as const };
  const backup = { ...task('succeeded', 2), action: 'backup' as const };
  const restore = { ...task('succeeded', 3), action: 'restore' as const };
  const markup = render({ tasks: [failed, backup, restore], names: new Map([['jellyfin:main', 'Media server']]), dismissSetupFailure: mock() });
  expect(markup).toContain('Backup Media server');
  expect(markup).toContain('Restore Media server');
  expect(markup).toContain('Review Time Machine');
  expect(markup).toContain('Dismiss');
  expect(taskPanelGroups([failed, backup, restore])[2]?.tasks).toHaveLength(3);
});

test('the dropdown and full page share record/name aggregation and incoming restore request implementation', async () => {
  const page = await Bun.file(new URL('../modules/tasks/pages/tasks.tsx', import.meta.url)).text();
  const trigger = await Bun.file(new URL('./desktop-task-link.tsx', import.meta.url)).text();
  const panel = await Bun.file(new URL('./desktop-task-panel.tsx', import.meta.url)).text();
  const shared = await Bun.file(new URL('./task-centre-records.ts', import.meta.url)).text();
  expect(page).toContain('useTaskCentreRecords(serverRecords, user.id)');
  expect(trigger).toContain('useTaskCentreRecords(tasks.data?.tasks ?? [], user.id, open)');
  expect(page).toContain('<SourceRestoreRequests />');
  expect(panel).toContain('<SourceRestoreRequests />');
  expect(shared).toContain('mergeSetupCaptureTasks(serverRecords, failures)');
  expect(shared).toContain('...getInstalledAppsOptions(), enabled');
  expect(shared).not.toContain('refetchInterval');
});

test('real incoming backup export activity renders the existing stage, byte progress and cancellation action', () => {
  const request: IncomingRestoreRequest = {
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    nonce: '00000000-0000-4000-8000-000000000002',
    sourceFingerprint: 'a'.repeat(64),
    destinationFingerprint: 'b'.repeat(64),
    status: 'exporting',
    expiresAt: Date.now() + 60_000,
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
  expect(markup).toContain('Creating encrypted backup');
  expect(markup).toContain('Encrypting archive');
  expect(markup).toContain('512 B of 1 KiB');
  expect(markup).toContain('Cancel');
  expect(markup).toContain('No other active tasks');
  expect(requests.remember).not.toHaveBeenCalled();
});

test('capture progress uses actual reported bytes and suppresses stale or invalid totals', () => {
  const capture = { status: 'capturing', stage: 'copying-files', completedBytes: 512, totalBytes: 1024 } as TimeMachinePoint;
  const markup = render({ capture });
  expect(markup).toContain('value="50"');
  expect(markup).toContain('512 B of 1 KiB reported');
  expect(markup).toContain('/settings?tab=time-machine');
  const stale = render({ capture, captureFailed: true });
  expect(stale).not.toContain('<progress');
  expect(stale).toContain('Completion has not been confirmed');
  const unknown = render({ capture: { ...capture, totalBytes: null } });
  expect(unknown).not.toContain('<progress');
  expect(unknown).toContain('has not reported a total size');
});

test('restore and update alerts link to existing review flows', () => {
  const markup = render({ pendingRequests: 2, criticalUpdate: true });
  expect(markup).toContain('Review 2 restore requests');
  expect(markup).toContain('Review critical Orbis update');
  expect(markup).toContain('href="/updates"');
  expect(markup).toContain('href="/tasks"');
});

test('phone and desktop positioning preserves sixteen-pixel outer gutters using layout width', () => {
  for (const viewport of [320, 390, 1280]) {
    const width = Math.min(400, viewport - 32);
    for (const left of [16, viewport / 2, viewport - 60]) {
      const position = taskPanelPosition({ left, right: left + 44, bottom: 64 }, width, viewport);
      expect(position.left).toBeGreaterThanOrEqual(16);
      expect(position.left + width).toBeLessThanOrEqual(viewport - 16);
      expect(position.top).toBe(72);
    }
  }
});

test('the toolbar uses a nonmodal portal and existing snapshots without introducing another polling source', async () => {
  const source = await Bun.file(new URL('./desktop-task-link.tsx', import.meta.url)).text();
  expect(source).toContain('modal={false}');
  expect(source).toContain('<Dialog.Trigger asChild>');
  expect(source).toContain('<Dialog.Portal>');
  expect(source).toContain('panel.current.offsetWidth');
  expect(source.match(/useTasks\(\)/g)?.length).toBe(1);
  expect(source.match(/useTimeMachineActivity\(\)/g)?.length).toBe(1);
  expect(source).not.toContain('refetchInterval');
  const css = await Bun.file(new URL('./desktop-task-panel.css', import.meta.url)).text();
  expect(css).toContain('max-width: calc(100vw - 32px)');
  expect(css).toContain('overflow-y: auto');
  expect(css).toContain('min-height: 44px');
});
