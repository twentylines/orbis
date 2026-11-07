import { describe, expect, test } from 'bun:test';
import { wallpaperTextColour, type WallpaperSample } from './wallpaper-contrast';
import { observeWallpaperText } from './wallpaper-text';

function sample(pixel: (x: number, y: number) => [number, number, number, number]): WallpaperSample {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) data.set(pixel(x, y), (y * 16 + x) * 4);
  return { pixels: { width: 16, height: 16, sourceWidth: 1600, sourceHeight: 1600, data }, fit: 'cover', x: 50, y: 0, dim: 0 };
}
const viewport = { width: 800, height: 800 };
const region = { left: 40, top: 80, width: 240, height: 100 };
const base = [0, 0, 0] as const;

describe('wallpaper text contrast', () => {
  test('uses light text on a dark image and dark text on a bright image regardless of interface mode', () => {
    expect(
      wallpaperTextColour(
        sample(() => [25, 39, 42, 255]),
        viewport,
        region,
        base,
      ),
    ).toBe('#ffffff');
    expect(
      wallpaperTextColour(
        sample(() => [235, 225, 205, 255]),
        viewport,
        region,
        base,
      ),
    ).toBe('#10181b');
  });
  test('samples the text region, so headings on different parts of one image can use different colours', () => {
    const image = sample((x) => (x < 8 ? [15, 20, 25, 255] : [235, 235, 235, 255]));
    expect(wallpaperTextColour(image, viewport, region, base)).toBe('#ffffff');
    expect(wallpaperTextColour(image, viewport, { ...region, left: 480 }, base)).toBe('#10181b');
  });
  test('a small link on a dark rock stays readable beside a heading on bright sky', () => {
    const image = sample((x) => (x < 13 ? [185, 185, 185, 255] : [18, 18, 18, 255]));
    expect(wallpaperTextColour(image, viewport, { left: 40, top: 100, width: 200, height: 40 }, base)).toBe('#10181b');
    expect(wallpaperTextColour(image, viewport, { left: 680, top: 100, width: 100, height: 40 }, base)).toBe('#ffffff');
  });
  test('honours cover cropping and the saved horizontal position', () => {
    const image = sample((x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const narrow = { width: 200, height: 800 };
    const heading = { left: 10, top: 30, width: 180, height: 80 };
    expect(wallpaperTextColour({ ...image, x: 0 }, narrow, heading, base)).toBe('#ffffff');
    expect(wallpaperTextColour({ ...image, x: 100 }, narrow, heading, base)).toBe('#10181b');
  });
  test('honours vertical positioning and dimming', () => {
    const image = sample((_, y) => (y < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const wide = { width: 800, height: 200 };
    expect(wallpaperTextColour({ ...image, y: 0 }, wide, region, base)).toBe('#ffffff');
    expect(wallpaperTextColour({ ...image, y: 100 }, wide, region, base)).toBe('#10181b');
    expect(wallpaperTextColour({ ...image, y: 100, dim: 0.8 }, wide, region, base)).toBe('#ffffff');
  });
  test('includes contained gutters and transparent custom artwork', () => {
    const image = sample(() => [0, 0, 0, 0]);
    expect(wallpaperTextColour(image, viewport, region, [250, 250, 250])).toBe('#10181b');
    const contained = { ...image, fit: 'contain' as const, pixels: { ...image.pixels, sourceWidth: 3200 } };
    expect(wallpaperTextColour(contained, viewport, { ...region, top: 10 }, base)).toBe('#ffffff');
  });
  test('does not replace a hidden or offscreen heading fallback', () => {
    const image = sample(() => [0, 0, 0, 255]);
    expect(wallpaperTextColour(image, viewport, { ...region, height: 0 }, base)).toBeNull();
    expect(wallpaperTextColour(image, viewport, { ...region, top: 1000 }, base)).toBeNull();
  });
});

test('wallpaper text ignores unrelated scrolling and batches heading reads before colour writes', () => {
  const names = [
    'window',
    'document',
    'Node',
    'getComputedStyle',
    'ResizeObserver',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const events = new Map<string, Set<EventListener>>();
  const frames = new Map<number, FrameRequestCallback>();
  const resizes: (() => void)[] = [];
  const modes: (() => void)[] = [];
  const log: string[] = [];
  let nextFrame = 0;
  let dim = '0';
  class Element {
    children: Element[] = [];
    contains(target: Element): boolean {
      return this === target || this.children.some((child) => child.contains(target));
    }
  }
  const desktop = new Element();
  const root = new Element();
  root.children.push(desktop);
  const makeHeading = (name: string) => {
    const target = Object.assign(new Element(), {
      closest: () => desktop,
      getBoundingClientRect: () => {
        log.push(`read:${name}`);
        return region;
      },
      style: {
        setProperty: (property: string, colour: string) => log.push(`write:${name}:${property}:${colour}`),
        removeProperty: (property: string) => log.push(`remove:${name}:${property}`),
      },
    });
    desktop.children.push(target);
    return target as unknown as HTMLElement;
  };
  const dispatch = (name: string, target: unknown) => {
    for (const listener of events.get(name) ?? []) listener({ target } as Event);
  };
  const flush = () => {
    const batch = [...frames.values()];
    frames.clear();
    for (const frame of batch) frame(0);
  };
  const disposers: (() => void)[] = [];
  try {
    Object.assign(globalThis, {
      Node: Element,
      window: {
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        addEventListener(name: string, listener: EventListener) {
          if (!events.has(name)) events.set(name, new Set());
          events.get(name)?.add(listener);
        },
        removeEventListener: (name: string, listener: EventListener) => events.get(name)?.delete(listener),
      },
      document: {
        documentElement: root,
        createElement: () => ({ getContext: () => null }),
      },
      getComputedStyle: () => ({ backgroundColor: '#10181b', getPropertyValue: () => dim }),
      ResizeObserver: class {
        constructor(callback: () => void) {
          resizes.push(callback);
        }
        observe() {}
        disconnect() {}
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          modes.push(callback);
        }
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    const image = sample(() => [235, 235, 235, 255]);
    const first = makeHeading('first');
    const second = makeHeading('second');
    disposers.push(observeWallpaperText(first, image), observeWallpaperText(second, image));
    expect(log.filter((line) => line.endsWith(':--workspace-heading-ink:#10181b'))).toHaveLength(2);
    log.length = 0;

    for (let index = 0; index < 10; index++) dispatch('scroll', new Element());
    dispatch('scroll', first);
    expect(frames.size).toBe(1);
    flush();
    expect(log).toEqual(['read:first']);
    log.length = 0;
    dispatch('scroll', new Element());
    expect(frames.size).toBe(0);
    expect(log).toEqual([]);

    dim = '0.9';
    dispatch('scroll', desktop);
    dispatch('resize', window);
    for (const resize of resizes) resize();
    for (const changed of modes) changed();
    expect(frames.size).toBe(1);
    flush();
    expect(log.slice(0, 2)).toEqual(['read:first', 'read:second']);
    expect(log.slice(2)).toEqual([
      'write:first:--workspace-heading-ink:#ffffff',
      'write:first:--workspace-heading-edge:#10181b',
      'write:second:--workspace-heading-ink:#ffffff',
      'write:second:--workspace-heading-edge:#10181b',
    ]);
    log.length = 0;
    dispatch('scroll', root);
    flush();
    expect(log).toEqual(['read:first', 'read:second']);
    log.length = 0;

    dispatch('scroll', window);
    expect(frames.size).toBe(1);
    for (const dispose of disposers.splice(0)) dispose();
    expect(frames.size).toBe(0);
    log.length = 0;
    dispatch('resize', window);
    flush();
    expect(log).toEqual([]);
  } finally {
    for (const dispose of disposers) dispose();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
