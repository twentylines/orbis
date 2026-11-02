import { expect, mock } from 'bun:test';
import { act, Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { BackupSnapshot, ImportJob, RestoreJob } from './contracts';

// The null host exercises real mounted hooks and handlers, without browser layout.
const doc = {
  nodeType: 9,
  visibilityState: 'visible',
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  activeElement: null,
  documentElement: {
    dataset: {},
    style: {
      setProperty() {
        return undefined;
      },
      removeProperty() {
        return undefined;
      },
    },
  },
  body: { nodeName: 'BODY' },
  defaultView: null as object | null,
};
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  setTimeout,
  clearTimeout,
  matchMedia: () => ({
    matches: false,
    addEventListener() {
      return undefined;
    },
    removeEventListener() {
      return undefined;
    },
  }),
};
doc.defaultView = win;
const storage = new Map<string, string>();
Object.assign(globalThis, {
  window: win,
  document: doc,
  HTMLElement: win.HTMLElement,
  matchMedia: win.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const NativeFormData = FormData;
class SubmittedValues extends NativeFormData {
  constructor(form?: unknown) {
    super();
    if (form && typeof form === 'object' && 'secret' in form) this.set('passphrase', (form as { secret: { value: string } }).secret.value);
  }
}
Object.assign(globalThis, { FormData: SubmittedValues });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { AppContextProvider } = await import('@/context/app-context');
const { appContextQueryKey } = await import('@/api-client/@tanstack/react-query.gen');
const originalApi = await import('./backup-api');
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
client.setQueryData(appContextQueryKey(), { user: { id: 7, operator: true, totpEnabled: true } });
client.setQueryData(['account-security', 7], { version: 1, revision: 0, requireCaptureAuthentication: false, requireRestoreAuthentication: false });
const snapshot: BackupSnapshot = {
  exports: { available: true, retentionHours: 24, jobs: [] },
  imports: { available: true, retentionHours: 24, jobs: [] },
  restore: { job: null },
};
const update = () =>
  client.setQueryData(['orbis-full-backups', 7], { ...snapshot, imports: { ...snapshot.imports }, restore: { ...snapshot.restore } });
update();
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const restoredId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let imported: ImportJob = {
  id,
  createdAt: 1,
  updatedAt: 2,
  status: 'awaiting-upload',
  stage: 'upload',
  uploadedBytes: 0,
  completedBytes: 0,
  totalBytes: 100,
  message: '',
};
let transferMode: 'wait' | 'complete' = 'wait';
const requests: { path: string; body?: unknown }[] = [];
const accepted: RestoreJob = {
  id: restoredId,
  status: 'ready',
  stage: 'preparing',
  phase: 'prepared',
  message: 'Ready',
  needsRecovery: false,
  progressUnavailable: false,
  canCancel: true,
  canRecover: false,
};
const request = async (path: string, _method = 'GET', body?: unknown) => {
  requests.push({ path, body });
  if (path.endsWith('/reuse')) imported = { ...imported, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'uploaded', uploadedBytes: 100 };
  if (path.endsWith('/cancel')) imported = { ...imported, status: 'cancelled' };
  if (path.endsWith('/review'))
    imported = {
      ...imported,
      status: 'reviewed',
      stage: 'complete',
      reviewExpiresAt: Date.now() + 60_000,
      review: {
        formatVersion: 1,
        createdAt: 1,
        orbisVersion: '1.0.0',
        runtipiVersion: '4.10.1',
        architecture: 'arm64',
        fileCount: 1,
        appCount: 0,
        expandedBytes: 100,
        manifestSha256: 'a'.repeat(64),
        databaseValidation: 'validated',
        compatibility: { compatible: true, blockers: [], architectureChanged: false },
      },
    };
  if (path === '/restores') {
    snapshot.restore = {
      job: {
        ...accepted,
        id: requests.filter((item) => item.path === '/restores').length > 1 ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : accepted.id,
      },
    };
    update();
    return snapshot.restore.job;
  }
  snapshot.imports = { ...snapshot.imports, jobs: [imported] };
  update();
  return path === '/imports' ? snapshot.imports : imported;
};
mock.module('./backup-api', () => ({
  ...originalApi,
  backupRequest: request,
  readBackups: async () => snapshot,
  createImport: async () => {
    imported = { ...imported, status: 'awaiting-upload', uploadedBytes: 0 };
    return imported;
  },
  uploadBackup: async (_id: string, file: File, signal: AbortSignal, progress: (done: number, total: number) => void) => {
    imported = { ...imported, status: 'uploading', uploadedBytes: 1 };
    snapshot.imports = { ...snapshot.imports, jobs: [imported] };
    update();
    progress(1, file.size);
    if (transferMode === 'wait')
      return new Promise<ImportJob>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }),
      );
    imported = { ...imported, status: 'uploaded', uploadedBytes: file.size };
    snapshot.imports = { ...snapshot.imports, jobs: [imported] };
    update();
    return imported;
  },
}));
mock.module('@/components/recovery-progress/use-restore-departure', () => ({
  useRestoreDeparture: (job: RestoreJob | null) => ({ departing: job?.status === 'rolled-back', storageFailed: false }),
}));
const { SystemBackupsSettings } = await import('./system-backups-settings');
const { RecoveryScene } = await import('@/components/recovery-progress/recovery-scene');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  if (String(url).includes('/api/system/operation-status')) return new Response(JSON.stringify({ state: 'idle' }));
  throw new Error('Unexpected fixture request');
}) as typeof fetch;
const secret = { value: 'archive-key' };
const form = {
  secret,
  querySelectorAll: () => [secret],
  querySelector: () => ({
    focus() {
      return undefined;
    },
  }),
  reset: () => {
    secret.value = '';
  },
};
let tree: ReactNode = null;
let dismissed = 0;
let generation = 0;
let initialImportId: string | undefined;
function flatten(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...flatten(child.props.children as ReactNode)] : [],
  );
}
function Probe() {
  tree = SystemBackupsSettings({
    restoreOnly: true,
    embedded: true,
    recoveryScene: true,
    initialImportId,
    onDismiss: () => {
      dismissed++;
    },
  });
  const entry = flatten(tree).find((element) => element.type === 'form');
  const ref = entry?.props.ref as { current: unknown } | undefined;
  if (ref) ref.current = form;
  return null;
}
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  textContent: '',
  appendChild() {
    return undefined;
  },
  removeChild() {
    return undefined;
  },
};
const root = createRoot(container as unknown as HTMLElement);
const flush = async (action: () => unknown) =>
  act(async () => {
    await action();
    await Bun.sleep(5);
  });
