import { expect } from 'bun:test';
import { act, Children, isValidElement, type ReactElement, type ReactNode } from 'react';

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
  document: doc,
  matchMedia: win.matchMedia,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { RouteHeaderToolbar, RouteHeaderToolbarContext } = await import('@/desktop/route-header-toolbar');
const { SettingsSearch } = await import('./settings-workspace');
const { SettingsSaveProvider, SettingsSaveButton, useSettingsSave } = await import('./settings-save');

const target = { nodeType: 1, ownerDocument: doc } as unknown as HTMLElement;
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
type PortalSnapshot = { containerInfo: HTMLElement; children: ReactNode };
let portal: PortalSnapshot | null = null;
let selected: string | undefined;
let saveButton: ReactElement<Record<string, unknown>> | null = null;
const eventsSeen: string[] = [];

function flatten(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...flatten(child.props.children as ReactNode)] : [],
  );
}

function Probe() {
  const search = SettingsSearch({
    access: { operator: true, advanced: true, http: true },
    onSetting: (entry) => {
      selected = entry.id;
    },
  });
  const createdPortal = RouteHeaderToolbar({ children: search });
  portal = createdPortal ? (createdPortal as unknown as PortalSnapshot) : null;
  useSettingsSave({
    section: 'general',
    dirty: true,
    pending: false,
    prepare: async () => {
      eventsSeen.push('prepare');
      return async () => {
        eventsSeen.push('commit');
      };
    },
  });
  saveButton = SettingsSaveButton() as ReactElement<Record<string, unknown>>;
  return null;
}

const render = () =>
  root.render(
    <RouteHeaderToolbarContext.Provider value={target}>
      <SettingsSaveProvider onSection={() => eventsSeen.push('failed')}>
        <Probe />
      </SettingsSaveProvider>
    </RouteHeaderToolbarContext.Provider>,
  );
const flush = async (action: () => void | Promise<void>) =>
  act(async () => {
    await action();
    await Bun.sleep(2);
  });
const getPortal = () => portal as unknown as PortalSnapshot;

try {
  await flush(render);
  expect(getPortal().containerInfo).toBe(target);
  const searchRoot = () => flatten(getPortal().children).find((element) => element.type === 'search');
  const input = () => flatten(getPortal().children).find((element) => element.type === 'input' && element.props.type === 'search');

  const firstInput = input();
  if (typeof firstInput?.props.onChange !== 'function') throw new Error('Settings search input handler missing');
  const changeFirst = firstInput.props.onChange as (event: { target: { value: string } }) => void;
  await flush(() => changeFirst({ target: { value: 'server name' } }));
  const result = flatten(getPortal().children).find(
    (element) => element.type === 'button' && flatten(element.props.children as ReactNode).some((child) => child.props.children === 'Server name'),
  );
  if (typeof result?.props.onClick !== 'function') throw new Error('Settings search result button missing');
  const clickResult = result.props.onClick as () => void;
  await flush(clickResult);
  expect(selected).toBe('server-name');

  const activeInput = input();
  if (typeof activeInput?.props.onChange !== 'function') throw new Error('Settings search input handler missing after selection');
  const changeActive = activeInput.props.onChange as (event: { target: { value: string } }) => void;
  await flush(() => changeActive({ target: { value: 'wallpaper' } }));
  const clear = flatten(getPortal().children).find((element) => element.type === 'button' && element.props['aria-label'] === 'Clear settings search');
  if (typeof clear?.props.onClick !== 'function') throw new Error('Settings search clear button missing');
  const clickClear = clear.props.onClick as () => void;
  await flush(clickClear);
  expect(flatten(getPortal().children).some((element) => element.type === 'ul' && element.props.id)).toBe(false);

  const blurInput = input();
  if (typeof blurInput?.props.onChange !== 'function') throw new Error('Settings search input handler missing before blur');
  const changeBeforeBlur = blurInput.props.onChange as (event: { target: { value: string } }) => void;
  await flush(() => changeBeforeBlur({ target: { value: 'wallpaper' } }));
  const rootElement = searchRoot();
  if (typeof rootElement?.props.onBlur !== 'function') throw new Error('Settings search blur handler missing');
  const blurSearch = rootElement.props.onBlur as (event: { currentTarget: { contains: () => boolean }; relatedTarget: null }) => void;
  await flush(() =>
    blurSearch({
      currentTarget: { contains: () => false },
      relatedTarget: null,
    }),
  );
  expect(flatten(getPortal().children).some((element) => element.type === 'ul' && element.props.id)).toBe(false);

  const currentSaveButton = saveButton as unknown as ReactElement<Record<string, unknown>>;
  if (typeof currentSaveButton?.props.onClick !== 'function') throw new Error('Shared Save button handler missing');
  const clickSave = currentSaveButton.props.onClick as () => void;
  await flush(clickSave);
  expect(eventsSeen).toEqual(['prepare', 'commit']);
  process.stdout.write(JSON.stringify({ mountedReact: true, portalTarget: true, network: false, layout: false, eventsSeen }));
} finally {
  await flush(() => root.unmount());
}
