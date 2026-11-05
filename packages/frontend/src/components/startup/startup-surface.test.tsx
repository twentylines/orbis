import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupSurface } from './startup-surface';
import { waitForStartupWallpaper } from './wallpaper-ready';
import { defaultDesktopPreferences } from '@/desktop/preferences';

test('setup uses the shared indeterminate progress and normal startup keeps its existing surface', () => {
  const setup = renderToStaticMarkup(<StartupSurface setupSpace label="Preparing Orbis" />);
  expect(setup).toContain('orbis-startup-setup-space');
  expect(setup).toContain('class="recovery-progress-bar"');
  expect(setup).toContain('aria-label="Preparing Orbis"');
  expect(setup).not.toContain('orbis-startup-brand');
  const ordinary = renderToStaticMarkup(<StartupSurface />);
  expect(ordinary).toContain('orbis-startup-brand');
  expect(ordinary).not.toContain('orbis-startup-space-content');
});

test('setup waits for a decoded wallpaper and cancels an interrupted handoff', async () => {
  const original = globalThis.MutationObserver;
  let changed = () => {};
  globalThis.MutationObserver = class {
    constructor(callback: () => void) {
      changed = callback;
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof MutationObserver;
  try {
    let releaseDecode = () => {};
    const image = {
      complete: true,
      naturalWidth: 100,
      style: { opacity: '0' },
      decode: () =>
        new Promise<void>((resolve) => {
          releaseDecode = resolve;
        }),
    };
    const layer = { dataset: { wallpaperState: 'loading' }, querySelector: () => image };
    const surface = Object.assign(new EventTarget(), { querySelector: () => layer }) as unknown as HTMLElement;
    let calls = 0;
    const cancel = waitForStartupWallpaper(surface, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    layer.dataset.wallpaperState = 'ready';
    changed();
    releaseDecode();
    await Promise.resolve();
    expect(calls).toBe(0);
    image.style.opacity = '1';
    changed();
    expect(calls).toBe(1);
    cancel();

    image.style.opacity = '0';
    const stop = waitForStartupWallpaper(surface, () => {
      calls += 1;
    });
    stop();
    releaseDecode();
    await Promise.resolve();
    changed();
    expect(calls).toBe(1);
  } finally {
    globalThis.MutationObserver = original;
  }
});

test('a wallpaper that never finishes cannot hold startup indefinitely', async () => {
  const original = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof MutationObserver;
  let stop = () => {};
  try {
    const surface = Object.assign(new EventTarget(), {
      querySelector: () => ({ dataset: { wallpaperState: 'loading' } }),
    }) as unknown as HTMLElement;
    let completed = 0;
    stop = waitForStartupWallpaper(surface, () => completed++, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completed).toBe(1);
    stop();
    stop = waitForStartupWallpaper(surface, () => completed++, 10);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completed).toBe(1);
  } finally {
    stop();
    globalThis.MutationObserver = original;
  }
});

test('setup handoff preloads wallpaper under space then exposes normal loading without a fake percentage', () => {
  const preparing = renderToStaticMarkup(
    <StartupSurface setupSpace prepareWallpaper appearance={defaultDesktopPreferences} label="Preparing Orbis" />,
  );
  expect(preparing).toContain('desktop-wallpaper-layer');
  expect(preparing).toContain('orbis-startup-space-field');
  const handoff = renderToStaticMarkup(<StartupSurface prepareWallpaper setupHandoff appearance={defaultDesktopPreferences} />);
  expect(handoff).toContain('data-setup-handoff="true"');
  expect(handoff).toContain('orbis-startup-setup-space');
  expect(handoff).toContain('desktop-wallpaper-layer');
  expect(handoff).toContain('orbis-startup-space-field');
  expect(handoff).toContain('orbis-startup-brand');
  expect(handoff).not.toContain('aria-valuenow="100"');
});
