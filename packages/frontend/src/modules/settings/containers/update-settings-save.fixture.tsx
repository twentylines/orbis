import { expect, mock } from 'bun:test';
import { act, useId } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SettingsSaveEntry } from '../helpers/settings-save-plan';
import type { AutomaticUpdateStatus, SystemUpdateSchedule } from '@/desktop/automatic-updates-api';
const events = new EventTarget();
// React mounts its real provider/hooks; the null-output host does not model browser layout.
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
  defaultView: {} as object,
};
const win = {
  _goober: { parentNode: true, firstChild: { data: '' } },
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
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
Object.assign(globalThis, {
  window: win,
  document: doc,
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {
      return undefined;
    },
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
let session = { epoch: {}, controller: new AbortController() };
mock.module('@/context/user-context', () => ({
  useUserContext: () => ({ isLoggedIn: true, sessionEpoch: session.epoch, sessionAbortSignal: session.controller.signal }),
}));
mock.module('@/desktop/preferences', () => ({
  useDesktopPreferences: () => ({
    preferences: { appearance: { timeFormat: '24' } },
    updateAppearance() {
      return undefined;
    },
  }),
}));
const required = <T,>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing fixture value');
  return value;
};
const entries = new Map<string, SettingsSaveEntry>();
mock.module('../pages/settings-save', () => ({
  useSettingsSave: (entry: SettingsSaveEntry) => {
    entries.set(useId(), entry);
    return { shared: true, pending: false };
  },
}));
type SwitchProps = { checked: boolean; onCheckedChange: (value: boolean) => void };
const switches = new Map<string, SwitchProps>();
mock.module('@/components/ui/Switch', () => ({
  Switch: (props: SwitchProps) => {
    switches.set(useId(), props);
    return null;
  },
}));
mock.module('@/components/ui/Alert/Alert', () => ({ InlineFeedback: () => null }));
let timeInput!: { value: string | null; onChange: (value: string) => void };
mock.module('@/components/ui/TimeField/TimeField', () => ({
  TimeField: () => null,
  useTimeField: (options: typeof timeInput) => {
    timeInput = options;
    return { value: options.value, finish: () => Boolean(options.value && /^\d{2}:\d{2}$/.test(options.value)) };
  },
}));
const { createRoot } = await import('react-dom/client');
const { AppUpdatePolicyProvider, AutomaticAppUpdateSwitch } = await import('./app-update-policy');
const { AutomaticUpdatesSettings } = await import('./automatic-updates-settings');
const { SystemUpdatesSettings } = await import('./system-updates-settings');
const { automaticUpdateSettingsOptions, systemUpdateScheduleOptions } = await import('@/desktop/automatic-updates-api');
const coreKey = automaticUpdateSettingsOptions().queryKey;
const systemKey = systemUpdateScheduleOptions().queryKey;
let core: AutomaticUpdateStatus = {
  available: true,
  capabilities: ['independent-schedules.v1'],
  revision: 1,
  settings: { orbis: { enabled: false, mode: 'idle' }, apps: { enabled: false }, schedule: { time: '04:00', timezone: 'UTC' } },
  orbisSchedule: { time: '03:00', timezone: 'UTC' },
};
let system: SystemUpdateSchedule = {
  available: true,
  capabilities: ['independent-schedules.v1'],
  revision: 1,
  settings: { enabled: false, schedule: { time: '06:00', timezone: 'UTC' } },
  shared: { time: '04:00', timezone: 'UTC' },
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
client.setQueryData(coreKey, core);
client.setQueryData(systemKey, system);
type Request = { path: string; method: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined };
const requests: Request[] = [];
let intercept: ((request: Request) => Promise<Response> | undefined) | undefined;
Object.assign(globalThis, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { path: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')), signal: init?.signal };
    if (!['/api/host-updates/automatic', '/api/host-updates/automatic/system'].includes(request.path) || !['GET', 'PUT'].includes(request.method))
      throw new Error('Unexpected fixture request');
    requests.push(request);
    const pending = intercept?.(request);
    if (pending) return pending;
    if (request.path.endsWith('/system')) {
      if (request.method === 'PUT')
        system = {
          ...system,
          revision: (system.revision ?? 0) + 1,
          settings: {
            enabled: request.body.enabled as boolean,
            schedule: request.body.schedule
              ? { ...required(system.settings.schedule), ...(request.body.schedule as { time: string }) }
              : system.settings.schedule,
          },
        };
      return Response.json(system);
    }
    if (request.method === 'PUT') {
      const body = request.body as {
        orbis: AutomaticUpdateStatus['settings']['orbis'];
        apps?: { enabled: boolean };
        schedule: { time: string };
        orbisSchedule?: { time: string };
      };
      core = {
        ...core,
        revision: (core.revision ?? 0) + 1,
        settings: { ...core.settings, orbis: body.orbis, apps: body.apps, schedule: { ...core.settings.schedule, ...body.schedule } },
        orbisSchedule: { ...required(core.orbisSchedule), ...body.orbisSchedule },
      };
    }
    return Response.json(core);
  },
});
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
const scenario = process.argv[2] ?? '';
const kind = scenario.startsWith('apps-') ? 'apps' : scenario.startsWith('core-') ? 'core' : scenario.startsWith('system-') ? 'system' : 'policy';
function ScheduleProbe() {
  // Real hooks run; only the returned view is discarded. This does not model browser layout.
  if (kind === 'system') SystemUpdatesSettings();
  else AutomaticUpdatesSettings({ mode: kind === 'apps' ? 'apps' : 'all' });
  return null;
}
function PolicyProbe() {
  const store = AutomaticAppUpdateSwitch({ section: 'store' });
  const updates = AutomaticAppUpdateSwitch({ section: 'updates' });
  switches.set('store', store.props.children[0].props);
  switches.set('updates', updates.props.children[0].props);
  return null;
}
const render = () =>
  root.render(
    <QueryClientProvider client={client}>
      {kind === 'policy' ? (
        <AppUpdatePolicyProvider>
          <PolicyProbe />
        </AppUpdatePolicyProvider>
      ) : (
        <ScheduleProbe />
      )}
    </QueryClientProvider>,
  );
const flush = async (fn: () => void | Promise<void>) => {
  await act(async () => {
    await fn();
    await Bun.sleep(2);
  });
};
const entry = () => {
  expect(entries.size).toBe(1);
  return required([...entries.values()][0]);
};
const edit = async (time = '17:30') =>
  flush(() => {
    if (kind === 'policy') required([...switches.values()][0]).onCheckedChange(true);
    else timeInput.onChange(time);
  });
const prepare = async () => {
  expect(entry().dirty).toBe(true);
  const commit = await entry().prepare();
  expect(commit).not.toBeNull();
  return required(commit);
};
const switchSession = async () => {
  session.controller.abort(new DOMException('Session changed', 'AbortError'));
  session = { epoch: {}, controller: new AbortController() };
  core = { ...core, revision: 100, settings: { ...core.settings, apps: { enabled: false }, schedule: { time: '08:00', timezone: 'UTC' } } };
  system = { ...system, revision: 100, settings: { enabled: false, schedule: { time: '09:00', timezone: 'UTC' } } };
  await flush(() => {
    client.setQueryData(coreKey, core);
    client.setQueryData(systemKey, system);
    render();
  });
};
const puts = () => requests.filter((request) => request.method === 'PUT');
try {
  await flush(render);
  await edit();
  const commit = await prepare();
  if (scenario.endsWith('queued-session')) {
    await switchSession();
    const before = requests.length;
    let outcome: unknown;
    await flush(async () => {
      outcome = await commit().catch((error: unknown) => error);
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(requests.length).toBe(before);
    expect(puts()).toHaveLength(0);
  } else if (scenario.endsWith('late-ack')) {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const oldResponse = structuredClone(kind === 'system' ? system : core);
    intercept = (request) => (request.method === 'PUT' ? pending : undefined);
    let outcome!: Promise<unknown>;
    await flush(() => {
      outcome = commit().catch((error: unknown) => error);
    });
    expect(puts()).toHaveLength(1);
    await switchSession();
    expect(required(puts()[0]).signal?.aborted).toBe(true);
    await edit('19:45');
    await flush(async () => {
      release(Response.json(oldResponse));
      expect(await outcome).toBeInstanceOf(Error);
    });
    expect(entry().dirty).toBe(true);
    if (kind === 'system') expect(client.getQueryData<SystemUpdateSchedule>(systemKey)?.revision).toBe(100);
    else expect(client.getQueryData<AutomaticUpdateStatus>(coreKey)?.revision).toBe(100);
    if (kind !== 'policy') expect(timeInput.value).toBe('19:45');
  } else if (scenario.endsWith('newer-draft')) {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    intercept = (request) => (request.method === 'PUT' ? pending : undefined);
    let outcome!: Promise<void>;
    await flush(() => {
      outcome = commit();
    });
    expect(puts()).toHaveLength(1);
    await flush(() => {
      if (kind === 'policy') required([...switches.values()][0]).onCheckedChange(false);
      else timeInput.onChange('19:45');
    });
    if (kind === 'system') system = { ...system, revision: 2, settings: { ...system.settings, schedule: { time: '17:30', timezone: 'UTC' } } };
    else if (kind === 'apps') core = { ...core, revision: 2, settings: { ...core.settings, schedule: { time: '17:30', timezone: 'UTC' } } };
    else if (kind === 'core') core = { ...core, revision: 2, orbisSchedule: { time: '17:30', timezone: 'UTC' } };
    else core = { ...core, revision: 2, settings: { ...core.settings, apps: { enabled: true } } };
    await flush(async () => {
      release(Response.json(kind === 'system' ? system : core));
      await outcome;
    });
    expect(entry().dirty).toBe(true);
    if (kind !== 'policy') expect(timeInput.value).toBe('19:45');
    else expect([...switches.values()].map((control) => control.checked)).toEqual([false, false]);
    intercept = undefined;
    const next = await prepare();
    await flush(next);
    expect(puts()).toHaveLength(2);
    expect(entry().dirty).toBe(false);
  } else if (scenario === 'policy-shared-draft') {
    expect([...switches.values()].map((control) => control.checked)).toEqual([true, true]);
    await flush(commit);
    expect(puts()).toHaveLength(1);
    expect(required(puts()[0]).body).toMatchObject({ apps: { enabled: true }, schedule: { time: '04:00' }, expectedRevision: 1 });
    expect(entry().dirty).toBe(false);
  } else if (scenario === 'apps-preserve-policy' || scenario === 'core-preserve-policy') {
    core = { ...core, revision: 7, settings: { ...core.settings, apps: { enabled: true }, schedule: { time: '05:00', timezone: 'UTC' } } };
    await flush(commit);
    expect(puts()).toHaveLength(1);
    expect(required(puts()[0]).body).toMatchObject({ apps: { enabled: true }, expectedRevision: 7 });
    if (kind === 'apps') expect(required(puts()[0]).body).toMatchObject({ schedule: { time: '17:30' } });
    else expect(required(puts()[0]).body).toMatchObject({ schedule: { time: '05:00' }, orbisSchedule: { time: '17:30' } });
  } else throw new Error('Unknown fixture scenario');
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  await flush(() => root.unmount());
  client.clear();
}
