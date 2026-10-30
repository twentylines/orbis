/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { resolveInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import type { InterfaceThemeIdentity } from '@runtipi/common/schemas/interface-theme';
import { InterfaceThemeControls, InterfaceThemePaletteFallback } from './interface-theme-controls';
import { InterfaceThemeDraftStore } from './theme-settings-drafts';
import type { InterfaceThemeSession } from './use-interface-theme-session';
import { ThemeSettingsError, type ThemeSettingsSnapshot } from './theme-settings-api';
import { projectInterfaceThemePreferences, interfaceThemeValuesFromLegacy } from './interface-theme-projection';
import {
  decodeInterfaceThemeCache,
  interfaceThemeCacheAge,
  interfaceThemeCacheBootstrap,
  interfaceThemeCacheKey,
  rememberPublicInterfaceThemeCache,
  readPublicInterfaceThemeCache,
  resolvePublicInterfaceTheme,
} from './interface-theme-cache';

const alpine = { id: 'alpine', version: '1.1.0' };
const tideline = { id: 'tideline', version: '1.1.0' };
const host = { reducedMotion: false, reducedTransparency: false, forcedColours: false };
const settings = {
  formatVersion: 1 as const,
  entries: [
    {
      id: 'alpine',
      settingsVersion: 1,
      values: [
        { key: 'accent', value: '#123456' },
        { key: 'panel-blur', value: 19 },
      ],
    },
  ],
};
const document = (): ThemeSettingsSnapshot => ({
  formatVersion: 1,
  revision: 2,
  legacyMigration: 'complete',
  settings,
  selected: alpine,
  current: resolveInterfaceThemeSettings(alpine, settings),
  builtinFallback: resolveInterfaceThemeSettings(null, settings),
});
const raw = (state = settings, savedAt = Date.now()) => JSON.stringify({ version: 1, savedAt, settings: state });
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function memoryStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}
async function session(identity: InterfaceThemeIdentity | null = alpine): Promise<InterfaceThemeSession> {
  const store = new InterfaceThemeDraftStore({ read: async () => document(), migrate: async () => document(), update: async () => document() });
  await store.load();
  const forTheme = (target: InterfaceThemeIdentity | null) => ({
    binding: store.binding(target),
    setValue: (key: string, value: Parameters<typeof store.setValue>[2]) => store.setValue(target, key, value),
    setColourText: (key: string, value: string) => store.setColourText(target, key, value),
    setNumberText: (key: string, value: string) => store.setNumberText(target, key, value),
    reset: () => store.reset(target),
  });
  return {
    ...store.getSnapshot(),
    current: store.binding(identity),
    preview: store.preview(identity),
    cacheAvailable: true,
    ...forTheme(identity),
    forTheme,
    discard: (target) => store.discard(target ?? identity),
    prepare: (target) => store.prepare(target),
    reload: () => store.load(),
    migrate: () => store.migrate(),
  };
}

