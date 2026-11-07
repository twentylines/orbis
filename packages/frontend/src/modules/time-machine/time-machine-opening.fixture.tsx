import { expect, mock } from 'bun:test';
import { act, useMemo } from 'react';
import { historicalPoint } from './time-machine.test-data';

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
Object.assign(globalThis, { window: win, document: doc, HTMLElement: win.HTMLElement, matchMedia: win.matchMedia, IS_REACT_ACT_ENVIRONMENT: true });
const calls: { type: string; value?: unknown }[] = [];
const actualMotion = await import('framer-motion');
mock.module('framer-motion', () => ({
  ...actualMotion,
  motion: { article: () => null, div: () => null },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  usePresence: () => [true, undefined],
  useAnimationControls: () =>
    useMemo(
      () => ({
        stop: () => calls.push({ type: 'stop' }),
        set: (value: unknown) => calls.push({ type: 'set', value }),
        start: (value: unknown) => {
          calls.push({ type: 'start', value });
          return new Promise(() => undefined);
        },
      }),
      [],
    ),
}));
const { createRoot } = await import('react-dom/client');
const { HistoricalPointCard } = await import('./time-machine-journey');
const point = historicalPoint();
const scene = {
  selected: point.id,
  previousFront: null,
  selectedIndex: 0,
  previousIndex: 0,
  indices: new Map([[point.id, 0]]),
  exiting: new Set<string>(),
  opening: true,
  open: true,
  visible: true,
  moving: true,
  compact: false,
};
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  textContent: '',
  addEventListener() {
    return undefined;
  },
  removeEventListener() {
    return undefined;
  },
  appendChild() {
    return undefined;
  },
  removeChild() {
    return undefined;
  },
};
const root = createRoot(container as unknown as HTMLElement);
const render = (next: typeof scene, wallpaper: string | null) =>
  act(async () => {
    root.render(<HistoricalPointCard point={point} scene={next} assets={{ wallpaper }} />);
  });
await render(scene, null);
const initial = calls.filter((call) => call.type === 'start');
expect(initial).toHaveLength(1);
expect((initial[0]?.value as { transition: { duration: number; delay: number } }).transition).toMatchObject({ duration: 0.76, delay: 0.08 });
await render({ ...scene, opening: false }, 'blob:wallpaper');
expect(calls.filter((call) => call.type === 'start')).toHaveLength(1);
expect(calls.filter((call) => call.type === 'stop')).toHaveLength(0);
await render({ ...scene, opening: false, open: false }, 'blob:wallpaper');
expect(calls.filter((call) => call.type === 'stop')).toHaveLength(1);
const close = calls.filter((call) => call.type === 'start');
expect(close).toHaveLength(2);
expect((close[1]?.value as { transition: { duration: number } }).transition.duration).toBe(0.54);
await render({ ...scene, opening: false, selectedIndex: 1 }, 'blob:wallpaper');
expect(calls.filter((call) => call.type === 'start')).toHaveLength(3);
await render({ ...scene, opening: false, selectedIndex: 1, compact: true }, 'blob:wallpaper');
expect(calls.filter((call) => call.type === 'start')).toHaveLength(4);
await render({ ...scene, opening: false, selectedIndex: 1, compact: true, moving: false }, 'blob:wallpaper');
expect(calls.filter((call) => call.type === 'start')).toHaveLength(4);
await render({ ...scene, opening: false, selectedIndex: 1, compact: true, visible: false }, 'blob:wallpaper');
expect(calls.at(-1)?.type).toBe('stop');
await act(async () => root.unmount());
process.stdout.write(JSON.stringify({ wallpaperDoesNotRestart: true, closeRetargets: true, otherChangesRetarget: true }));
