import { describe, expect, test } from 'bun:test';
import { observeSessionWallpaperInk } from './session-wallpaper-ink';

function fixture() {
  const names = ['document', 'window', 'getComputedStyle', 'MutationObserver', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames = new Map<number, FrameRequestCallback>();
  const mutations: (() => void)[] = [];
  const resizes: (() => void)[] = [];
  const events = new Map<string, Set<() => void>>();
  const values = new Map<string, string>();
  const writes: string[] = [];
  const box = { left: 0, top: 0, width: 800, height: 800 };
  const image = {
    src: '/bright.webp',
    currentSrc: '/bright.webp',
    complete: true,
    naturalWidth: 800,
    naturalHeight: 800,
    getBoundingClientRect: () => box,
  };
  const title = { getBoundingClientRect: () => ({ left: 320, top: 550, width: 160, height: 40 }) };
  const shade = {};
  const dim = {};
  const copy = {};
  let photograph = 245;
  let shadeColour = 'rgba(0, 0, 0, 0)';
  let dimColour = 'rgba(0, 0, 0, 0)';
  let blocked = false;
  let reads = 0;
  let disconnected = 0;
  let nextFrame = 0;
  let hasImage = true;
  const addEventListener = (name: string, callback: () => void) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)?.add(callback);
  };
  const removeEventListener = (name: string, callback: () => void) => events.get(name)?.delete(callback);
  const surface = {
    dataset: { desktopMode: 'light' },
    style: {
      getPropertyValue: (name: string) => values.get(name) ?? '',
      setProperty(name: string, value: string) {
        values.set(name, value);
        writes.push(value);
      },
      removeProperty: (name: string) => values.delete(name),
    },
    querySelector(selector: string) {
      if (selector === '.orbis-startup-title') return title;
      if (selector === '.desktop-wallpaper-layer img:last-of-type') return hasImage ? image : null;
      if (selector === '.desktop-wallpaper-shade') return shade;
      if (selector === '.desktop-wallpaper-dim') return dim;
      if (selector === '.orbis-startup-copy') return copy;
      return null;
    },
    getBoundingClientRect: () => box,
    addEventListener,
    removeEventListener,
  };
  Object.assign(globalThis, {
    document: {
      createElement: () => {
        const canvas = { width: 0, height: 0, getContext: () => context };
        const context = {
          fillStyle: 'rgba(0, 0, 0, 0)',
          drawImage() {},
          fillRect() {},
          getImageData() {
            if (canvas.width === 96) {
              reads++;
              if (blocked) throw new Error('Canvas read unavailable');
              const data = new Uint8ClampedArray(96 * 96 * 4);
              for (let index = 0; index < data.length; index += 4) data.set([photograph, photograph, photograph, 255], index);
              return { data };
            }
            const channels = this.fillStyle.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
            return { data: new Uint8ClampedArray([channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, (channels[3] ?? 1) * 255]) };
          },
        };
        return canvas;
      },
    },
    window: { addEventListener, removeEventListener },
    getComputedStyle: (element: unknown) => ({
      objectFit: 'cover',
      objectPosition: '50% 0%',
      backgroundColor: element === shade ? shadeColour : element === dim ? dimColour : 'rgb(248, 250, 252)',
      getPropertyValue: () => '',
    }),
    MutationObserver: class {
      constructor(callback: () => void) {
        mutations.push(callback);
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
    ResizeObserver: class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  const changed = () => {
    for (const callback of mutations) callback();
  };
  return {
    surface: surface as unknown as HTMLDivElement,
    image,
    values,
    writes,
    frames,
    changed,
    flush,
    resize() {
      for (const callback of resizes) callback();
    },
    load() {
      for (const callback of events.get('load') ?? []) callback();
    },
    photo(value: number) {
      photograph = value;
      image.src = image.currentSrc = `/photo-${value}.webp`;
    },
    shade(value: string) {
      shadeColour = value;
    },
    dim(value: string) {
      dimColour = value;
    },
    blocked() {
      blocked = true;
    },
    removeImage() {
      hasImage = false;
    },
    get reads() {
      return reads;
    },
    get disconnected() {
      return disconnected;
    },
    get listenerCount() {
      return [...events.values()].reduce((total, listeners) => total + listeners.size, 0);
    },
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe('session wallpaper ink', () => {
  test('preset changes never tint session copy, in either direction or interface mode', () => {
    const page = fixture();
    let stop = () => {};
    try {
      stop = observeSessionWallpaperInk(page.surface);
      for (const state of ['signing-in', 'logging-out']) {
        page.surface.dataset.sessionState = state;
        for (const mode of ['light', 'dark']) {
          page.surface.dataset.desktopMode = mode;
          for (const preset of ['stone', 'forest', 'frost']) {
            page.surface.dataset.desktopPreset = preset;
            for (const brightness of [245, 15]) {
              page.photo(brightness);
              page.changed();
              page.flush();
              expect(page.values.get('--orbis-session-ink')).toBe(brightness === 245 ? '#000000' : '#ffffff');
            }
          }
        }
      }
    } finally {
      stop();
      page.restore();
    }
  });

  test('both interface modes follow the retained photograph and visible dimming, with cached pixel reads', () => {
    const page = fixture();
    let stop = () => {};
    try {
      stop = observeSessionWallpaperInk(page.surface);
      expect(page.values.get('--orbis-session-ink')).toBe('#000000');
      page.surface.dataset.desktopMode = 'dark';
      page.changed();
      page.resize();
      expect(page.frames.size).toBe(1);
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#000000');
      expect(page.reads).toBe(1);
      page.shade('rgba(5, 15, 25, 0.75)');
      page.changed();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#ffffff');
      page.shade('rgba(0, 0, 0, 0)');
      page.photo(15);
      page.load();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#ffffff');
      expect(page.reads).toBe(2);
      page.photo(245);
      page.dim('rgba(0, 0, 0, 0.8)');
      page.load();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#ffffff');
      expect(page.writes).toEqual(['#000000', '#ffffff']);
    } finally {
      stop();
      page.restore();
    }
  });

  test('a pending or unreadable replacement clears the old sample, then a decoded replacement is sampled', () => {
    const page = fixture();
    let stop = () => {};
    try {
      page.surface.dataset.desktopMode = 'dark';
      stop = observeSessionWallpaperInk(page.surface);
      expect(page.values.get('--orbis-session-ink')).toBe('#000000');
      page.image.complete = false;
      page.changed();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#ffffff');
      page.image.complete = true;
      page.photo(245);
      page.load();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#000000');
      page.photo(60);
      page.blocked();
      page.load();
      page.flush();
      expect(page.values.get('--orbis-session-ink')).toBe('#ffffff');
    } finally {
      stop();
      page.restore();
    }
  });

  test('solid backgrounds have plain contrast, and disposal cancels observers, listeners and pending writes', () => {
    const page = fixture();
    let stop = () => {};
    try {
      page.removeImage();
      stop = observeSessionWallpaperInk(page.surface);
      expect(page.values.get('--orbis-session-ink')).toBe('#000000');
      expect(page.reads).toBe(0);
      page.shade('rgba(0, 0, 0, 0.9)');
      page.changed();
      expect(page.frames.size).toBe(1);
      stop();
      expect(page.frames.size).toBe(0);
      expect(page.disconnected).toBe(2);
      expect(page.listenerCount).toBe(0);
      page.flush();
      expect(page.values.has('--orbis-session-ink')).toBe(false);
      stop = () => {};
    } finally {
      stop();
      page.restore();
    }
  });
});
