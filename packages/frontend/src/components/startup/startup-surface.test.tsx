import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StartupSurface } from './startup-surface';
import { waitForStartupWallpaper, waitForStartupWallpapers } from './wallpaper-ready';
import { defaultDesktopPreferences } from '@/desktop/preferences';

test('the dot logo has identical path groups in the server and browser JavaScript engines', async () => {
  const child = Bun.spawn([process.execPath, new URL('../orbis-logo/orbis-logo-engine-compare.fixture.ts', import.meta.url).pathname], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ stderr, code }).toEqual({ stderr: '', code: 0 });
  const outputs = JSON.parse(stdout) as Array<{ groups: number; sha256: string }>;
  expect(outputs.map((output) => output.groups)).toEqual([16, 16]);
  expect(outputs[0]?.sha256).toBe(outputs[1]?.sha256);
});

test('initial hydration keeps the server scene when a browser has cached appearance preferences', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Reflect.deleteProperty(globalThis, 'window');
    const server = renderToStaticMarkup(<StartupSurface initial />);
    for (const mode of ['light', 'dark', 'system']) {
      for (const preset of ['frost', 'stone', 'graphite']) {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: { localStorage: { getItem: () => JSON.stringify({ mode, preset }) } },
        });
        expect(renderToStaticMarkup(<StartupSurface initial />)).toBe(server);
      }
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('setup and ordinary loading show one status and a scan without duplicate branding or an invented percentage', () => {
  const setup = renderToStaticMarkup(<StartupSurface setupSpace firstBoot label="Preparing Orbis" />);
  expect(setup).toContain('orbis-startup-setup-space');
  expect(setup).toContain('data-known="false"');
  expect(setup).not.toContain('aria-valuenow=');
  expect(setup).not.toContain('orbis-startup-brand');
  expect(setup).not.toContain('orbis-startup-detail');
  expect(setup).toContain('orbis-startup-title');
  const ordinary = renderToStaticMarkup(<StartupSurface />);
  expect(ordinary).not.toContain('data-ready="true"');
  expect(ordinary).not.toContain('data-desktop-mode="light"');
  expect(ordinary).not.toContain('data-animated="true"');
  expect(ordinary).not.toContain('orbis-startup-wordmark');
  expect(ordinary).toContain('orbis-startup-redesigned');
  expect(ordinary).toContain('Loading your workspace');
  expect(ordinary).toContain('data-centered-loading="true"');
  expect(setup).toContain('data-centered-loading="true"');
});

test('initial loading uses the animated interstellar scene and shared scanning light without a canvas', () => {
  const loading = renderToStaticMarkup(<StartupSurface initial appearance={defaultDesktopPreferences} />);
  expect(loading).toContain('orbis-startup-loading-space');
  expect(loading).toContain('orbis-startup-mark');
  expect(loading).not.toContain('orbis-startup-orbit');
  expect(loading).toContain('orbis-session-galaxy');
  expect(loading).toContain('desktop-wallpaper-layer');
  expect(loading).toContain('data-desktop-mode="light"');
  expect(loading).not.toContain('depth-travel');
  expect(loading).toContain('orbis-interstellar');
  expect(loading).toContain('orbis-startup-scan');
  expect(loading).toContain('data-known="false"');
  expect(loading).not.toContain('loading-galaxy-particles');
  expect(loading).toContain('data-workspace-space="true"');
  expect(loading).not.toContain('<canvas');
});

test('measured loading uses a real progress bar and percentage while leaving the product logo intact', () => {
  const measured = renderToStaticMarkup(<StartupSurface progress={37.5} label="Downloading update" />);
  expect(measured).toContain('value="37.5"');
  expect(measured).toContain('37%');
  expect(measured).toContain('orbis-interstellar');
  expect(measured).not.toContain('orbis-startup-scan');
  expect(measured).not.toContain('orbis-logo-dot-group');
  const unknown = renderToStaticMarkup(<StartupSurface progress={Number.NaN} />);
  expect(unknown).not.toContain('aria-valuenow=');
});

test('workspace and first setup use the same dot mark while measured operations keep the product mark intact', () => {
  const workspace = renderToStaticMarkup(<StartupSurface />);
  const setup = renderToStaticMarkup(<StartupSurface setupSpace firstBoot label="Preparing Orbis" />);
  expect(workspace).toContain('data-variation="workspace"');
  expect(workspace.match(/class="orbis-logo-dot-group"/g)).toHaveLength(16);
  expect(workspace).not.toContain('data-animated="true"');
  expect(setup.match(/class="orbis-logo-dot-group"/g)).toHaveLength(16);
  expect(setup).toContain('data-variation="setup"');
  expect(setup).toContain('orbis-interstellar');
  expect(setup).toContain('orbis-startup-scan');
  expect(setup).not.toContain('loading-galaxy-particles');
  expect(setup).toContain('data-first-boot="true"');
  expect(setup).not.toContain('data-stream=');
  expect(setup).not.toContain('data-animated="true"');
});

