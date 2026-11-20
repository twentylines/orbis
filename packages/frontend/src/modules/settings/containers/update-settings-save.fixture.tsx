import { expect, mock } from 'bun:test';
import { act, Children, isValidElement, type ReactNode } from 'react';
import type { SettingToggle } from '../hooks/use-autosaved-toggle';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
mock.module('@/context/app-context', () => ({
  useAppContext: () => ({ user: { operator: true }, userSettings: { advancedSettings: true } }),
}));
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
const switches = new Map<string, SettingToggle>();
mock.module('@/components/ui/Alert/Alert', () => ({ InlineFeedback: () => null }));
let timeInput!: { value: string | null; onChange: (value: string) => void };
const TimeInputProbe = () => null;
mock.module('@/components/ui/TimeField/TimeField', () => ({
  TimeField: TimeInputProbe,
  useTimeField: (options: typeof timeInput) => {
    timeInput = options;
    return { value: options.value, finish: () => Boolean(options.value && /^\d{2}:\d{2}$/.test(options.value)) };
  },
}));
const { createRoot } = await import('react-dom/client');
const { useSettingToggles } = await import('../hooks/use-setting-toggles');
const { AutosavedSettingSwitch } = await import('../components/autosaved-setting-switch');
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
        settings: {
          ...core.settings,
          orbis: body.orbis,
          apps: body.apps ?? core.settings.apps,
          schedule: { ...core.settings.schedule, ...body.schedule },
        },
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
function childToggle(node: ReactNode): SettingToggle | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; toggle?: SettingToggle }>(child)) continue;
    if (child.type === AutosavedSettingSwitch) return child.props.toggle;
    const nested = childToggle(child.props.children);
    if (nested) return nested;
  }
}

let commitTime: ((next: string) => void) | undefined;
function findTimeCommit(node: ReactNode): typeof commitTime {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onCommit?: typeof commitTime }>(child)) continue;
    if (child.type === TimeInputProbe) return child.props.onCommit;
    const nested = findTimeCommit(child.props.children);
    if (nested) return nested;
  }
}
function ScheduleProbe() {
  const view = kind === 'system' ? SystemUpdatesSettings() : AutomaticUpdatesSettings({ mode: kind === 'apps' ? 'apps' : 'all' });
  commitTime = findTimeCommit(view);
  const toggle = childToggle(view);
  if (toggle) switches.set('schedule', toggle);
  return null;
}
function PolicyProbe() {
  const control = AutomaticAppUpdateSwitch();
  switches.set('settings', required(childToggle(control)));
  switches.set('search', required(useSettingToggles(['store-app-updates'])['store-app-updates']));
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
    await Bun.sleep(5);
  });
};
const edit = (time = '17:30') => flush(() => timeInput.onChange(time));
const commit = async () => {
  await flush(() => required(commitTime)(required(timeInput.value)));
  await flush(() => undefined);
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
const setPolicy = (name: 'settings' | 'search', value: boolean) => flush(() => required(switches.get(name)).setChecked(value));
const holdFirstWrite = () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  intercept = (request) => (request.method === 'PUT' ? held : undefined);
  return release;
};

