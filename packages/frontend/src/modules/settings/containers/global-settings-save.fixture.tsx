import { expect } from 'bun:test';
import { act } from 'react';
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
const { createRoot } = await import('react-dom/client');
const { SettingsSaveProvider, SettingsSaveActivity } = await import('../pages/settings-save');
const { useDebouncedPreferenceSave } = await import('../hooks/use-debounced-preference-save');
const scenario = process.argv[2] ?? '';
let controller = new AbortController();
let draft: string | null = null;
let backgroundSaving = false;
let activity = false;
let saveState!: ReturnType<typeof useDebouncedPreferenceSave>;
const commits: string[] = [];
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const oldCommit = deferred();
const freshCommit = deferred();
let unmounted = false;
function Probe() {
  const key = draft;
  saveState = useDebouncedPreferenceSave(
    key,
    () => {
      if (!key) throw new Error('Unchanged defaults must not write');
      commits.push(key);
      return key === 'old' ? oldCommit.promise : freshCommit.promise;
    },
    { signal: controller.signal, delay: scenario === 'global-session-prepare' || scenario === 'global-unmount' ? 60 : 0 },
  );
  activity = SettingsSaveActivity()?.props.pending ?? false;
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
const render = () =>
  root.render(
    <SettingsSaveProvider backgroundSaving={backgroundSaving} signal={controller.signal}>
      <Probe />
    </SettingsSaveProvider>,
  );
const flush = async (fn: () => void | Promise<void>) =>
  act(async () => {
    await fn();
    await Bun.sleep(2);
  });
const write = async (key: string | null) => {
  await flush(() => {
    draft = key;
    render();
  });
  await flush(() => undefined);
};
const changeSession = () => {
  controller.abort(new DOMException('Session ended', 'AbortError'));
  controller = new AbortController();
};
try {
  await flush(render);
  expect(activity).toBe(false);
  expect(commits).toEqual([]);
  if (scenario === 'global-background-activity') {
    await flush(() => {
      backgroundSaving = true;
      render();
    });
    expect(activity).toBe(true);
    expect(commits).toEqual([]);
    await flush(() => {
      controller.abort();
      render();
    });
    expect(activity).toBe(false);
  } else if (scenario === 'global-session-prepare') {
    await write('old');
    await flush(() => changeSession());
    await write(null);
    await flush(() => Bun.sleep(90));
    expect(commits).toEqual([]);
  } else if (scenario === 'global-unmount') {
    await write('old');
    await flush(() => root.unmount());
    unmounted = true;
    await flush(() => Bun.sleep(90));
    expect(commits).toEqual([]);
  } else {
    await write('old');
    expect(commits).toEqual(['old']);
    expect(activity).toBe(true);
    if (scenario === 'global-activity') {
      await write(null);
      await flush(oldCommit.resolve);
      expect(activity).toBe(false);
      expect(saveState.saved).toBe(true);
    } else {
      changeSession();
      await write('fresh');
      expect(commits).toEqual(['old', 'fresh']);
      if (scenario === 'global-session-error') {
        await flush(() => freshCommit.reject(new Error('Current settings could not be saved.')));
        expect(saveState.error).toBe('Current settings could not be saved.');
        await flush(() => oldCommit.reject(new Error('Old account request failed.')));
        expect(saveState.error).toBe('Current settings could not be saved.');
        expect(activity).toBe(false);
      } else if (scenario === 'global-session-new-save') {
        await flush(oldCommit.resolve);
        expect(activity).toBe(true);
        expect(saveState.error).toBeUndefined();
        await write(null);
        await flush(freshCommit.resolve);
        expect(activity).toBe(false);
        expect(saveState.saved).toBe(true);
      } else throw new Error('Unknown fixture scenario');
    }
  }
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  if (!unmounted) await flush(() => root.unmount());
}