test('ordinary palette/setup checks do not start the first-boot choreography', () => {
  const checking = renderToStaticMarkup(<StartupSurface setupSpace label="Preparing Orbis" />);
  expect(checking).toContain('data-variation="workspace"');
  expect(checking).not.toContain('loading-galaxy-space');
});

test('loading keeps the selected light or dark appearance', () => {
  for (const mode of ['light', 'dark'] as const) {
    const page = renderToStaticMarkup(<StartupSurface appearance={{ ...defaultDesktopPreferences, mode }} />);
    expect(page).toContain(`data-desktop-mode="${mode}"`);
  }
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

test('workspace reveal waits for both the loading cover and the destination wallpaper exactly once', () => {
  const destination = { dataset: { wallpaperState: 'loading' }, querySelector: () => null };
  const cover = Object.assign(new EventTarget(), { querySelector: () => null }) as unknown as HTMLElement;
  const workspace = Object.assign(new EventTarget(), { querySelector: () => destination }) as unknown as HTMLElement;
  let calls = 0;
  const stop = waitForStartupWallpapers([cover, workspace], () => calls++);
  expect(calls).toBe(0);
  destination.dataset.wallpaperState = 'ready';
  workspace.dispatchEvent(new Event('load'));
  expect(calls).toBe(1);
  workspace.dispatchEvent(new Event('load'));
  expect(calls).toBe(1);
  stop();
  waitForStartupWallpapers([], () => calls++);
  expect(calls).toBe(2);
});

test('setup landing keeps its stage and space while preparing wallpaper without a fake percentage', () => {
  const preparing = renderToStaticMarkup(
    <StartupSurface setupSpace prepareWallpaper appearance={defaultDesktopPreferences} label="Preparing Orbis" />,
  );
  expect(preparing).toContain('desktop-wallpaper-layer');
  expect(preparing).toContain('orbis-startup-mark');
  const handoff = renderToStaticMarkup(
    <StartupSurface setupSpace landing revealing completing prepareWallpaper label="Preparing Orbis" appearance={defaultDesktopPreferences} />,
  );
  expect(handoff).toContain('data-landing="true"');
  expect(handoff).toContain('orbis-startup-setup-space');
  expect(handoff).toContain('desktop-wallpaper-layer');
  expect(handoff).toContain('orbis-startup-mark');
  expect(handoff).toContain('orbis-session-galaxy');
  expect(handoff).not.toContain('aria-valuenow="100"');
  expect(handoff).not.toContain('Loading your workspace');
  expect(handoff).toContain('Preparing Orbis');
});

test('loading keeps an actual failure message and retry action visible', () => {
  const error = renderToStaticMarkup(
    <StartupSurface status={{ title: 'Connection unavailable', message: 'The server has not confirmed completion.' }}>
      <button type="button">Retry</button>
    </StartupSurface>,
  );
  expect(error).toContain('Connection unavailable');
  expect(error).toContain('The server has not confirmed completion.');
  expect(error).toContain('>Retry</button>');
  expect(error).not.toContain('aria-valuenow=');
  expect(error).not.toContain('data-centered-loading');
});

test('the setup handoff keeps one space scene while the existing mark becomes the signing-in galaxy', () => {
  const circle = renderToStaticMarkup(<StartupSurface setupSpace setupSigningIn appearance={defaultDesktopPreferences} />);
  expect(circle).toContain('data-setup-sign-in="true"');
  expect(circle).toContain('Signing in');
  expect(circle).toContain('data-variation="session"');
  expect(circle).toContain('orbis-startup-orbit');
  expect(circle).toContain('/startup/interstellar-v1.webp');
  expect(circle).not.toContain('orbis-startup-scan');
});

test('all sign-in and sign-out paths share session text state without an inherited palette colour', () => {
  for (const appearance of ['light', 'dark'] as const) {
    for (const props of [{ signingIn: true }, { setupSpace: true, setupSigningIn: true }, { loggingOff: true }]) {
      const markup = renderToStaticMarkup(
        <StartupSurface {...props} appearance={{ ...defaultDesktopPreferences, mode: appearance, preset: 'stone' }} />,
      );
      expect(markup).toContain(`data-session-state="${props.loggingOff ? 'logging-out' : 'signing-in'}"`);
      expect(markup).not.toContain('--orbis-session-ink:');
    }
  }
});