describe('separate public cache and identical appearance projection', () => {
  test('validates bounded public namespaces and rejects expiry, injected URLs, unknown controls and duplicate keys', () => {
    const now = Date.now();
    expect(decodeInterfaceThemeCache(raw(settings, now), now)).toEqual(settings);
    for (const invalid of [
      raw(settings, now + 1),
      raw(settings, now - interfaceThemeCacheAge),
      'x'.repeat(65537),
      '{',
      JSON.stringify({ version: 2, savedAt: now, settings }),
      JSON.stringify({ version: 1, savedAt: now, settings, userId: 7 }),
      raw({ formatVersion: 1, entries: [{ id: 'unknown', settingsVersion: 1, values: [] }] }, now),
      raw({ formatVersion: 1, entries: [{ id: 'alpine', settingsVersion: 2, values: [] }] }, now),
      raw(
        { formatVersion: 1, entries: [{ id: 'alpine', settingsVersion: 1, values: [{ key: 'accent', value: 'url(https://example.invalid)' }] }] },
        now,
      ),
      raw({ formatVersion: 1, entries: [{ id: 'alpine', settingsVersion: 1, values: [{ key: 'window-html', value: '<script>' }] }] }, now),
      raw({ ...settings, entries: [settings.entries[0], settings.entries[0]] } as typeof settings, now),
      raw(
        {
          formatVersion: 1,
          entries: [
            {
              id: 'alpine',
              settingsVersion: 1,
              values: [
                { key: 'accent', value: '#123456' },
                { key: 'accent', value: '#123456' },
              ],
            },
          ],
        },
        now,
      ),
    ])
      expect(decodeInterfaceThemeCache(invalid, now)).toBeNull();
  });

  test('writes visual values only, preserves legacy caches and removes only rejected new cache entries', () => {
    const values = memoryStorage();
    values.set('orbis-public-theme-appearance-v1', 'existing-pack-bytes');
    values.set('server-desktop-preferences-v1', 'existing-preferences-bytes');
    expect(rememberPublicInterfaceThemeCache(document())).toBe(true);
    expect(readPublicInterfaceThemeCache()).toEqual(settings);
    const cached = values.get(interfaceThemeCacheKey) ?? '';
    expect(cached).not.toContain('revision');
    expect(cached).not.toContain('selected');
    expect(cached).not.toContain('userId');
    values.set(interfaceThemeCacheKey, '{');
    expect(readPublicInterfaceThemeCache()).toBeNull();
    expect(values.has(interfaceThemeCacheKey)).toBe(false);
    expect(values.get('orbis-public-theme-appearance-v1')).toBe('existing-pack-bytes');
    expect(values.get('server-desktop-preferences-v1')).toBe('existing-preferences-bytes');
    expect(rememberPublicInterfaceThemeCache({ ...document(), legacyMigration: 'pending' })).toBe(true);
    expect(values.has(interfaceThemeCacheKey)).toBe(false);
  });

  test('storage denial is explicit and never changes the active in-memory appearance', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('Denied');
      },
    });
    expect(readPublicInterfaceThemeCache()).toBeNull();
    expect(rememberPublicInterfaceThemeCache(document())).toBe(false);
    expect(resolvePublicInterfaceTheme(settings, alpine)?.values.find((item) => item.key === 'accent')?.value).toBe('#123456');
  });

  test('clears legacy visual clamps for new themes while preserving wallpaper, host text and app behavior', () => {
    const base = {
      preset: 'forest',
      mode: 'dark',
      appLaunch: { mode: 'window' },
      appearance: normaliseDesktopAppearance({
        accent: '#ffffff',
        motion: 'reduced',
        transparency: 'solid',
        lowEffects: true,
        glassBlur: 40,
        textScale: 150,
        wallpaperImage: 'a'.repeat(64),
        dockPins: ['local:fixture'],
      }),
    };
    const original = JSON.stringify(base);
    const projected = projectInterfaceThemePreferences(base, resolveInterfaceThemeSettings(tideline, settings), host);
    expect(projected.appearance.accent).toBeNull();
    expect(projected.appearance.motion).toBe('system');
    expect(projected.appearance.transparency).toBe('system');
    expect(projected.appearance.lowEffects).toBe(false);
    expect(projected.appearance.glassBlur).toBeNull();
    expect(projected.appearance.textScale).toBe(150);
    expect(projected.appearance.wallpaperImage).toBe('a'.repeat(64));
    expect(projected.appearance.dockPins).toEqual(['local:fixture']);
    expect(projected.appLaunch).toBe(base.appLaunch);
    expect(projected.mode).toBe('dark');
    expect(JSON.stringify(base)).toBe(original);
    expect(projectInterfaceThemePreferences(base, null, host)).toEqual(base);
  });

  test('applies explicit OS and resource limits after theme values without inventing persistent clamps', () => {
    const base = { preset: 'frost', appearance: normaliseDesktopAppearance({ textScale: 140 }) };
    const theme = resolveInterfaceThemeSettings(alpine, settings);
    const limited = projectInterfaceThemePreferences(base, theme, {
      reducedMotion: true,
      reducedTransparency: true,
      forcedColours: true,
      resourceLimited: true,
    });
    expect(limited.appearance.motion).toBe('reduced');
    expect(limited.appearance.transparency).toBe('solid');
    expect(limited.appearance.accent).toBeNull();
    expect(limited.appearance.lowEffects).toBe(true);
    expect(limited.appearance.textScale).toBe(140);
    expect(projectInterfaceThemePreferences(base, theme, host).appearance.lowEffects).toBe(false);
  });

  test('startup and hydration use exactly the same validated namespace and projector', () => {
    const base = {
      preset: 'frost',
      appearance: normaliseDesktopAppearance({ accent: '#ffffff', motion: 'reduced', transparency: 'solid', textScale: 150 }),
    };
    for (const identity of [alpine, tideline, { id: 'orbis-builtin', version: '1.0.0' }]) {
      const context = { localStorage: { getItem: () => raw() }, matchMedia: () => ({ matches: false }), base, identity, result: null };
      vm.runInNewContext(`${interfaceThemeCacheBootstrap}\nresult=interfaceThemeBeforePaint(base,identity);`, context);
      const hydrated = projectInterfaceThemePreferences(base, resolvePublicInterfaceTheme(decodeInterfaceThemeCache(raw()), identity), host);
      expect(JSON.parse(JSON.stringify(context.result))).toEqual(hydrated);
    }
  });

  test('import adapters take only controls defined by the target theme', () => {
    const base = { preset: 'ocean', appearance: normaliseDesktopAppearance({ accent: '#123456', textScale: 150, dockPins: ['local:fixture'] }) };
    const legacy = interfaceThemeValuesFromLegacy(base, resolveInterfaceThemeSettings(alpine, settings).descriptor);
    const builtin = interfaceThemeValuesFromLegacy(base, resolveInterfaceThemeSettings(null, settings).descriptor);
    expect(legacy.some((item) => item.key === 'palette')).toBe(false);
    expect(builtin.find((item) => item.key === 'palette')?.value).toBe('ocean');
    expect(JSON.stringify(legacy)).not.toContain('textScale');
    expect(JSON.stringify(legacy)).not.toContain('dockPins');
  });

  test('minified bootstrap retains its self-contained helpers and produces the hydration projection', async () => {
    // Bun 1.3 retains resolver state across build fixtures; isolate this fixture from the legacy bootstrap test.
    const code = `
      const entry='orbis-interface-cache-test';
      const schemaRoot=${JSON.stringify(new URL('../../../../common/src/schemas/', import.meta.url).pathname)};
      const result=await Bun.build({entrypoints:[entry],target:'browser',format:'iife',minify:true,plugins:[{name:'interface-cache-entry',setup(build){
        build.onResolve({filter:/^orbis-interface-cache-test$/},()=>({path:entry,namespace:'interface-cache'}));
        build.onLoad({filter:/.*/,namespace:'interface-cache'},()=>({contents:${JSON.stringify(`import {interfaceThemeCacheBootstrap} from ${JSON.stringify(new URL('./interface-theme-cache.ts', import.meta.url).pathname)};globalThis.bootstrap=interfaceThemeCacheBootstrap;`)},loader:'ts'}));
        build.onResolve({filter:/^@runtipi\\/common\\/schemas\\/(interface-theme|interface-theme-registry|interface-theme-resolution)$/},args=>({path:schemaRoot+args.path.split('/').at(-1)+'.ts'}));
      }}]});
      if(!result.success){process.stderr.write(String(result.logs));process.exit(1);}
      process.stdout.write(await result.outputs[0].text());
    `;
    const child = Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' });
    const [bundle, diagnostics, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode, diagnostics).toBe(0);
    const bundled: Record<string, unknown> = {
      Blob,
      File,
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      FormData,
      AbortController,
      AbortSignal,
      DOMException,
      console,
      crypto,
    };
    vm.runInNewContext(bundle, bundled);
    if (typeof bundled.bootstrap !== 'string') throw new Error('Missing minified bootstrap');
    const base = { preset: 'frost', appearance: normaliseDesktopAppearance({ textScale: 150 }) };
    const context = {
      localStorage: { getItem: () => raw() },
      matchMedia: (query: string) => ({ matches: query.includes('reduced-transparency') }),
      base,
      identity: alpine,
      result: null,
    };
    vm.runInNewContext(`${bundled.bootstrap}\nresult=interfaceThemeBeforePaint(base,identity);`, context);
    expect(JSON.parse(JSON.stringify(context.result))).toEqual(
      projectInterfaceThemePreferences(base, resolvePublicInterfaceTheme(settings, alpine), { ...host, reducedTransparency: true }),
    );
  });
});