try {
  await flush(render);
  if (kind === 'policy') {
    if (scenario === 'policy-shared-auto-save') {
      await setPolicy('search', true);
      expect(puts()).toHaveLength(1);
      expect(required(puts()[0]).body).toMatchObject({ apps: { enabled: true }, schedule: { time: '04:00' }, expectedRevision: 1 });
      expect([...switches.values()].map((control) => control.checked)).toEqual([true, true]);
    } else if (scenario === 'policy-error-retry') {
      intercept = (request) =>
        request.method === 'PUT' ? Promise.resolve(Response.json({ message: 'Temporarily unavailable' }, { status: 503 })) : undefined;
      await setPolicy('settings', true);
      expect([...switches.values()].map((control) => control.checked)).toEqual([false, false]);
      expect(required(switches.get('search')).error).toBe('Temporarily unavailable');
      intercept = undefined;
      await flush(() => required(required(switches.get('search')).retry)());
      expect([...switches.values()].map((control) => control.checked)).toEqual([true, true]);
      expect(puts()).toHaveLength(2);
    } else {
      const oldResponse = structuredClone(core);
      const release = holdFirstWrite();
      await setPolicy('settings', true);
      expect(puts()).toHaveLength(1);
      expect(required(switches.get('search')).pending).toBe(true);
      await setPolicy('search', true);
      expect(client.getMutationCache().findAll({ mutationKey: ['setting-toggle', 'store-app-updates'] })).toHaveLength(1);
      if (scenario !== 'policy-late-ack') {
        await setPolicy('search', false);
        expect(puts()).toHaveLength(1);
        expect([...switches.values()].map((control) => control.checked)).toEqual([false, false]);
      }
      if (scenario === 'policy-newer-draft') {
        core = { ...core, revision: 2, settings: { ...core.settings, apps: { enabled: true } } };
        intercept = undefined;
        await flush(() => release(Response.json(core)));
        expect(puts()).toHaveLength(2);
        expect(required(puts()[1]).body).toMatchObject({ apps: { enabled: false }, expectedRevision: 2 });
        expect(required(switches.get('settings')).pending).toBe(false);
        expect(core.settings.apps?.enabled).toBe(false);
      } else {
        await switchSession();
        expect(required(puts()[0]).signal?.aborted).toBe(true);
        intercept = undefined;
        await flush(() => release(Response.json(oldResponse)));
        expect(puts()).toHaveLength(1);
        expect(client.getQueryData<AutomaticUpdateStatus>(coreKey)?.revision).toBe(100);
        expect(required(switches.get('search')).checked).toBe(false);
      }
    }
  } else {
    await edit();
    expect(puts()).toHaveLength(0);
    if (scenario.endsWith('queued-session')) {
      let release!: (value: Response) => void;
      const waiting = new Promise<Response>((resolve) => {
        release = resolve;
      });
      intercept = (request) => (request.method === 'GET' ? waiting : undefined);
      await commit();
      await switchSession();
      await flush(() => release(Response.json(kind === 'system' ? system : core)));
      expect(puts()).toHaveLength(0);
    } else if (scenario.endsWith('late-ack')) {
      const release = holdFirstWrite();
      const oldResponse = structuredClone(kind === 'system' ? system : core);
      await commit();
      expect(puts()).toHaveLength(1);
      await switchSession();
      expect(required(puts()[0]).signal?.aborted).toBe(true);
      await edit('19:45');
      await flush(() => release(Response.json(oldResponse)));
      if (kind === 'system') expect(client.getQueryData<SystemUpdateSchedule>(systemKey)?.revision).toBe(100);
      else expect(client.getQueryData<AutomaticUpdateStatus>(coreKey)?.revision).toBe(100);
      expect(timeInput.value).toBe('19:45');
    } else if (scenario.endsWith('newer-draft')) {
      const release = holdFirstWrite();
      await commit();
      expect(puts()).toHaveLength(1);
      await edit('19:45');
      if (kind === 'system') system = { ...system, revision: 2, settings: { ...system.settings, schedule: { time: '17:30', timezone: 'UTC' } } };
      else if (kind === 'apps') core = { ...core, revision: 2, settings: { ...core.settings, schedule: { time: '17:30', timezone: 'UTC' } } };
      else core = { ...core, revision: 2, orbisSchedule: { time: '17:30', timezone: 'UTC' } };
      await flush(() => release(Response.json(kind === 'system' ? system : core)));
      expect(timeInput.value).toBe('19:45');
      intercept = undefined;
      await commit();
      expect(puts()).toHaveLength(2);
      expect(timeInput.value).toBe('19:45');
    } else if (scenario === 'apps-preserve-policy' || scenario === 'core-preserve-policy') {
      core = { ...core, revision: 7, settings: { ...core.settings, apps: { enabled: true }, schedule: { time: '05:00', timezone: 'UTC' } } };
      await commit();
      expect(puts()).toHaveLength(1);
      expect(required(puts()[0]).body).toMatchObject({ expectedRevision: 7 });
      expect(required(puts()[0]).body).not.toHaveProperty('apps');
      expect(core.settings.apps?.enabled).toBe(true);
      if (kind === 'apps') expect(required(puts()[0]).body).toMatchObject({ schedule: { time: '17:30' } });
      else expect(required(puts()[0]).body).toMatchObject({ schedule: { time: '05:00' }, orbisSchedule: { time: '17:30' } });
    } else if (scenario.endsWith('toggle-keeps-time-draft')) {
      await flush(() => required(switches.get('schedule')).setChecked(true));
      expect(puts()).toHaveLength(1);
      expect(required(switches.get('schedule')).checked).toBe(true);
      expect(timeInput.value).toBe('17:30');
      if (kind === 'system') {
        expect(required(puts()[0]).body).toEqual({ enabled: true, expectedRevision: 1 });
        expect(system.settings.schedule?.time).toBe('06:00');
      } else {
        expect(required(puts()[0]).body).not.toHaveProperty('orbisSchedule');
        expect(core.orbisSchedule?.time).toBe('03:00');
      }
      await commit();
      expect(puts()).toHaveLength(2);
      expect(kind === 'system' ? system.settings.enabled : core.settings.orbis.enabled).toBe(true);
    } else throw new Error('Unknown fixture scenario');
  }
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  await flush(() => root.unmount());
  client.clear();
}
