import { expect, mock } from 'bun:test';
import { act, Children, isValidElement, useState, type ReactElement, type ReactNode } from 'react';

// This mounts real React hooks on the existing null-output host; the stub portal target does not model browser layout or hit-testing.
const events = new EventTarget();
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
  HTMLElement: win.HTMLElement,
  document: doc,
  matchMedia: win.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { createRoot } = await import('react-dom/client');
const { AutosavedSettingSwitch } = await import('../autosaved-setting-switch');
const { UserSettingsForm } = await import('./user-settings-form');
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
let currentTree: ReactNode = null;
let switchProps: Record<string, unknown> | undefined;
let submitted = 0;
const changes: boolean[] = [];
const initial = { advancedSettings: false };
const choice = (id: string, checked = false, setChecked: (value: boolean) => void = () => undefined) => ({
  id,
  checked,
  setChecked,
  pending: false,
  saved: false,
  disabled: false,
  error: null,
  retry: undefined,
});
function flatten(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...flatten(child.props.children as ReactNode)] : [],
  );
}
function Probe() {
  const [advanced, setAdvanced] = useState(false);
  currentTree = UserSettingsForm({
    initialValues: initial,
    onSubmit: () => {
      submitted++;
    },
    toggles: {
      'guest-dashboard': choice('guest-dashboard'),
      'persist-proxy': choice('persist-proxy'),
      'advanced-settings': choice('advanced-settings', advanced, (checked) => {
        changes.push(checked);
        setAdvanced(checked);
      }),
    },
  });
  switchProps = flatten(currentTree).find((item) => item.type === AutosavedSettingSwitch && item.props.id === 'setting-advancedSettings')?.props
    .toggle as Record<string, unknown> | undefined;
  return null;
}
const flush = async (action: () => void) =>
  act(async () => {
    action();
    await Bun.sleep(2);
  });
try {
  await flush(() => root.render(<Probe />));
  expect(switchProps?.checked).toBe(false);
  expect(flatten(currentTree).some((item) => item.props.id === 'setting-persistTraefikConfig')).toBe(false);
  expect(flatten(currentTree).find((item) => item.props.id === 'setting-localDomain')?.props.disabled).toBe(true);
  await flush(() => (switchProps?.setChecked as (value: boolean) => void)(true));
  expect(switchProps?.checked).toBe(true);
  expect(flatten(currentTree).some((item) => item.props.id === 'setting-persistTraefikConfig')).toBe(true);
  expect(flatten(currentTree).find((item) => item.props.id === 'setting-localDomain')?.props.disabled).toBe(false);
  expect(submitted).toBe(0);
  await flush(() => (switchProps?.setChecked as (value: boolean) => void)(false));
  expect(flatten(currentTree).some((item) => item.props.id === 'setting-persistTraefikConfig')).toBe(false);
  expect(submitted).toBe(0);
  expect(changes).toEqual([true, false]);
  process.stdout.write(JSON.stringify({ switchesImmediate: true, noTextSubmit: true }));
} finally {
  await flush(() => root.unmount());
}
