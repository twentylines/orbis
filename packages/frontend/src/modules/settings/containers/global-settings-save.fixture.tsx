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
const { SettingsSaveProvider, SettingsSaveButton, SettingsSaveActivity, SettingsSaveFeedback, useSettingsSave } = await import(
  '../pages/settings-save'
);
const scenario = process.argv[2] ?? '';
let controller = new AbortController();
let account = 'A';
let save: (() => Promise<void>) | undefined;
let loading = false;
let activity = false;
let backgroundSaving = false;
let error: unknown = null;
const sections: string[] = [];
const eventsSeen: string[] = [];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const oldPrepare = deferred<(() => Promise<void>) | null>();
const oldCommit = deferred<void>();
const freshCommit = deferred<void>();
let unmounted = false;
function Probe() {
  const current = account;
  const shared = useSettingsSave({
    section: 'general',
    dirty: true,
    pending: false,
    prepare: async () => {
      eventsSeen.push(`prepare-${current}-general`);
      if (current === 'A' && (scenario === 'global-session-prepare' || scenario === 'global-unmount')) return oldPrepare.promise;
      if (current === 'B' && scenario === 'global-session-error') return null;
      return async () => {
        eventsSeen.push(`commit-${current}-general`);
        if (current === 'A') await oldCommit.promise;
        else await freshCommit.promise;
      };
    },
  });
  useSettingsSave({
    section: 'updates',
    dirty: true,
    pending: false,
    prepare: async () => {
      eventsSeen.push(`prepare-${current}-updates`);
      return async () => {
        eventsSeen.push(`commit-${current}-updates`);
      };
    },
  });
  save = shared.save;
  loading = SettingsSaveButton()?.props.loading ?? false;
  activity = SettingsSaveActivity()?.props.pending ?? false;
  error = SettingsSaveFeedback()?.props.children ?? null;
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
    <SettingsSaveProvider backgroundSaving={backgroundSaving} signal={controller.signal} onSection={(section) => sections.push(section)}>
      <Probe />
    </SettingsSaveProvider>,
  );
const flush = async (fn: () => void | Promise<void>) =>
  act(async () => {
    await fn();
    await Bun.sleep(2);
  });
const start = async () => {
  const action = save;
  if (!action) throw new Error('Missing shared Save');
  let pending: Promise<void> | undefined;
  await flush(() => {
    pending = action();
  });
  if (!pending) throw new Error('Missing save result');
  return { pending };
};
try {
  await flush(render);
  if (scenario === 'global-background-activity') {
    expect(activity).toBe(false);
    await flush(() => {
      backgroundSaving = true;
      render();
    });
    expect(activity).toBe(true);
    expect(loading).toBe(false);
    expect(eventsSeen).toEqual([]);
    await flush(() => {
      backgroundSaving = false;
      render();
    });
    expect(activity).toBe(false);
    await flush(() => {
      backgroundSaving = true;
      controller.abort();
      render();
    });
    expect(activity).toBe(false);
    expect(loading).toBe(false);
    expect(sections).toEqual([]);
  } else if (scenario === 'global-activity') {
    expect(activity).toBe(false);
    const current = await start();
    expect(activity).toBe(true);
    expect(loading).toBe(true);
    await flush(async () => {
      oldCommit.resolve();
      await current.pending;
    });
    expect(activity).toBe(false);
    expect(loading).toBe(false);
    expect(error).toBeNull();
    expect(eventsSeen).toEqual(['prepare-A-general', 'prepare-A-updates', 'commit-A-general', 'commit-A-updates']);
  } else {
    const old = await start();
    expect(loading).toBe(true);
    if (scenario === 'global-unmount') {
      await flush(() => root.unmount());
      unmounted = true;
      await flush(async () => {
        oldPrepare.resolve(null);
        await old.pending;
      });
      expect(sections).toEqual([]);
    } else {
      controller.abort(new DOMException('Session ended', 'AbortError'));
      controller = new AbortController();
      account = 'B';
      await flush(render);
      expect(loading).toBe(false);
      expect(error).toBeNull();
      if (scenario === 'global-session-prepare') {
        await flush(async () => {
          oldPrepare.resolve(async () => {
            eventsSeen.push('unexpected-old-commit');
          });
          await old.pending;
        });
        expect(eventsSeen).toEqual(['prepare-A-general']);
        expect(sections).toEqual([]);
      } else if (scenario === 'global-session-error') {
        const fresh = await start();
        await fresh.pending;
        expect(error).toBe('Check the highlighted settings before saving.');
        expect(sections).toEqual(['general']);
        await flush(async () => {
          oldCommit.reject(new Error('Private old-session error'));
          await old.pending;
        });
        expect(error).toBe('Check the highlighted settings before saving.');
        expect(sections).toEqual(['general']);
        expect(eventsSeen).not.toContain('commit-A-updates');
      } else if (scenario === 'global-session-new-save') {
        const fresh = await start();
        expect(loading).toBe(true);
        await flush(async () => {
          oldCommit.resolve();
          await old.pending;
        });
        expect(loading).toBe(true);
        expect(error).toBeNull();
        expect(sections).toEqual([]);
        expect(eventsSeen).not.toContain('commit-A-updates');
        await flush(async () => {
          freshCommit.resolve();
          await fresh.pending;
        });
        expect(loading).toBe(false);
        expect(eventsSeen).toContain('commit-B-updates');
      } else throw new Error('Unknown fixture scenario');
    }
  }
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  if (!unmounted) await flush(() => root.unmount());
}
