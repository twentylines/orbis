import { describe, expect, test } from 'bun:test';
import type { CSSProperties } from 'react';
import { WallpaperTransition, wallpaperFadeDuration, type WallpaperFrame } from './wallpaper-transition';

function fixture() {
  type Image = { style: { opacity: string }; computed: number; animate: (frames: Keyframe[], options: KeyframeAnimationOptions) => Animation };
  const images = new Map<number, Image>();
  const animations: Array<{ id: number; frames: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; finish: () => void }> = [];
  const displayed: number[] = [];
  const snapshots: WallpaperFrame[][] = [];
  let errors = 0;
  const attach = (frames: WallpaperFrame[]) => {
    snapshots.push(frames);
    for (const frame of frames) {
      let image = images.get(frame.id);
      if (!image) {
        image = {
          style: { opacity: String(frame.opacity) },
          computed: frame.opacity,
          animate(keyframes, options) {
            let resolve = () => {};
            let reject = (_reason: Error) => {};
            const finished = new Promise<void>((done, fail) => {
              resolve = done;
              reject = fail;
            });
            const animation = { id: frame.id, frames: keyframes, options, cancelled: false, finish: resolve };
            animations.push(animation);
            return {
              finished,
              cancel() {
                animation.cancelled = true;
                reject(new Error('Cancelled'));
              },
            } as unknown as Animation;
          },
        };
        images.set(frame.id, image);
      }
      image.style.opacity = String(frame.opacity);
      model.attach(frame.id, image as unknown as HTMLImageElement);
    }
  };
  const model = new WallpaperTransition(
    'A',
    { objectFit: 'cover' },
    attach,
    (image) => displayed.push([...images].find(([, value]) => value === (image as unknown as Image))?.[0] ?? -1),
    () => errors++,
    (image) => (image as unknown as Image).computed,
  );
  attach(model.snapshot());
  model.activate();
  return {
    model,
    images,
    animations,
    displayed,
    snapshots,
    get errors() {
      return errors;
    },
    request(source: string, reduced = false, style: CSSProperties = {}) {
      model.request(source, style, reduced);
      return model.snapshot().at(-1)?.id ?? -1;
    },
    async finish(index = animations.length - 1) {
      animations[index]?.finish();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('wallpaper transition continuity', () => {
  test('the initial decoded picture appears once; an unready choice cannot remove it', () => {
    const page = fixture();
    page.model.loaded(0);
    expect(page.model.snapshot()).toMatchObject([{ id: 0, source: 'A', opacity: 1, displayed: true }]);
    expect(page.animations).toHaveLength(0);
    const pending = page.request('B');
    expect(page.model.snapshot()).toMatchObject([
      { source: 'A', opacity: 1 },
      { source: 'B', opacity: 0 },
    ]);
    page.model.error(pending);
    expect(page.errors).toBe(1);
    page.request('A');
    expect(page.model.snapshot()).toMatchObject([{ source: 'A', opacity: 1 }]);
    expect(page.animations).toHaveLength(0);
  });

  test('reselecting the outgoing picture preserves the exact partial blend instead of deleting the fading layer', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    page.model.loaded(b);
    const image = page.images.get(b);
    if (image) image.computed = 0.42;
    const a = page.request('A');
    page.model.loaded(a);
    expect(page.model.snapshot()).toMatchObject([
      { source: 'A', opacity: 1 },
      { source: 'B', opacity: 0.42 },
      { id: a, source: 'A', opacity: 0 },
    ]);
    expect(page.animations[0]?.cancelled).toBe(true);
    expect(page.animations[1]?.options.duration).toBe(wallpaperFadeDuration);
    await page.finish(0);
    expect(page.model.snapshot()).toHaveLength(3);
    await page.finish(1);
    expect(page.model.snapshot()).toMatchObject([{ id: a, source: 'A', opacity: 1 }]);
    expect(page.displayed).toEqual([0, a]);
  });

  test('rapid choices remain bounded, coalesce to the latest and prune only after full coverage', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    page.model.loaded(b);
    const bImage = page.images.get(b);
    if (bImage) bImage.computed = 0.25;
    const c = page.request('C');
    page.model.loaded(c);
    const cImage = page.images.get(c);
    if (cImage) cImage.computed = 0.35;
    const d = page.request('D');
    page.model.loaded(d);
    expect(page.animations).toHaveLength(2);
    const e = page.request('E');
    page.model.loaded(e);
    expect(page.model.snapshot()).toHaveLength(4);
    expect(page.model.snapshot().some((frame) => frame.source === 'D')).toBe(false);
    expect(page.model.snapshot()[0]?.opacity).toBe(1);
    await page.finish(1);
    expect(page.model.snapshot()).toMatchObject([
      { source: 'C', opacity: 1 },
      { source: 'E', opacity: 0 },
    ]);
    expect(page.animations).toHaveLength(3);
    await page.finish(2);
    expect(page.model.snapshot()).toMatchObject([{ source: 'E', opacity: 1 }]);
    expect(Math.max(...page.snapshots.map((frames) => frames.length))).toBe(4);
  });

  test('late loading and errors from replaced choices cannot take over the latest picture', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    const c = page.request('C');
    page.model.loaded(b);
    page.model.error(b);
    expect(page.errors).toBe(0);
    expect(page.animations).toHaveLength(0);
    page.model.loaded(c);
    await page.finish();
    expect(page.model.snapshot()).toMatchObject([{ source: 'C', opacity: 1 }]);
  });

  test('reduced motion settles an active fade and waits for the next picture to decode before replacing it', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    page.model.loaded(b);
    page.request('B', true);
    expect(page.model.snapshot()).toMatchObject([{ source: 'B', opacity: 1 }]);
    const c = page.request('C', true);
    expect(page.model.snapshot()[0]?.source).toBe('B');
    page.model.loaded(c);
    expect(page.model.snapshot()).toMatchObject([{ source: 'C', opacity: 1 }]);
    await page.finish(0);
    expect(page.model.snapshot()[0]?.source).toBe('C');
    expect(page.animations).toHaveLength(1);
  });

  test('teardown ignores completion and reactivation resumes from the visible opacity', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    page.model.loaded(b);
    const image = page.images.get(b);
    if (image) image.computed = 0.3;
    page.model.deactivate();
    await page.finish(0);
    expect(page.displayed).toEqual([0]);
    page.model.activate();
    expect(page.animations[1]?.frames[0]?.opacity).toBe(0.3);
    await page.finish(1);
    expect(page.model.snapshot()).toMatchObject([{ source: 'B', opacity: 1 }]);
  });

  test('an outgoing picture keeps its crop while the next picture has its own settings', () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B', false, { objectFit: 'contain', objectPosition: '20% 30%' });
    expect(page.model.snapshot()[0]?.style).toEqual({ objectFit: 'cover' });
    expect(page.model.snapshot()[1]?.style).toEqual({ objectFit: 'contain', objectPosition: '20% 30%' });
    page.model.loaded(b);
    page.request('B', false, { objectFit: 'contain', objectPosition: '40% 30%' });
    expect(page.animations).toHaveLength(1);
    expect(page.model.snapshot()[1]?.style.objectPosition).toBe('40% 30%');
  });

  test('reactivation keeps the layer bound while a decoded latest choice waits behind an interrupted blend', async () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    page.model.loaded(b);
    const bImage = page.images.get(b);
    if (bImage) bImage.computed = 0.2;
    const c = page.request('C');
    page.model.loaded(c);
    const cImage = page.images.get(c);
    if (cImage) cImage.computed = 0.3;
    const d = page.request('D');
    page.model.loaded(d);
    page.model.deactivate();
    page.model.activate();
    expect(page.animations[2]?.frames[0]?.opacity).toBe(0.3);
    expect(page.model.snapshot()).toHaveLength(4);
    await page.finish(2);
    expect(page.model.snapshot()).toMatchObject([
      { source: 'C', opacity: 1 },
      { source: 'D', opacity: 0 },
    ]);
    await page.finish(3);
    expect(page.model.snapshot()).toMatchObject([{ source: 'D', opacity: 1 }]);
    expect(Math.max(...page.snapshots.map((frames) => frames.length))).toBe(4);
  });

  test('a browser without element animations replaces only after decode and retains no outgoing images', () => {
    const page = fixture();
    page.model.loaded(0);
    const b = page.request('B');
    const image = page.images.get(b);
    if (image) Reflect.deleteProperty(image, 'animate');
    expect(page.model.snapshot()[0]?.opacity).toBe(1);
    page.model.loaded(b);
    expect(page.model.snapshot()).toMatchObject([{ source: 'B', opacity: 1 }]);
    expect(page.animations).toHaveLength(0);
  });
});
