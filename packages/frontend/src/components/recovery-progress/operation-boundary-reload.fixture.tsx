import { expect, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const values = new Map<string, string>();
const storage = {
  getItem: (name: string) => values.get(name) ?? null,
  setItem: (name: string, value: string) => {
    values.set(name, value);
  },
  removeItem: (name: string) => {
    values.delete(name);
  },
};
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  documentElement: { dataset: {}, getAttribute: () => null },
};
const win = {
  document: doc,
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  setTimeout,
  clearTimeout,
};
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, sessionStorage: storage, IS_REACT_ACT_ENVIRONMENT: true });

let childRenders = 0;
let startupRenders = 0;
const scenes: Array<{ open: boolean; title: string; status?: string; variant: string; progress?: number }> = [];
mock.module('react-router', () => ({
  useLocation: () => ({ pathname: '/dashboard' }),
  useNavigate: () => () => undefined,
  useRevalidator: () => ({
    revalidate() {
      return undefined;
    },
  }),
}));
mock.module('@/desktop/window-visibility', () => ({ useWindowVisible: () => true }));
mock.module('@/components/recovery-progress/use-operation-departure', () => ({ useOperationDeparture: () => ({ departing: false }) }));
mock.module('@/components/startup/startup-surface', () => ({
  StartupSurface: () => {
    startupRenders++;
    return null;
  },
}));
mock.module('@/components/recovery-progress/recovery-scene', () => ({
  RecoveryScene: (value: (typeof scenes)[number]) => {
    scenes.push(value);
    return null;
  },
}));
mock.module('@/components/ui/Dialog', () => ({ Dialog: () => null, DialogContent: () => null, DialogHeader: () => null, DialogTitle: () => null }));
mock.module('@/components/ui/Input', () => ({ Input: () => null }));
mock.module('@/components/ui/Button', () => ({ Button: () => null }));
mock.module('@/modules/system-reset/system-reset', () => ({ SystemResetWizard: () => null }));
mock.module('@/modules/system-backups/backup-api', () => ({
  backupRequest: () => {
    throw new Error('Unexpected restore action');
  },
}));
Object.assign(globalThis, { fetch: () => new Promise(() => undefined) });

const { OperationBoundary } = await import('./operation-boundary');
const { operationContinuityStorageName } = await import('./operation-continuity');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const container = () => ({
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  textContent: '',
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  appendChild() {
    return undefined;
  },
  removeChild() {
    return undefined;
  },
});
function Child() {
  childRenders++;
  return null;
}
const results = [];
for (const kind of ['active', 'terminal-hint', 'expired', 'unrelated-restore'] as const) {
  values.clear();
  scenes.length = 0;
  startupRenders = 0;
  childRenders = 0;
  const marker = {
    version: 1,
    jobId: id,
    operation: kind === 'unrelated-restore' ? 'restore' : 'update',
    savedAt: Date.now() - (kind === 'expired' ? 31 * 60_000 : 0),
    phase: 'running',
    ...(kind === 'unrelated-restore' ? {} : { targetTag: 'v0.9.2', corePhase: kind === 'terminal-hint' ? 'ready' : 'downloading' }),
  };
  storage.setItem(operationContinuityStorageName, JSON.stringify(marker));
  const root = createRoot(container() as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <OperationBoundary>
        <Child />
      </OperationBoundary>,
    );
  });
  const open = scenes.filter((value) => value.open).at(-1);
  if (kind === 'active' || kind === 'terminal-hint') {
    expect(open?.title).toBe(kind === 'active' ? 'Downloading Orbis' : 'Starting Orbis');
    expect(open?.status).toBe('Reconnecting to update progress');
    expect(open?.variant).toBe('update');
    expect(open?.progress).toBeUndefined();
    expect(childRenders).toBe(0);
  } else {
    expect(open).toBeUndefined();
    expect(startupRenders).toBeGreaterThan(0);
  }
  await act(async () => {
    root.unmount();
  });
  results.push({ kind, progressVisibleBeforeNetwork: Boolean(open), workspaceReleased: childRenders > 0 });
}
process.stdout.write(JSON.stringify(results));
