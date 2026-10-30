import { expect, mock } from 'bun:test';
import { act, useLayoutEffect, type ReactNode } from 'react';
import { taskAttentionKey, type TaskRecord } from '@runtipi/common/schemas/task-history';

const scenario = process.argv[2];
const taskPage = scenario?.startsWith('tasks-');
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
};
const storage = { getItem: () => null, setItem: () => undefined };
const win = {
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  localStorage: storage,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  location: { origin: 'https://tasks.example.test' },
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });
type View = { label: string; title: string; state?: string; count: number | null; alert: boolean };
let link!: { onClick: () => void };
let badge: { count: number; alert: boolean } | null = null;
const views: View[] = [];
mock.module('react-router', () => ({
  useLocation: () => ({ pathname: taskPage ? '/tasks' : '/dashboard' }),
  Link: (props: { children: ReactNode; onClick: () => void; title: string; 'aria-label': string; 'data-attention-state'?: string }) => {
    link = props;
    useLayoutEffect(() => {
      views.push({
        label: props['aria-label'],
        title: props.title,
        state: props['data-attention-state'],
        count: badge?.count ?? null,
        alert: badge?.alert ?? false,
      });
    });
    return props.children;
  },
}));
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    span: (props: { children: number; 'data-alert'?: boolean }) => {
      useLayoutEffect(() => {
        badge = { count: props.children, alert: Boolean(props['data-alert']) };
        return () => {
          badge = null;
        };
      });
      return null;
    },
  },
}));
mock.module('@/desktop/motion-preferences', () => ({ useReducedMotion: () => true }));
const icons = await import('@tabler/icons-react');
mock.module('@tabler/icons-react', () => ({ ...icons, IconActivity: () => null, IconAlertTriangle: () => null }));
let saveErrors = 0;
mock.module('react-hot-toast', () => ({
  default: {
    error: () => {
      saveErrors++;
    },
    dismiss: () => undefined,
  },
}));
const record = (index: number, status: TaskRecord['status'] = 'failed'): TaskRecord => ({
  id: `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  appUrn: 'demo:official' as TaskRecord['appUrn'],
  action: 'update',
  status,
  createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-30T00:01:00Z',
  startedAt: null,
  finishedAt: null,
  attentionRevision: 1,
});
const old = Array.from({ length: 16 }, (_, index) => record(index));
const oldKeys = old.map((task) => taskAttentionKey(task) as string);
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
const ledgerRead = deferred();
const firstSave = deferred();
let savedKeys = ['tasks-failed-save', 'stale-ledger-error'].includes(scenario ?? '') ? [] : [...oldKeys];
let gets = 0;
const posts: string[][] = [];
Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input) !== '/api/tasks/attention') return Response.json({});
    if ((options?.method ?? 'GET') === 'GET') {
      gets++;
      if (scenario === 'stale-ledger-error' && gets > 1) return new Response(null, { status: 503 });
      return ledgerRead.promise;
    }
    const keys = JSON.parse(String(options?.body)).keys as string[];
    posts.push(keys);
    if (scenario === 'ledger-error') return new Response(null, { status: 503 });
    if (scenario === 'tasks-failed-save' && posts.length === 1) return firstSave.promise;
    savedKeys = [...new Set([...savedKeys, ...keys])];
    return Response.json({ version: 1, keys: savedKeys });
  },
});
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { appContextQueryKey, userContextQueryKey } = await import('@/api-client/@tanstack/react-query.gen');
const { AppContextProvider } = await import('@/context/app-context');
const { UserContextProvider } = await import('@/context/user-context');
const { RestoreRequestsContext, emptyRestoreRequests } = await import('@/modules/host-transfer/receiver-request-context');
const { DesktopTaskLink } = await import('./desktop-task-link');
const { createRoot } = await import('react-dom/client');
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true } });
client.setQueryData(userContextQueryKey(), { isLoggedIn: true });
const activity = scenario === 'ledger-error';
const tasks = [...old, ...(scenario === 'new-unread' ? [record(99)] : []), ...(activity ? [record(100, 'running')] : [])];
let poll = 0;
const history = () => ({
  tasks: tasks.map((task) => ({ ...task })),
  storage: 'persistent',
  sampledAt: new Date().toISOString(),
  retentionDays: 30,
  limit: 300,
});
client.setQueryData(['tasks'], history());
const context = {
  authority: {},
  snapshot: emptyRestoreRequests,
  pendingCount: activity ? 2 : 0,
  available: true,
  error: null,
  refresh: () => undefined,
  remember: () => undefined,
  review: () => undefined,
};
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  textContent: '',
  appendChild: () => undefined,
  removeChild: () => undefined,
};
const root = createRoot(container as unknown as HTMLElement);
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const latest = () => {
  const view = views.at(-1);
  if (!view) throw new Error('Missing mounted Tasks link');
  return view;
};
const refresh = async () => {
  await act(async () => {
    tasks[0] = { ...record(0), updatedAt: `2026-10-30T00:02:${String(++poll).padStart(2, '0')}Z` };
    client.setQueryData(['tasks'], history());
  });
  await settle();
};
try {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UserContextProvider>
          <AppContextProvider>
            <RestoreRequestsContext.Provider value={context}>
              <DesktopTaskLink />
            </RestoreRequestsContext.Provider>
          </AppContextProvider>
        </UserContextProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(gets).toBe(1);
  expect(views.every((view) => view.count === (activity ? 3 : null) && !view.alert && !view.label.includes('new alert'))).toBe(true);
  expect(latest().state).toBe('loading');
  if (scenario === 'ledger-error') {
    ledgerRead.resolve(new Response(null, { status: 503 }));
    await settle();
    expect(latest()).toMatchObject({ count: 3, alert: false, state: 'unavailable' });
    expect(latest().label).toContain('saved task alerts unavailable');
    expect(latest().label).toContain('1 active operation, 2 pending restore requests');
    expect(latest().title).toContain('retry');
    expect(gets).toBe(1);
    await act(async () => {
      link.onClick();
    });
    await settle();
    expect(gets).toBe(2);
    expect(latest()).toMatchObject({ count: 3, alert: false, state: 'unavailable' });
  } else {
    ledgerRead.resolve(Response.json({ version: 1, keys: savedKeys }));
    await settle();
    expect(latest().state).toBe('ready');
    if (scenario === 'acknowledged-reload') {
      expect(views.every((view) => view.count === null && !view.alert)).toBe(true);
    } else if (scenario === 'new-unread') {
      expect(latest()).toMatchObject({ count: 1, alert: true });
      expect(latest().label).toContain('1 new alert');
    } else if (scenario === 'stale-ledger-error') {
      expect(latest()).toMatchObject({ count: 16, alert: true, state: 'ready' });
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['task-attention'] });
      });
      await settle();
      expect(latest()).toMatchObject({ count: null, alert: false, state: 'unavailable' });
      expect(latest().label).not.toContain('new alert');
    } else if (scenario === 'tasks-poll') {
      expect(posts).toHaveLength(0);
      await refresh();
      await refresh();
      expect(posts).toHaveLength(0);
      await act(async () => {
        tasks.push(record(99));
        client.setQueryData(['tasks'], history());
      });
      await settle();
      const newKey = taskAttentionKey(record(99));
      if (!newKey) throw new Error('Expected the new failure to have an attention key');
      expect(posts).toEqual([[newKey]]);
      await refresh();
      expect(posts).toHaveLength(1);
    } else if (scenario === 'tasks-failed-save') {
      expect(posts).toEqual([oldKeys]);
      await refresh();
      expect(posts).toHaveLength(1);
      firstSave.resolve(new Response(null, { status: 503 }));
      await settle();
      expect(saveErrors).toBe(1);
      await refresh();
      expect(posts).toEqual([oldKeys, oldKeys]);
      await refresh();
      expect(posts).toHaveLength(2);
    } else throw new Error('Unknown fixture scenario');
  }
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, realQueryClient: true, network: false, layout: false }));
} finally {
  await act(async () => {
    root.unmount();
  });
  await client.cancelQueries();
  client.clear();
}