describe('controlled descriptor settings states', () => {
  test('renders local reviewed controls with native labels and preserves the builtin fallback choice', async () => {
    const current = await session();
    const html = renderToStaticMarkup(
      <>
        <InterfaceThemeControls session={current} />
        <InterfaceThemePaletteFallback session={current} />
      </>,
    );
    for (const label of ['Accent colour', 'Panel opacity', 'Panel blur', 'Bar and dock blur', 'Motion', 'Energy saving', 'Colour preset fallback'])
      expect(html).toContain(label);
    expect(html).toContain('type="color"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('Alpine provides these controls');
    expect(html).toContain('Use theme default');
  });

  test('does not render arbitrary response definitions or theme-supplied executable fields', async () => {
    const current = await session();
    const malicious = {
      ...current,
      current: current.current
        ? {
            ...current.current,
            descriptor: {
              ...current.current.descriptor,
              name: 'Injected theme',
              settings: [{ key: 'injected', label: 'Run uploaded code', group: 'unsafe', kind: 'boolean', default: false }],
            },
          }
        : null,
    } as InterfaceThemeSession;
    const html = renderToStaticMarkup(<InterfaceThemeControls session={malicious} />);
    expect(html).not.toContain('Run uploaded code');
    expect(html).not.toContain('Injected theme provides');
    expect(html).toContain('Alpine provides');
  });

  test('preserves invalid draft text visibly with connected validation messages', async () => {
    const current = await session();
    if (!current.current) throw new Error('Missing theme binding');
    const invalid = {
      ...current,
      current: {
        ...current.current,
        dirty: true,
        values: current.current.values.map((item) =>
          item.key === 'accent' ? { key: item.key, value: '#12' } : item.key === 'panel-opacity' ? { key: item.key, value: '9' } : item,
        ),
      },
    };
    const html = renderToStaticMarkup(<InterfaceThemeControls session={invalid} />);
    expect(html).toContain('value="#12"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Use six hexadecimal digits');
    expect(html).toContain('Enter a whole number within the displayed range');
    expect(html).toContain('aria-describedby');
  });

  test('shows loading, explicit migration, old-backend compatibility, authentication and revision recovery states', async () => {
    const ready = await session();
    expect(renderToStaticMarkup(<InterfaceThemeControls session={{ ...ready, status: 'loading', pending: true }} />)).toContain(
      'Loading theme settings',
    );
    expect(renderToStaticMarkup(<InterfaceThemeControls session={{ ...ready, status: 'migration' }} />)).toContain('Keep appearance in this theme');
    const old = renderToStaticMarkup(
      <InterfaceThemeControls
        session={{ ...ready, status: 'legacy', error: new ThemeSettingsError('compatibility', 'Shared appearance only.') }}
        legacyControls={<div>Existing legacy controls</div>}
      />,
    );
    expect(old).toContain('Existing legacy controls');
    expect(old).not.toContain('Alpine provides');
    for (const kind of ['authentication', 'conflict', 'unsupported'] as const) {
      const html = renderToStaticMarkup(
        <InterfaceThemeControls session={{ ...ready, status: 'error', error: new ThemeSettingsError(kind, `${kind} recovery`) }} />,
      );
      expect(html).toContain('role="alert"');
      expect(html).toContain(`${kind} recovery`);
      expect(html).toContain('Reload theme settings');
      expect(html).toContain('disabled');
    }
  });
});
