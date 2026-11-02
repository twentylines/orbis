import { expect, mock } from 'bun:test';
import { act, Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

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
const { Controller } = await import('react-hook-form');
const { Switch } = await import('@/components/ui/Switch');
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
let saved = 0;
const initial = { advancedSettings: false };
function flatten(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...flatten(child.props.children as ReactNode)] : [],
  );
}
function Probe() {
  currentTree = UserSettingsForm({
    initialValues: initial,
    onSubmit: () => {
      saved++;
    },
  });
  const controller = flatten(currentTree).find((item) => item.type === Controller && item.props.name === 'advancedSettings');
  if (!controller) throw new Error('Advanced settings controller missing');
  const render = controller.props.render as (value: unknown) => ReactNode;
  return cloneElement(controller, {
    render: (value: unknown) => {
      switchProps = flatten(render(value)).find((item) => item.type === Switch)?.props;
      return null;
    },
  });
}
const flush = async (action: () => void) =>
  act(async () => {
    action();
    await Bun.sleep(2);
  });
try {
  await flush(() => root.render(<Probe />));
  expect(switchProps?.checked).toBe(false);
  expect(flatten(currentTree).some((item) => item.props.name === 'persistTraefikConfig')).toBe(false);
  expect(flatten(currentTree).find((item) => item.props.id === 'setting-localDomain')?.props.disabled).toBe(true);
  await flush(() => (switchProps?.onCheckedChange as (value: boolean) => void)(true));
  expect(switchProps?.checked).toBe(true);
  expect(flatten(currentTree).some((item) => item.props.name === 'persistTraefikConfig')).toBe(true);
  expect(flatten(currentTree).find((item) => item.props.id === 'setting-localDomain')?.props.disabled).toBe(false);
  expect(saved).toBe(0);
  await flush(() => (switchProps?.onCheckedChange as (value: boolean) => void)(false));
  expect(flatten(currentTree).some((item) => item.props.name === 'persistTraefikConfig')).toBe(false);
  expect(saved).toBe(0);
  process.stdout.write(JSON.stringify({ toggleUpdatesDraft: true, noSaveOnToggle: true }));
} finally {
  await flush(() => root.unmount());
}