const render = () =>
  root.render(
    <QueryClientProvider client={client}>
      <AppContextProvider>
        <Probe key={generation} />
      </AppContextProvider>
    </QueryClientProvider>,
  );
const handler = (entry: ReactElement<Record<string, unknown>> | undefined, key: string) => {
  const value = entry?.props[key];
  if (typeof value !== 'function') throw new Error(`Missing fixture handler ${key}`);
  return value as (event?: unknown) => unknown;
};
const chooseFile = () =>
  handler(
    flatten(tree).find((element) => element.type === 'input' && element.props.type === 'file'),
    'onChange',
  )({ currentTarget: { files: [new File(['x'.repeat(100)], 'fixture.orbis')], value: '' } });
const submit = () =>
  handler(
    flatten(tree).find((element) => element.type === 'form'),
    'onSubmit',
  )({
    preventDefault() {
      return undefined;
    },
    currentTarget: form,
  });
try {
  await flush(render);
  expect(flatten(tree).some((element) => element.props.name === 'confirmation')).toBe(false);
  await flush(chooseFile);
  await flush(submit);
  const scene = flatten(tree).find((element) => element.type === RecoveryScene);
  const cancels = flatten(scene?.props.actions as ReactNode).filter((element) => element.props.children === 'Cancel');
  expect(cancels).toHaveLength(1);
  await flush(() => handler(cancels[0], 'onClick')());
  expect(dismissed).toBe(1);
  expect(imported.status).toBe('cancelled');
  expect(requests.some((item) => item.path === '/restores')).toBe(false);
  expect(flatten(tree).some((element) => element.type === 'form')).toBe(true);
  transferMode = 'complete';
  generation++;
  secret.value = 'archive-key';
  snapshot.imports = { ...snapshot.imports, jobs: [] };
  update();
  await flush(render);
  await flush(chooseFile);
  await flush(submit);
  const dispatched = requests.filter((item) => item.path === '/restores');
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.body).toEqual({ importId: id, manifestSha256: 'a'.repeat(64), confirmation: 'replace-server' });
  snapshot.restore = { job: { ...accepted, status: 'rolled-back', phase: 'rolled-back', stage: 'complete', canCancel: false } };
  client.setQueryData(['orbis-restore-terminal-authority', 7, restoredId], { state: 'idle', supported: true });
  await flush(update);
  const restore = flatten(tree).find((element) => element.props.children === 'Restore');
  expect(restore?.props.disabled).toBe(false);
  const terminalScene = flatten(tree).find((element) => element.type === RecoveryScene);
  expect(terminalScene?.props.open).toBe(false);
  const retry = flatten(tree).find((element) => element.props.children === 'Restore saved backup');
  expect(retry?.props.disabled).toBe(false);
  expect(secret.value).toBe('');
  await flush(() => handler(retry, 'onClick')());
  expect(requests.filter((item) => item.path.endsWith('/reuse'))).toHaveLength(1);
  const repeated = requests.filter((item) => item.path === '/restores');
  expect(repeated).toHaveLength(2);
  expect(repeated[1]?.body).toEqual({
    importId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    manifestSha256: 'a'.repeat(64),
    confirmation: 'replace-server',
  });
  expect(snapshot.restore.job?.id).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  initialImportId = id;
  generation++;
  imported = { ...imported, id, status: 'awaiting-upload', stage: 'upload', uploadedBytes: 0, review: undefined, reviewExpiresAt: undefined };
  snapshot.imports = { ...snapshot.imports, jobs: [imported] };
  snapshot.restore = { job: null };
  update();
  await flush(render);
  expect(flatten(tree).some((element) => element.type === 'input' && element.props.type === 'file')).toBe(true);
  expect(flatten(tree).some((element) => element.props.children === 'Restore')).toBe(true);
  expect(requests.filter((item) => item.path === '/restores')).toHaveLength(2);
  process.stdout.write(
    JSON.stringify({
      mountedReact: true,
      duplicateCancel: false,
      explicitRestoreRequests: 2,
      retainedArchiveRetry: true,
      rollbackIdleUnlocked: true,
      emptyGuidedUploadRetry: true,
      layout: false,
    }),
  );
} finally {
  await flush(() => root.unmount());
  client.clear();
  globalThis.fetch = realFetch;
}
