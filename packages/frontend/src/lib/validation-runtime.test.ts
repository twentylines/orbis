import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';

// Each mode needs a fresh module cache: ArkType resolves configuration when schemas load.
function validateInProcess(browser: boolean) {
  const runtime = new URL('./validation-runtime.ts', import.meta.url).href;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--eval',
        `
        ${browser ? `await import(${JSON.stringify(runtime)});` : ''}
        const { desktopAppearanceSchema, normaliseDesktopAppearance } = await import('@runtipi/common/schemas/desktop-appearance');
        const { desktopWindowsSchema } = await import('@runtipi/common/schemas/desktop-windows');
        const { appLaunchSchema } = await import('@runtipi/common/schemas/app-launch');
        const { dynamicComposeSchemaArk } = await import('@runtipi/common/schemas/dynamic-compose-ark');
        const { newAccountIdentifier } = await import(${JSON.stringify(new URL('../modules/auth/account-identifier.ts', import.meta.url).href)});
        const bounds = { x: 24, y: 24, width: 800, height: 600 };
        const cases = [
          [desktopAppearanceSchema, {}],
          [desktopAppearanceSchema, { chromeBlur: 64, glassBlur: 40, textScale: 150, accent: '#AAbbcc' }],
          [desktopAppearanceSchema, { chromeBlur: 65 }],
          [desktopAppearanceSchema, { glassBlur: NaN }],
          [desktopAppearanceSchema, { textScale: Infinity }],
          [desktopAppearanceSchema, { command: 'invalid' }],
          [desktopAppearanceSchema, { dockPins: ['one:store', 'one:store'] }],
          [desktopWindowsSchema, { apps: { mode: 'maximized', bounds, restoreMode: 'floating' } }],
          [desktopWindowsSchema, { apps: { mode: 'floating', bounds: { ...bounds, width: 239 } } }],
          [desktopWindowsSchema, { unknown: { mode: 'floating', bounds } }],
          [appLaunchSchema, { mode: 'tab', apps: Object.fromEntries(Array.from({ length: 512 }, (_, i) => ['app'+i+':store', { mode: 'window', bounds }])) }],
          [appLaunchSchema, { mode: 'tab', apps: Object.fromEntries(Array.from({ length: 513 }, (_, i) => ['app'+i+':store', {}])) }],
          [appLaunchSchema, { mode: 'tab', apps: { 'bad key': {} } }],
          [dynamicComposeSchemaArk, { schemaVersion: 2, services: [{ name: 'web', image: 'nginx:alpine', internalPort: 80, isMain: true }] }],
          [dynamicComposeSchemaArk, { schemaVersion: 2, services: [] }],
          [dynamicComposeSchemaArk, { schemaVersion: 2, services: [{ name: 'web', image: 'nginx:alpine', internalPort: 65536 }] }],
          [newAccountIdentifier, 'server.owner'],
          [newAccountIdentifier, 'owner@example.com'],
          [newAccountIdentifier, 'administrator'],
          [newAccountIdentifier, 'bad name'],
        ];
        console.log(JSON.stringify({
          results: cases.map(([schema, input]) => {
            const before = JSON.stringify(input);
            const allowed = schema.allows(input);
            return { allowed, output: allowed ? schema(input) : null, mutated: before !== JSON.stringify(input) };
          }),
          normalised: [normaliseDesktopAppearance({}), normaliseDesktopAppearance({ chromeBlur: NaN })],
        }));
        `,
      ],
      { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 10_000 },
    ),
  ) as { results: { allowed: boolean; output: unknown; mutated: boolean }[]; normalised: unknown[] };
}

test('browser validation preserves preference, window, compose and account contracts', () => {
  const compiled = validateInProcess(false);
  const browser = validateInProcess(true);
  expect(browser).toEqual(compiled);
  expect(browser.results.map((result) => result.allowed)).toEqual([
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    true,
    false,
    false,
    true,
    false,
    false,
    true,
    true,
    false,
    false,
  ]);
  expect(browser.results.every((result) => !result.mutated)).toBe(true);
  expect(browser.normalised[0]).toEqual(browser.normalised[1]);
});
