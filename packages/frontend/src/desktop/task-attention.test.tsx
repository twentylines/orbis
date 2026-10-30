import { expect, test } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import { createAppQueryClient } from '@/lib/query-client';
import { AppContextProvider } from '@/context/app-context';
import { UserContextProvider } from '@/context/user-context';
import { appContextQueryKey, userContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { DesktopTaskLink } from './desktop-task-link';
import {
  clearRecoveredHistoryAcknowledgement,
  criticalUpdateAttentionKey,
  readTaskAcknowledgements,
  saveTaskAcknowledgements,
  mergeTaskAcknowledgements,
  requestTaskAcknowledgements,
  taskAttentionSession,
  type TaskAttentionRequest,
  taskAttentionKey,
} from './task-attention';

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

test.each(['failed', 'interrupted', 'unconfirmed'] as const)(
  'identifies a %s task and keeps repeated timestamps stable and identifies a new attention revision',
  (status) => {
    const value = task(status);
    const first = taskAttentionKey(value);
    expect(first).toBeTruthy();
    expect(taskAttentionKey({ ...value, updatedAt: '2026-10-28T00:02:00Z' })).toBe(first);
    expect(taskAttentionKey({ ...value, attentionRevision: 1 })).not.toBe(first);
  },
);
test.each(['running', 'queued', 'succeeded'] as const)('does not mark a %s task as an alert', (status) => {
  expect(taskAttentionKey(task(status))).toBeNull();
});
test('keeps active counts while canonical acknowledgements are still unknown', () => {
  const client = createAppQueryClient();
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  client.setQueryData(userContextQueryKey(), { isLoggedIn: true });
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
        <UserContextProvider>
          <AppContextProvider>
            <DesktopTaskLink />
          </AppContextProvider>
        </UserContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup).toContain('desktop-task-count');
  expect(markup).not.toContain('desktop-task-alert');
  expect(markup).not.toContain('data-alert="true"');
  expect(markup.match(/desktop-task-badge/g)?.length).toBe(1);
  expect(markup).toContain('1 active operation, checking saved task alerts');
  expect(markup).toContain('data-attention-state="loading"');
  expect(markup).toContain('aria-busy="true"');
  expect(markup.match(/<a /g)?.length).toBe(1);
  client.clear();
});
test('does not show an unread badge while the task centre is being viewed', () => {
  const client = createAppQueryClient();
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  client.setQueryData(userContextQueryKey(), { isLoggedIn: true });
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
        <UserContextProvider>
          <AppContextProvider>
            <DesktopTaskLink />
          </AppContextProvider>
        </UserContextProvider>
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
  const keys = ['critical:v1.1.3', 'history-unavailable'];
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
  client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
  client.setQueryData(userContextQueryKey(), { isLoggedIn: true });
  client.setQueryData(['orbis-release-channels'], { current: 'stable' });
  client.setQueryData(['orbis-installed-build'], { version: 'v1.1.0' });
  client.setQueryData(
    ['orbis-github-releases', 'stable'],
    [{ tag: 'v1.1.3', priority: 'critical', imageManifestUrl: 'https://example.test/release.json' }],
  );
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UserContextProvider>
          <AppContextProvider>
            <DesktopTaskLink />
          </AppContextProvider>
        </UserContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup.match(/desktop-task-badge/g)?.length).toBe(1);
  expect(markup).toContain('data-alert="true"');
  expect(markup).toContain('0 active operations, 1 new alert');
  expect(markup).not.toContain('desktop-task-alert');
  client.clear();
});

test('critical attention follows the critical marker across later ordinary candidates', () => {
  const release = {
    tag: 'v1.1.3',
    criticalThrough: 'v1.1.2',
    priority: 'critical' as const,
    imageManifestUrl: 'https://example.test/image',
    publishedAt: null,
    body: '',
    url: '',
  };
  expect(criticalUpdateAttentionKey(release, 'v1.1.0')).toBe('critical:v1.1.2');
  expect(criticalUpdateAttentionKey({ ...release, tag: 'v1.1.4' }, 'v1.1.0')).toBe('critical:v1.1.2');
  expect(criticalUpdateAttentionKey({ ...release, tag: 'v1.1.5', criticalThrough: 'v1.1.5' }, 'v1.1.0')).toBe('critical:v1.1.5');
  expect(criticalUpdateAttentionKey(release, 'v1.1.2')).toBeNull();
});

