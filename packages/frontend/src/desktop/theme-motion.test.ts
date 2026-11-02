import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  readFileSync(new URL('./theme-motion.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/, '')
    .replace(/^export /gm, ''),
);
function environment({ snapshots = true, reduced = false, throws = false } = {}) {
  const properties = new Map([['--desktop-accent', '#123456']]);
  const transitions: { update: () => void; skipped: boolean; finish: () => void }[] = [];
  const animations: { frames: Record<string, string>[]; options: { duration: number } }[] = [];
  const root = {
    dataset: {} as Record<string, string>,
    animate: (frames: Record<string, string>[], options: { duration: number }) => {
      animations.push({ frames, options });
      return { finished: Promise.resolve(), cancel() {} };
    },
  };
  const document = {
    documentElement: root,
    ...(snapshots
      ? {
          startViewTransition: (update: () => void) => {
            if (throws) throw new Error('Transition unavailable');
            let finish = () => {};
            const finished = new Promise<void>((resolve) => {
              finish = resolve;
            });
            const item = { update, skipped: false, finish };
            transitions.push(item);
            return {
              ready: Promise.resolve(),
              finished,
              skipTransition: () => {
                item.skipped = true;
                finish();
              },
            };
          },
        }
      : {}),
  };
  const runtime = {
    document,
    CSS: { registerProperty() {} },
    prefersReducedMotion: () => reduced,
    getComputedStyle: () => ({ getPropertyValue: (name: string) => properties.get(name) ?? '' }),
    transitionAppearance: undefined as unknown as (apply: () => void, animate: boolean, identity?: string) => void,
  };
  runInNewContext(source, runtime);
  return { run: runtime.transitionAppearance, transitions, animations, root, properties };
}

test('first paint and reduced motion apply synchronously without snapshot or inherited-colour animation', () => {
  for (const reduced of [false, true]) {
    const e = environment({ reduced });
    let applied = 0;
    e.run(() => applied++, reduced);
    expect(applied).toBe(1);
    expect(e.transitions).toHaveLength(0);
    expect(e.animations).toHaveLength(0);
  }
});
test('snapshot transition uses one palette application without per-frame token animation', async () => {
  const e = environment();
  let applied = 0;
  e.run(() => applied++, true);
  expect(applied).toBe(0);
  e.transitions[0]?.update();
  expect(applied).toBe(1);
  expect(e.animations).toHaveLength(0);
  e.transitions[0]?.finish();
  await Promise.resolve();
  expect(e.root.dataset.orbisPaletteMotion).toBeUndefined();
});
test('rapid colour choices skip obsolete snapshots and cannot apply an older palette later', () => {
  const e = environment();
  let result = '';
  e.run(() => {
    result = 'old';
  }, true);
  e.run(() => {
    result = 'new';
  }, true);
  expect(e.transitions[0]?.skipped).toBe(true);
  e.transitions[0]?.update();
  expect(result).toBe('');
  e.transitions[1]?.update();
  expect(result).toBe('new');
});
test('an unavailable snapshot implementation still applies the chosen palette', () => {
  const e = environment({ throws: true });
  let applied = 0;
  e.run(() => applied++, true);
  expect(applied).toBe(1);
  expect(e.root.dataset.orbisPaletteMotion).toBeUndefined();
});
test('fallback only animates changed tokens and keeps its duration brief', () => {
  const e = environment({ snapshots: false });
  e.run(() => e.properties.set('--desktop-accent', '#abcdef'), true);
  expect(e.animations).toHaveLength(1);
  expect(Object.keys(e.animations[0]?.frames[0] ?? {})).toEqual(['--desktop-accent']);
  expect(e.animations[0]?.options.duration).toBe(180);
});

test('unrelated rerenders do not restart a palette snapshot or block button interaction', () => {
  const e = environment();
  let calls = 0;
  e.run(() => calls++, false, 'same-palette');
  for (let index = 0; index < 20; index++) e.run(() => calls++, true, 'same-palette');
  expect(calls).toBe(1);
  expect(e.transitions).toHaveLength(0);
  e.run(() => calls++, true, 'new-palette');
  expect(e.transitions).toHaveLength(1);
  e.run(() => calls++, true, 'new-palette');
  expect(e.transitions[0]?.skipped).toBe(false);
  e.transitions[0]?.update();
  expect(calls).toBe(2);
});
