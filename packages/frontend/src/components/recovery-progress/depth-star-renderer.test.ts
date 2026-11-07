import { describe, expect, test } from 'bun:test';
import { depthStarMarks, depthStarTexture } from './depth-star-data';
import { createDepthStarRenderer, depthStarProjection } from './depth-star-renderer';

describe('star data and projection', () => {
  test('produces deterministic matching SVG marks including rounded paths', () => {
    const marks = depthStarMarks(0);
    expect(marks).toHaveLength(80);
    const first = marks[0];
    expect(first).toEqual({ x: 91, y: 213, radius: 1.4, opacity: 0.32, colour: '#d9e3eb', dx: '7.13', dy: '5.00' });
    const stars = decodeURIComponent(depthStarTexture(0, false));
    const trails = decodeURIComponent(depthStarTexture(0, true));
    expect(stars.match(/<circle /g)).toHaveLength(80);
    expect(trails.match(/<path /g)).toHaveLength(80);
    expect(trails).toContain(`M${first?.x},${first?.y}l${first?.dx},${first?.dy}`);
    expect(depthStarMarks(1)).not.toEqual(marks);
  });

  test('projects the different star and trail cover positions at perspective depths', () => {
    const zero = depthStarProjection(1168, 730, 584, 313.9, 520, 0);
    expect(zero.left).toBeCloseTo(-525.6);
    expect(zero.top).toBeCloseTo(-328.5);
    expect(zero.trailTop).toBeCloseTo(-744.6);
    expect(zero.factor).toBeCloseTo(2.2192);
    const far = depthStarProjection(1168, 730, 584, 313.9, 520, -900);
    const near = depthStarProjection(1168, 730, 584, 313.9, 520, 420);
    expect(far.factor / zero.factor).toBeCloseTo(520 / 1420);
    expect(near.factor / zero.factor).toBeCloseTo(5.2);
    expect(far.left).toBeCloseTo(177.6676056338);
  });
});