test('supplemental acknowledgements survive reload and remain bound to browser origin and account', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  expect(saveTaskAcknowledgements(['critical:v1.1.2'], storage, 7)).toBe(true);
  expect(saveTaskAcknowledgements(['history-unavailable'], storage, 7)).toBe(true);
  expect(readTaskAcknowledgements(storage, 7)).toEqual(['critical:v1.1.2', 'history-unavailable']);
  expect(readTaskAcknowledgements(storage, 8)).toEqual([]);
  expect(readTaskAcknowledgements({ getItem: () => null }, 7)).toEqual([]);
  expect(
    saveTaskAcknowledgements(
      ['critical:v1.1.3'],
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('Quota exceeded');
        },
      },
      7,
    ),
  ).toBe(false);
});

test('merging backfilled task windows never replaces older observed keys or evicts at the old 302 bound', () => {
  const first = Array.from({ length: 300 }, (_, index) => `old-${index}`);
  const later = Array.from({ length: 300 }, (_, index) => `new-${index}`);
  const seen = mergeTaskAcknowledgements(first, later);
  expect(seen).toHaveLength(600);
  expect(mergeTaskAcknowledgements(seen, [])).toEqual(seen);
  expect(mergeTaskAcknowledgements(seen, first)).toEqual(seen);
  expect(() =>
    mergeTaskAcknowledgements(
      Array.from({ length: 4096 }, (_, index) => String(index)),
      ['new'],
    ),
  ).toThrow('preserved');
});

test('canonical task acknowledgements survive unavailable browser storage and a fresh client reload', async () => {
  let stored: string[] = [];
  const key = taskAttentionKey(task('failed')) as string;
  const request = (async (url, options) => {
    expect(url).toBe('/api/tasks/attention');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.cache).toBe('no-store');
    if (options?.method === 'POST') stored = mergeTaskAcknowledgements(stored, JSON.parse(String(options.body)).keys);
    return Response.json({ version: 1, keys: stored });
  }) as TaskAttentionRequest;
  const signal = new AbortController().signal;
  await requestTaskAcknowledgements(signal, [key], request);
  const reloaded = await requestTaskAcknowledgements(new AbortController().signal, undefined, request);
  expect(reloaded.keys).toEqual([key]);
  const denied = {
    getItem: () => {
      throw new Error('Storage denied');
    },
    setItem: () => {
      throw new Error('Storage denied');
    },
  };
  expect(saveTaskAcknowledgements(['history-unavailable'], denied, 7)).toBe(false);
  expect(readTaskAcknowledgements(denied, 7)).toEqual([]);
  expect((await requestTaskAcknowledgements(signal, undefined, request)).keys).toContain(key);
});

test('account session replacement aborts stale reads and writes before they can acknowledge another account', async () => {
  const first = {};
  const next = {};
  expect(taskAttentionSession(first)).toBe(taskAttentionSession(first));
  expect(taskAttentionSession(next)).not.toBe(taskAttentionSession(first));
  const controller = new AbortController();
  let calls = 0;
  const request = (async () => {
    calls++;
    controller.abort();
    return Response.json({ version: 1, keys: [] });
  }) as TaskAttentionRequest;
  await expect(requestTaskAcknowledgements(controller.signal, undefined, request)).rejects.toThrow();
  await expect(requestTaskAcknowledgements(controller.signal, [], request)).rejects.toThrow();
  expect(calls).toBe(1);
  await expect(
    requestTaskAcknowledgements(new AbortController().signal, undefined, (async () =>
      Response.json({ version: 1, keys: ['future'] })) as TaskAttentionRequest),
  ).rejects.toThrow('invalid');
});

test('only an observed healthy task response clears the old history-outage acknowledgement', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  saveTaskAcknowledgements(['critical:v1.1.2', 'history-unavailable'], storage, 7);
  expect(clearRecoveredHistoryAcknowledgement(storage, 7)).toBe(true);
  expect(readTaskAcknowledgements(storage, 7)).toEqual(['critical:v1.1.2']);
  expect(
    clearRecoveredHistoryAcknowledgement(
      {
        getItem: () => {
          throw new Error('Denied');
        },
        setItem: () => {},
      },
      7,
    ),
  ).toBe(false);
});

for (const scenario of ['acknowledged-reload', 'new-unread', 'ledger-error', 'stale-ledger-error', 'tasks-poll', 'tasks-failed-save']) {
  test(`mounted task attention: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, new URL('./task-attention.fixture.tsx', import.meta.url).pathname, scenario], {
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ scenario, mountedReact: true, realQueryClient: true, network: false, layout: false });
  });
}
