import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import { createAppQueryClient } from '@/lib/query-client';
import { DesktopTaskLink } from './desktop-task-link';
import { criticalUpdateAttentionKey, readTaskAcknowledgements, taskAttentionKey } from './task-attention';

function task(status: TaskRecord['status'], digit = 'a'): TaskRecord {
  return {
    id: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
    appUrn: 'fixture:catalogue' as TaskRecord['appUrn'],
    action: 'update',
    status,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:01:00Z',
    startedAt: null,
    finishedAt: null,
  };
}

test.each(['failed', 'interrupted', 'unconfirmed'] as const)('identifies a %s task and treats a later status change as a new alert', (status) => {
  const value = task(status);
  const first = taskAttentionKey(value);
  expect(first).toBeTruthy();
  expect(taskAttentionKey({ ...value, updatedAt: '2026-10-28T00:02:00Z' })).not.toBe(first);
});
test.each(['running', 'queued', 'succeeded'] as const)('does not mark a %s task as an alert', (status) => {
  expect(taskAttentionKey(task(status))).toBeNull();
});
test('tints the existing number for unread failures without adding another badge', () => {
  const client = createAppQueryClient();
  client.setQueryData(['tasks'], {
    tasks: [task('running'), task('failed', 'b')],
    storage: 'persistent',
    sampledAt: '2026-10-28T00:02:00Z',
    retentionDays: 30,
    limit: 300,
  });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DesktopTaskLink />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup).toContain('desktop-task-count');
  expect(markup).not.toContain('desktop-task-alert');
  expect(markup).toContain('data-alert="true"');
  expect(markup.match(/desktop-task-badge/g)?.length).toBe(1);
  expect(markup).toContain('1 active operation, 1 new alert');
  expect(markup.match(/<a /g)?.length).toBe(1);
  client.clear();
});
test('does not show an unread badge while the task centre is being viewed', () => {
  const client = createAppQueryClient();
  client.setQueryData(['tasks'], {
    tasks: [task('failed')],
    storage: 'persistent',
    sampledAt: '2026-10-28T00:02:00Z',
    retentionDays: 30,
    limit: 300,
  });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tasks']}>
        <DesktopTaskLink />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup).not.toContain('desktop-task-alert');
  client.clear();
});
test.each(['broken', '{}', '[1]', JSON.stringify(['x'.repeat(129)]), JSON.stringify(Array(303).fill('alert'))])(
  'ignores unsafe or oversized acknowledgement data: case %#',
  (raw) => {
    expect(readTaskAcknowledgements({ getItem: () => raw })).toEqual([]);
  },
);
test('retains bounded acknowledgement keys and works when browser storage is unavailable', () => {
  const keys = [taskAttentionKey(task('failed')) as string];
  expect(readTaskAcknowledgements({ getItem: () => JSON.stringify(keys) })).toEqual(keys);
  expect(
    readTaskAcknowledgements({
      getItem: () => {
        throw new Error('Storage denied');
      },
    }),
  ).toEqual([]);
});

test('only marks an available newer critical release, including inherited critical fixes', () => {
  const release = {
    tag: 'v1.1.3',
    priority: 'critical' as const,
    imageManifestUrl: 'https://example.test/release.json',
    publishedAt: null,
    body: '',
    url: '',
  };
  expect(criticalUpdateAttentionKey(release, 'v1.1.0')).toBe('critical:v1.1.3');
  expect(criticalUpdateAttentionKey(release, 'v1.1.3')).toBeNull();
  expect(criticalUpdateAttentionKey(release, undefined)).toBeNull();
  expect(criticalUpdateAttentionKey({ ...release, priority: undefined }, 'v1.1.0')).toBeNull();
  expect(criticalUpdateAttentionKey({ ...release, imageManifestUrl: null }, 'v1.1.0')).toBeNull();
});

test('shows a red number for a critical update even when no app operation is running', () => {
  const client = createAppQueryClient();
  client.setQueryData(['orbis-release-channels'], { current: 'stable' });
  client.setQueryData(['orbis-installed-build'], { version: 'v1.1.0' });
  client.setQueryData(
    ['orbis-github-releases', 'stable'],
    [{ tag: 'v1.1.3', priority: 'critical', imageManifestUrl: 'https://example.test/release.json' }],
  );
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DesktopTaskLink />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup.match(/desktop-task-badge/g)?.length).toBe(1);
  expect(markup).toContain('data-alert="true"');
  expect(markup).toContain('0 active operations, 1 new alert');
  expect(markup).not.toContain('desktop-task-alert');
  client.clear();
});
