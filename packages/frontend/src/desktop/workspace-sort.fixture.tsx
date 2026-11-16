import { expect } from 'bun:test';
import { act, useState } from 'react';
import { useWorkspaceSortable } from './workspace-sortable';

const events = new EventTarget();
const noop = () => undefined;
const doc = {
  nodeType: 9,
  activeElement: null as HTMLElement | null,
  documentElement: {},
  body: {},
  defaultView: {} as object,
  addEventListener: noop,
  removeEventListener: noop,
};
const win = {
  document: doc,
  HTMLElement: class {},
  HTMLIFrameElement: class {},
  innerHeight: 600,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  matchMedia: () => ({ matches: false }),
  scrollBy: noop,
};
doc.defaultView = win;
const frames = new Map<number, FrameRequestCallback>();
let serial = 0;
Object.assign(globalThis, {
  window: win,
  document: doc,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
});
const { createRoot } = await import('react-dom/client');
const root = createRoot({
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: noop,
  removeEventListener: noop,
  appendChild: noop,
  removeChild: noop,
  textContent: '',
} as unknown as HTMLElement);
let sortable!: ReturnType<typeof useWorkspaceSortable<string>>;
const commits: string[][] = [];
const scenario = process.argv[2] ?? '';
let currentGrip: HTMLElement | null = null;
let gripTopology = '';
function Probe() {
  const [items, setItems] = useState(['first', 'second', 'third']);
  sortable = useWorkspaceSortable(
    items,
    (next) => {
      commits.push(next);
      setItems(next);
    },
    true,
    scenario === 'workspace-sort-swap' ? 'swap' : 'insert',
  );
  const nextTopology = sortable.order[0] === 'first' ? 'nested' : 'flat';
  if (scenario === 'workspace-sort-reparent-focus' && nextTopology !== gripTopology) {
    gripTopology = nextTopology;
    if (doc.activeElement === currentGrip) doc.activeElement = null;
    currentGrip = {
      focus: () => {
        doc.activeElement = currentGrip;
      },
      scrollIntoView: noop,
    } as unknown as HTMLElement;
    sortable.itemProps('first').ref({
      querySelector: () => currentGrip,
      getBoundingClientRect: () => ({ left: 0, top: sortable.order.indexOf('first') * 100 }),
    } as unknown as HTMLElement);
  }
  return null;
}
try {
  await act(async () => root.render(<Probe />));
  const key = async (key: string) => act(async () => sortable.gripProps('first', 'First').onKeyDown({ key, preventDefault: noop } as never));
  if (scenario === 'workspace-sort-reparent-focus') {
    doc.activeElement = currentGrip;
    await key(' ');
    const oldGrip = currentGrip;
    expect(doc.activeElement).toBe(oldGrip);
    await key('ArrowDown');
    expect(currentGrip).not.toBe(oldGrip);
    expect(doc.activeElement).toBe(currentGrip);
    expect(sortable.order).toEqual(['second', 'first', 'third']);
    await key('Escape');
    expect(sortable.order).toEqual(['first', 'second', 'third']);
    expect(doc.activeElement).toBe(currentGrip);
    await key(' ');
    await key('End');
    await key('Enter');
    expect(commits).toEqual([['second', 'third', 'first']]);
    expect(doc.activeElement).toBe(currentGrip);
  } else if (scenario === 'workspace-sort-keyboard') {
    await key(' ');
    await key('ArrowDown');
    expect(sortable.order).toEqual(['second', 'first', 'third']);
    expect(commits).toHaveLength(0);
    await key('Escape');
    expect(sortable.order).toEqual(['first', 'second', 'third']);
    await key(' ');
    await key('End');
    await key('Enter');
    expect(commits).toEqual([['second', 'third', 'first']]);
  } else {
    const swap = scenario === 'workspace-sort-swap';
    if (swap) {
      await key(' ');
      await key('End');
      expect(sortable.order).toEqual(['third', 'second', 'first']);
      expect(commits).toHaveLength(0);
      await key('Escape');
      expect(sortable.order).toEqual(['first', 'second', 'third']);
    }
    let captured = false;
    const capture = {
      setPointerCapture() {
        captured = true;
      },
      hasPointerCapture() {
        return captured;
      },
      releasePointerCapture() {
        captured = false;
      },
    };
    const nodes = new Map<string, HTMLElement>();
    for (const id of sortable.order) {
      const style: Record<string, unknown> = {};
      style.removeProperty = (name: string) => {
        delete style[name];
      };
      style.setProperty = (name: string, value: string) => {
        style[name] = value;
      };
      const node = {
        style,
        querySelector: () => null,
        parentElement: capture,
        getBoundingClientRect: () => ({ left: 0, right: 200, top: sortable.order.indexOf(id) * 100, bottom: sortable.order.indexOf(id) * 100 + 90 }),
      } as unknown as HTMLElement;
      nodes.set(id, node);
      sortable.itemProps(id).ref(node);
    }
    Object.assign(doc, { elementFromPoint: () => nodes.get('second') });
    await act(async () =>
      sortable.gripProps('first', 'First').onPointerDown({ button: 0, pointerId: 1, clientX: 50, clientY: 20, currentTarget: {} } as never),
    );
    const send = async (name: string, x: number, y: number) =>
      act(async () => {
        window.dispatchEvent(Object.assign(new Event(name, { cancelable: true }), { pointerId: 1, clientX: x, clientY: y }));
      });
    await send('pointermove', 54, 24);
    expect(frames.size).toBe(0);
    expect(sortable.picked).toBe(null);
    const edge = scenario === 'workspace-sort-edge';
    const target = swap ? 'third' : 'second';
    const targetY = swap ? 220 : 120;
    await send('pointermove', edge ? 3 : 50, targetY);
    expect(captured).toBe(true);
    if (scenario !== 'workspace-sort-fast-pointer') {
      for (let i = 0; i < 4; i++) {
        const frame = frames.values().next().value;
        if (!frame) throw new Error('Missing drag frame');
        frames.clear();
        await act(async () => frame(16 + i * 16));
        expect(sortable.order).toEqual(['first', 'second', 'third']);
        expect(sortable.itemProps(target)['data-sortable-over']).toBe(edge ? undefined : true);
        expect(nodes.get('second')?.getBoundingClientRect().top).toBe(100);
      }
    }
    expect(commits).toHaveLength(0);
    await send('pointerup', edge ? 3 : 50, targetY);
    expect(commits).toEqual(edge ? [] : swap ? [['third', 'second', 'first']] : [['second', 'first', 'third']]);
    expect(nodes.get('second')?.getBoundingClientRect().top).toBe(swap ? 100 : edge ? 100 : 0);
    expect(captured).toBe(false);
    expect(frames.size).toBe(0);
    expect(nodes.get('first')?.style.translate).toBeUndefined();
  }
  process.stdout.write(JSON.stringify({ scenario, mountedReact: true, network: false, layout: false }));
} finally {
  await act(async () => root.unmount());
}
