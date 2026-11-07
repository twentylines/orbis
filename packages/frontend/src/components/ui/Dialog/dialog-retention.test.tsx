import { expect, test } from 'bun:test';
import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog, DialogOpenContext, observeDialogSize, retainDialogChildren, updateDialogOpen } from './Dialog';
function OpenProbe() {
  return <output data-open={useContext(DialogOpenContext)} />;
}
test('shared Dialog preserves controlled open and uncontrolled defaultOpen semantics', () => {
  expect(
    renderToStaticMarkup(
      <Dialog defaultOpen>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="true"');
  expect(
    renderToStaticMarkup(
      <Dialog>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="false"');
  expect(
    renderToStaticMarkup(
      <Dialog open={false} defaultOpen>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="false"');
  expect(
    renderToStaticMarkup(
      <Dialog open>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="true"');
});
test('the real Root change handler calls onOpenChange exactly once and only owns uncontrolled state', () => {
  for (const controlled of [false, true]) {
    const state: boolean[] = [];
    const changes: boolean[] = [];
    updateDialogOpen(
      controlled,
      false,
      (value) => state.push(value),
      (value) => changes.push(value),
    );
    expect(state).toEqual(controlled ? [] : [false]);
    expect(changes).toEqual([false]);
  }
});
test('Presence-scoped retention keeps the entire last open tree through parent reset and replaces it on reopen', () => {
  const snapshot: { current: React.ReactNode } = { current: null };
  const populated = (
    <>
      <header>Create backup</header>
      <form>
        <input name="passphrase" />
        <button type="button">Continue</button>
      </form>
      <button type="button">Close</button>
    </>
  );
  const cleared = <header>Backup &amp; recovery</header>;
  expect(retainDialogChildren(snapshot, true, populated)).toBe(populated);
  expect(retainDialogChildren(snapshot, false, cleared)).toBe(populated);
  expect(renderToStaticMarkup(retainDialogChildren(snapshot, false, null))).toContain('Create backup');
  const reopened = <header>Another task</header>;
  expect(retainDialogChildren(snapshot, true, reopened)).toBe(reopened);
  expect(retainDialogChildren({ current: null }, false, cleared)).toBeNull();
});

test('live dialog text does not interrupt resizing and later size changes still animate', () => {
  const descriptors = new Map(
    ['getComputedStyle', 'ResizeObserver', 'MutationObserver', 'document', 'window'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let height = 100;
  let reads = 0;
  let disconnected = false;
  let resized = () => {};
  const mutations: (() => void)[] = [];
  const motions: { frames: Keyframe[]; timing: KeyframeAnimationOptions; playState: string; cancelled: boolean; cancel: () => void }[] = [];
  const content = {
    dataset: { state: 'open' },
    animate(frames: Keyframe[], timing: KeyframeAnimationOptions) {
      const motion = {
        frames,
        timing,
        playState: 'running',
        cancelled: false,
        cancel() {
          this.cancelled = true;
          this.playState = 'idle';
        },
      };
      motions.push(motion);
      return motion;
    },
  };
  try {
    Object.assign(globalThis, {
      getComputedStyle: () => {
        reads++;
        return { height: `${height}px` };
      },
      document: { documentElement: { dataset: {} } },
      window: { matchMedia: () => ({ matches: false }) },
      ResizeObserver: class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          mutations.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    });
    const dispose = observeDialogSize({ parentElement: content } as unknown as HTMLElement);
    height = 200;
    resized();
    expect(motions).toHaveLength(1);
    const initialReads = reads;
    for (let update = 0; update < 26; update++) {
      for (const changed of mutations) changed();
      resized();
    }
    expect(motions).toHaveLength(1);
    expect(motions[0]?.cancelled).toBe(false);
    expect(reads).toBe(initialReads);

    height = 300;
    resized();
    expect(motions).toHaveLength(1);
    const first = motions[0];
    if (!first) throw new Error('Dialog did not start resizing');
    first.playState = 'finished';
    resized();
    expect(motions).toHaveLength(2);
    expect(motions[1]?.frames).toEqual([{ height: '200px' }, { height: '300px' }]);
    expect(motions[1]?.timing).toEqual({ duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    dispose?.();
    expect(disconnected).toBe(true);
    expect(motions[1]?.cancelled).toBe(true);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