type Listener = () => void;
function harness(
  options: { noContext?: boolean; drawError?: boolean; width?: number; height?: number; trailOpacity?: number; inactive?: boolean } = {},
) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let strokes = 0;
  let next = 0;
  const pending = new Map<number, Listener>();
  const surfaces: FakeCanvas[] = [];
  let observedResize: Listener = () => {};
  let resizeDisconnected = false;
  let mutationDisconnected = false;
  const listeners = () => new Map<string, Listener>();
  const rootListeners = listeners();
  const windowListeners = listeners();
  const mediaListeners = listeners();
  class FakeCanvas {
    className = '';
    width = 300;
    height = 150;
    removed = false;
    events = listeners();
    fills = 0;
    copies = 0;
    alphas: number[] = [];
    context = {
      globalAlpha: 1,
      setTransform() {},
      clearRect() {},
      save() {},
      beginPath() {},
      rect() {},
      clip() {},
      arc() {},
      fill: () => {
        if (options.drawError) throw new Error('draw failure');
        this.fills++;
        this.alphas.push(this.context.globalAlpha);
      },
      moveTo() {},
      lineTo() {},
      stroke: () => {
        strokes++;
      },
      restore() {},
      drawImage: () => {
        this.copies++;
      },
    };
    setAttribute() {}
    getContext() {
      return options.noContext ? null : this.context;
    }
    addEventListener(name: string, callback: Listener) {
      this.events.set(name, callback);
    }
    removeEventListener(name: string) {
      this.events.delete(name);
    }
    remove() {
      this.removed = true;
    }
  }
  const plane = {};
  const root = {
    dataset: { active: options.inactive ? 'false' : 'true' } as Record<string, string>,
    hasAttribute(name: string) {
      return name === 'data-depth-stars' && 'depthStars' in this.dataset;
    },
    querySelectorAll() {
      return [plane, plane, plane];
    },
    append() {},
  };
  const html = { dataset: {} };
  const media = {
    matches: false,
    addEventListener: (name: string, cb: Listener) => mediaListeners.set(name, cb),
    removeEventListener: (name: string) => mediaListeners.delete(name),
  };
  set('document', {
    hidden: false,
    documentElement: html,
    createElement: () => {
      const item = new FakeCanvas();
      surfaces.push(item);
      return item;
    },
    addEventListener: (name: string, cb: Listener) => rootListeners.set(name, cb),
    removeEventListener: (name: string) => rootListeners.delete(name),
  });
  set('window', {
    devicePixelRatio: 2,
    matchMedia: () => media,
    addEventListener: (name: string, cb: Listener) => windowListeners.set(name, cb),
    removeEventListener: (name: string) => windowListeners.delete(name),
  });
  set('getComputedStyle', (target: unknown, pseudo?: string) =>
    target === root
      ? {
          width: `${options.width ?? 100}px`,
          height: `${options.height ?? 80}px`,
          boxSizing: 'content-box',
          perspectiveOrigin: '50px 40px',
          perspective: '520px',
        }
      : pseudo
        ? { opacity: String(options.trailOpacity ?? 0) }
        : { display: 'block', visibility: 'visible', opacity: '0.5', transform: 'none' },
  );
  set(
    'DOMMatrixReadOnly',
    class {
      m43 = 0;
    },
  );
  set(
    'ResizeObserver',
    class {
      constructor(callback: Listener) {
        observedResize = callback;
      }
      observe() {}
      disconnect() {
        resizeDisconnected = true;
      }
    },
  );
  set(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {
        mutationDisconnected = true;
      }
    },
  );
  set('requestAnimationFrame', (callback: Listener) => {
    const id = ++next;
    pending.set(id, callback);
    return id;
  });
  set('cancelAnimationFrame', (id: number) => pending.delete(id));
  return {
    strokes: () => strokes,
    root: root as unknown as HTMLElement,
    surfaces,
    pending,
    rootListeners,
    windowListeners,
    mediaListeners,
    resize: () => observedResize(),
    disconnected: () => resizeDisconnected && mutationDisconnected,
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe('renderer fallback and teardown', () => {
  test('draws separated circles directly without allocating or copying scratch surfaces', () => {
    const h = harness();
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(h.surfaces[0]?.fills).toBe(240);
      expect(h.surfaces[0]?.copies).toBe(0);
      expect(h.surfaces[0]?.alphas[0]).toBeCloseTo(0.32 * 0.5);
      expect(h.surfaces.slice(1).every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
      dispose?.();
    } finally {
      h.restore();
    }
  });

  test('tiny projected circles retain group compositing', () => {
    const h = harness({ width: 1, height: 1 });
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(h.surfaces[0]?.fills).toBe(0);
      expect(h.surfaces[0]?.copies).toBe(3);
      expect(h.surfaces[1]?.fills).toBe(240);
      expect(h.surfaces[1]?.width).toBe(2);
      expect(h.surfaces[2]?.width).toBe(0);
      dispose?.();
      expect(h.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('visible trails keep the grouped compositing path', () => {
    const h = harness({ trailOpacity: 0.2 });
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(h.surfaces[0]?.fills).toBe(0);
      expect(h.surfaces[0]?.copies).toBe(3);
      expect(h.surfaces[1]?.fills).toBe(240);
      expect(h.surfaces[1]?.copies).toBe(3);
      expect(h.strokes()).toBe(240);
      expect(h.surfaces[2]?.width).toBe(200);
      dispose?.();
    } finally {
      h.restore();
    }
  });

  test('retains scratch buffers across trail transitions', () => {
    const options = { trailOpacity: 0 };
    const h = harness(options);
    try {
      const dispose = createDepthStarRenderer(h.root);
      const run = () => {
        const [id, callback] = [...h.pending.entries()][0] ?? [];
        if (id === undefined || !callback) throw new Error('missing frame');
        h.pending.delete(id);
        callback();
      };
      expect(h.surfaces[1]?.width).toBe(0);
      options.trailOpacity = 0.2;
      run();
      expect(h.surfaces[1]?.width).toBe(200);
      expect(h.surfaces[2]?.width).toBe(200);
      options.trailOpacity = 0;
      run();
      expect(h.surfaces[1]?.width).toBe(200);
      expect(h.surfaces[2]?.width).toBe(200);
      options.trailOpacity = 0.2;
      run();
      expect(h.strokes()).toBe(480);
      dispose?.();
      expect(h.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('skips invisible trails but draws all visible trail marks', () => {
    for (const [opacity, expected] of [
      [0, 0],
      [0.2, 240],
    ] as const) {
      const h = harness({ trailOpacity: opacity });
      try {
        const dispose = createDepthStarRenderer(h.root);
        expect(h.strokes()).toBe(expected);
        expect(h.root.dataset.depthStars).toBe('canvas');
        dispose?.();
      } finally {
        h.restore();
      }
    }
  });
  test('falls back if canvas setup or first draw fails', () => {
    for (const options of [{ noContext: true }, { drawError: true }]) {
      const h = harness(options);
      try {
        expect(createDepthStarRenderer(h.root)).toBeNull();
        expect(h.root.dataset.depthStars).toBeUndefined();
        expect(h.pending.size).toBe(0);
        if (options.drawError) expect(h.surfaces[0]?.removed).toBe(true);
      } finally {
        h.restore();
      }
    }
  });

  test('does not run frames continuously when initially inactive', () => {
    const h = harness({ inactive: true });
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(h.root.dataset.depthStars).toBe('canvas');
      expect(h.pending.size).toBe(0);
      dispose?.();
    } finally {
      h.restore();
    }
  });

  test('a later drawing error restores the fallback', () => {
    const options = { drawError: false };
    const h = harness(options);
    try {
      createDepthStarRenderer(h.root);
      expect(h.root.dataset.depthStars).toBe('canvas');
      options.drawError = true;
      const [id, callback] = [...h.pending.entries()][0] ?? [];
      if (id === undefined || !callback) throw new Error('missing frame');
      h.pending.delete(id);
      callback();
      expect(h.root.dataset.depthStars).toBeUndefined();
      expect(h.pending.size).toBe(0);
      expect(h.disconnected()).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('context loss restores SVG and cancels the pending frame', () => {
    const h = harness({ trailOpacity: 0.2 });
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(dispose).not.toBeNull();
      expect(h.root.dataset.depthStars).toBe('canvas');
      expect(h.pending.size).toBe(1);
      h.surfaces[1]?.events.get('contextlost')?.();
      expect(h.root.dataset.depthStars).toBeUndefined();
      expect(h.pending.size).toBe(0);
      expect(h.surfaces[0]?.removed).toBe(true);
      expect(h.disconnected()).toBe(true);
      expect(h.surfaces.every((surface) => surface.width === 0 && surface.height === 0)).toBe(true);
      expect(h.rootListeners.size + h.windowListeners.size + h.mediaListeners.size).toBe(0);
      dispose?.();
    } finally {
      h.restore();
    }
  });

  test('does not suppress fallback for zero size and disposes a queued resize', () => {
    const h = harness({ width: 0 });
    try {
      const dispose = createDepthStarRenderer(h.root);
      expect(h.root.dataset.depthStars).toBeUndefined();
      h.resize();
      expect(h.pending.size).toBe(1);
      dispose?.();
      expect(h.pending.size).toBe(0);
      expect(h.disconnected()).toBe(true);
    } finally {
      h.restore();
    }
  });
});
