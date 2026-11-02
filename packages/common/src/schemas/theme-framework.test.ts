// biome-ignore-all lint/style/noNonNullAssertion: the fixed contract fixture supplies every indexed entry mutated by these tests.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type } from 'arktype';
import { adaptLegacyThemeFramework } from './theme-framework-adapter.js';
import {
  dismissThemeFrameworkUiNotice,
  evaluateThemeFrameworkCompatibility,
  reconcileThemeFrameworkUiSupport,
  resolveThemeFrameworkSound,
  themeFrameworkUiNoticeVisible,
} from './theme-framework-compatibility.js';
import {
  themeFrameworkDocumentSchema,
  themeFrameworkJsonSchema,
  type ThemeFrameworkDocument,
  type FrameworkNode,
} from './theme-framework-contract.js';
import {
  essentialFrameworkComponents,
  frameworkActions,
  frameworkComponents,
  frameworkComponentIds,
  frameworkSoundEventIds,
  silentFrameworkSounds,
  themeFrameworkRuntimeAvailable,
} from './theme-framework-registry.js';
import { validateThemeFrameworkDocument } from './theme-framework-validation.js';
import {
  resolveThemeFrameworkTokens,
  resolveThemeFrameworkIcon,
  resolveThemeFrameworkLayout,
  type FrameworkProjectionHost,
} from './theme-framework-resolution.js';
import { themePackManifestSchema } from './theme-pack.js';
import type { InterfaceThemeSettingsState } from './interface-theme.js';
import { builtinInterfaceTheme, legacyThemeIdentities, legacyThemeVersions } from './interface-theme-registry.js';

// Contract data only: no distributable package, bundled theme or runtime renderer.
function document(): ThemeFrameworkDocument {
  return {
    schema: 'orbis.theme-framework.v1',
    id: 'contract-test',
    version: '1.0.0',
    name: 'Contract test',
    settingsVersion: 1,
    requires: { api: 1, releases: ['0.5.0-beta.3', '1.0.0'] },
    supportsUiRevisions: [],
    components: frameworkComponentIds.map((id) => ({ id, variant: 'standard' })),
    tokens: {
      colours: {
        background: '#ffffff',
        surface: '#ffffff',
        ink: '#111111',
        muted: '#444444',
        accent: '#2255bb',
        danger: '#a01010',
        focus: '#2255bb',
      },
      typography: { family: 'system', baseSize: 16, scale: 1 },
      spacing: { unit: 4, gap: 16, inset: 16 },
      shape: { radius: 16, borderWidth: 1 },
      motion: { duration: 180, curve: 'standard' },
    },
    modes: [],
    tokenRules: [],
    tokenBindings: [],
    icons: [],
    assets: [],
    settings: [
      { key: 'enabled', label: 'Enabled', group: 'appearance', kind: 'boolean', default: false },
      { key: 'size', label: 'Size', group: 'appearance', kind: 'integer', default: 0, min: 0, max: 10, step: 2 },
      { key: 'accent', label: 'Accent', group: 'appearance', kind: 'colour', default: null },
      {
        key: 'density',
        label: 'Density',
        group: 'appearance',
        kind: 'enum',
        default: 'normal',
        options: [
          { value: 'normal', label: 'Normal' },
          { value: 'compact', label: 'Compact' },
        ],
      },
    ],
    conditions: [],
    customisation: {
      hostControls: 'always',
      sections: [{ id: 'appearance', label: 'Appearance', settings: ['enabled', 'size', 'accent', 'density'] }],
      presets: [
        {
          id: 'initial',
          label: 'Initial',
          values: [
            { key: 'enabled', value: false },
            { key: 'size', value: 0 },
            { key: 'accent', value: null },
          ],
        },
      ],
    },
    layouts: (['phone', 'tablet', 'desktop'] as const).map((viewport) => ({
      viewport,
      columns: viewport === 'phone' ? 1 : 4,
      nodes: essentialFrameworkComponents.map((component, order) => ({
        id: component,
        kind: 'core',
        component,
        slot:
          component === 'shell.navigation'
            ? 'shell.footer'
            : component === 'shell.session'
              ? 'shell.header'
              : component === 'settings.recovery'
                ? 'settings.header'
                : 'shell.overlay',
        parent: null,
        anchor: 'viewport.safe',
        order,
        placement: { kind: 'host' },
      })),
    })),
    sounds: silentFrameworkSounds(),
  };
}
function reject(change: (value: ThemeFrameworkDocument) => void, code?: string) {
  const value = document();
  change(value);
  const result = validateThemeFrameworkDocument(value);
  expect(result.valid).toBe(false);
  if (!result.valid && code) expect(result.issues.some((issue) => issue.code === code)).toBe(true);
}
function add(value: ThemeFrameworkDocument, node: FrameworkNode) {
  value.layouts[2]?.nodes.push(node);
}
const textNode = (): Extract<FrameworkNode, { kind: 'text' }> => ({
  id: 'theme.note',
  kind: 'text',
  text: 'Saved text',
  slot: 'shell.primary',
  parent: null,
  anchor: 'viewport.safe',
  order: 10,
  placement: { kind: 'flow', span: 1 },
});
const additionBase = () => {
  const { text: _text, kind: _kind, ...base } = textNode() as Extract<FrameworkNode, { kind: 'text' }>;
  return base;
};
const asset = () => ({
  id: 'image',
  kind: 'image' as const,
  mime: 'image/png' as const,
  path: 'assets/image.png',
  sha256: 'a'.repeat(64),
  bytes: 20,
  width: 2,
  height: 2,
});

describe('framework structural contract', () => {
  test('separate discriminator and generated schema agree with the implementation', () => {
    const value = document();
    expect(themeFrameworkDocumentSchema.allows(value)).toBe(true);
    expect(validateThemeFrameworkDocument(value).valid).toBe(true);
    expect(themePackManifestSchema.allows(value)).toBe(false);
    expect(themeFrameworkDocumentSchema.allows({ formatVersion: 1, ...value, schema: undefined })).toBe(false);
    expect(JSON.parse(readFileSync(new URL('../../json-schemas/theme-framework-v1.json', import.meta.url), 'utf8'))).toEqual(
      themeFrameworkJsonSchema(),
    );
    expect(themeFrameworkJsonSchema().$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });
  test.each(['script', 'css', 'selector', 'onClick', 'url', 'implementation'])('rejects undeclared execution surface %s', (key) => {
    const value = { ...document(), [key]: 'untrusted' };
    expect(themeFrameworkDocumentSchema(value)).toBeInstanceOf(type.errors);
    expect(validateThemeFrameworkDocument(value).valid).toBe(false);
  });
  test('never evaluates accessors or accepts non JSON values', () => {
    let invoked = false;
    const value = Object.defineProperty({}, 'schema', {
      enumerable: true,
      get() {
        invoked = true;
        return 'orbis.theme-framework.v1';
      },
    });
    expect(validateThemeFrameworkDocument(value).valid).toBe(false);
    expect(invoked).toBe(false);
    for (const input of [new Date(), () => null, Number.NaN, { value: Number.POSITIVE_INFINITY }, JSON.parse('{"__proto__":{}}')])
      expect(validateThemeFrameworkDocument(input).valid).toBe(false);
  });
  test('requires registered variants, fixed tokens and bounded values', () => {
    reject((value) => {
      value.components[0]!.variant = 'unregistered';
    }, 'component-variant');
    reject((value) => {
      value.tokens.typography.baseSize = 1;
    }, 'structure');
    reject((value) => {
      value.tokens.typography.family = 'unknown';
    }, 'font-reference');
    reject((value) => {
      value.id = 'orbis-builtin';
    }, 'reserved-identity');
    reject((value) => {
      value.id = 'constructor';
    }, 'reserved-id');
    reject((value) => {
      value.name = '   ';
    }, 'empty-label');
    reject((value) => {
      value.name = '<script>';
    }, 'structure');
  });
  test('reserves Default without renaming the persisted built-in identity', () => {
    reject((value) => {
      value.id = 'default';
    }, 'reserved-identity');
    expect(adaptLegacyThemeFramework({ id: 'orbis-builtin', version: '1.0.0' }, {}, { formatVersion: 1, entries: [] }).identity.id).toBe(
      'orbis-builtin',
    );
  });
  test('registry IDs are unique, frozen, gesture bound and not runtime capability', () => {
    expect(new Set(frameworkComponentIds).size).toBe(frameworkComponentIds.length);
    expect(frameworkComponentIds.every((id) => frameworkComponents[id].variants.length <= 2)).toBe(true);
    expect(Object.isFrozen(frameworkComponents['shell.navigation'].essentialSlots)).toBe(true);
    expect(Object.values(frameworkActions).every((action) => action.gesture)).toBe(true);
    expect(frameworkActions['session.logout'].confirmation).toBe('core');
    expect(themeFrameworkRuntimeAvailable).toBe(false);
  });
});

describe('framework layout safety', () => {
  test.each(['phone', 'tablet', 'desktop'] as const)('essential controls remain reachable in %s', (viewport) => {
    for (const essential of essentialFrameworkComponents) {
      reject((value) => {
        const layout = value.layouts.find((item) => item.viewport === viewport)!;
        layout.nodes = layout.nodes.filter((node) => node.id !== essential);
      }, 'essential-component');
      reject((value) => {
        value.layouts.find((item) => item.viewport === viewport)!.nodes.find((node) => node.id === essential)!.visibleWhen = 'hide';
      }, 'essential-placement');
      reject((value) => {
        value.layouts.find((item) => item.viewport === viewport)!.nodes.find((node) => node.id === essential)!.constraints = {
          minWidth: 0,
          maxWidth: 44,
          minHeight: 0,
          maxHeight: 44,
          scroll: 'none',
        };
      }, 'essential-placement');
    }
  });
  test('rejects duplicate/missing profiles, oversized phone grids and unsupported core slots', () => {
    reject((value) => {
      value.layouts[0]!.viewport = 'desktop';
    }, 'duplicate');
    reject((value) => {
      value.layouts[0]!.columns = 2;
    }, 'viewport-columns');
    reject((value) => {
      value.layouts[0]!.nodes.find((node) => node.id === 'shell.navigation')!.slot = 'notification.actions';
    }, 'core-placement');
  });
  test('keeps added elements out of protected host layers and validates parents', () => {
    reject((value) => {
      add(value, { ...textNode(), slot: 'shell.overlay' });
    }, 'addition-placement');
    reject((value) => {
      add(value, { ...textNode(), parent: 'missing' });
    }, 'parent-reference');
    reject((value) => {
      add(value, { ...textNode(), parent: 'shell.navigation' });
    }, 'parent-reference');
    reject((value) => {
      add(value, { ...additionBase(), kind: 'group', axis: 'column', label: 'Group', parent: 'theme.note' } as FrameworkNode);
    }, 'dependency-cycle-or-depth');
  });
  test('requires bounded floating with explicit responsive fallback and whole interactive targets', () => {
    const floating: FrameworkNode = {
      ...textNode(),
      placement: { kind: 'float', fallback: 'flow', x: 10, y: 10, width: 50, height: 50 },
      constraints: { minWidth: 44, maxWidth: 400, minHeight: 44, maxHeight: 400, scroll: 'content' },
    };
    const valid = document();
    add(valid, floating);
    expect(validateThemeFrameworkDocument(valid).valid).toBe(true);
    const phoneFloat = document();
    phoneFloat.layouts[0]!.nodes.push(floating);
    expect(validateThemeFrameworkDocument(phoneFloat).valid).toBe(true);
    reject((value) => {
      add(value, { ...floating, placement: { kind: 'float', fallback: 'flow', x: 80, y: 10, width: 50, height: 50 } });
    }, 'floating-placement');
    reject((value) => {
      add(value, { ...floating, constraints: undefined });
    }, 'json-data-only');
    reject((value) => {
      add(value, {
        ...additionBase(),
        kind: 'action',
        label: 'Home',
        action: 'navigation.home',
        constraints: { minWidth: 20, maxWidth: 100, minHeight: 20, maxHeight: 100, scroll: 'content' },
      } as FrameworkNode);
    }, 'constraints');
  });
  test('only permits registered action contexts and known setting/asset references', () => {
    reject((value) => {
      add(value, { ...additionBase(), kind: 'action', label: 'Close', action: 'window.close' } as FrameworkNode);
    }, 'action-context');
    reject((value) => {
      add(value, { ...additionBase(), kind: 'control', setting: 'missing' } as FrameworkNode);
    }, 'control-reference');
    reject((value) => {
      add(value, { ...additionBase(), kind: 'image', asset: 'missing', alt: 'Image' } as FrameworkNode);
    }, 'image-reference');
    reject((value) => {
      add(value, { ...additionBase(), kind: 'action', label: 'Run', action: 'exec.command' } as unknown as FrameworkNode);
    }, 'structure');
  });
});

describe('framework settings and assets', () => {
  test('preserves explicit false, zero and null defaults and presets', () => {
    const result = validateThemeFrameworkDocument(document());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.document.customisation.presets[0]!.values.map((item) => item.value)).toEqual([false, 0, null]);
  });
  test('validates settings coverage, types, integer steps, unique options and preset values', () => {
    reject((value) => {
      value.customisation.sections[0]!.settings.pop();
    }, 'settings-coverage');
    reject((value) => {
      value.settings[1]!.default = 3 as never;
    }, 'setting-default');
    reject((value) => {
      const setting = value.settings[1]!;
      if (setting.kind === 'integer') setting.max = 9;
    }, 'integer-range');
    reject((value) => {
      const setting = value.settings[3]!;
      if (setting.kind === 'enum') setting.options.push(setting.options[0]!);
    }, 'duplicate');
    reject((value) => {
      value.customisation.presets[0]!.values[0]!.value = 0;
    }, 'preset-value');
  });
  test('validates condition values, unknown references and visibility cycles', () => {
    reject((value) => {
      value.settings[0]!.visibleWhen = 'missing';
    }, 'condition-reference');
    reject((value) => {
      value.conditions.push({ id: 'invalid', all: [{ setting: 'enabled', equals: 0 }] });
    }, 'condition-setting');
    reject((value) => {
      value.conditions.push({ id: 'self', all: [{ setting: 'enabled', equals: true }] });
      value.settings[0]!.visibleWhen = 'self';
    }, 'dependency-cycle-or-depth');
    reject((value) => {
      value.conditions.push({ id: 'section', all: [{ setting: 'enabled', equals: true }] });
      value.customisation.sections[0]!.visibleWhen = 'section';
    }, 'dependency-cycle-or-depth');
  });
  test('raster/font/audio metadata stays local, typed, hashed and bounded', () => {
    const value = document();
    value.assets.push(asset());
    expect(validateThemeFrameworkDocument(value).valid).toBe(true);
    reject((value) => {
      value.assets.push({ ...asset(), path: 'https://host/image.png' });
    }, 'structure');
    reject((value) => {
      value.assets.push({ ...asset(), path: 'assets/../../secret.png' });
    }, 'structure');
    reject((value) => {
      value.assets.push({ ...asset(), path: 'assets/icon.svg' });
    }, 'structure');
    reject((value) => {
      value.assets.push({ ...asset(), path: 'assets/image.webp' });
    }, 'asset-extension');
    reject((value) => {
      value.assets.push({ ...asset(), width: 8192, height: 8192 });
    }, 'asset-resource');
    reject((value) => {
      value.assets = Array.from({ length: 9 }, (_, index) => ({
        ...asset(),
        id: `asset-${index}`,
        path: `assets/image-${index}.png`,
        bytes: 8388608,
      }));
    }, 'asset-budget');
    reject((value) => {
      value.assets.push(asset(), { ...asset(), id: 'other' });
    }, 'duplicate');
  });
});

describe('hard compatibility and installed-version soft support', () => {
  test('exact hard releases are independent of runtime availability and soft revisions', () => {
    const value = document();
    expect(evaluateThemeFrameworkCompatibility(value, { api: 1, release: 'v0.5.0-beta.3' })).toEqual({
      hostRequirementsMet: true,
      runtimeAvailable: false,
      reasons: [],
    });
    expect(evaluateThemeFrameworkCompatibility(value, { api: 2, release: '0.5.0' }).reasons).toEqual(['host-api', 'host-release']);
    reject((value) => {
      value.requires.releases.push('v1.0.0');
    }, 'duplicate');
  });
  test('ordinary host releases preserve unresolved status and dismissal is surface-only', () => {
    const value = document();
    const pending = reconcileThemeFrameworkUiSupport(value, null, 2);
    expect(themeFrameworkUiNoticeVisible(pending)).toBe(true);
    const dismissed = dismissThemeFrameworkUiNotice(pending);
    expect(dismissed.pending).toEqual([2]);
    expect(themeFrameworkUiNoticeVisible(dismissed)).toBe(false);
    expect(reconcileThemeFrameworkUiSupport(value, dismissed, null)).toEqual(dismissed);
    const changed = reconcileThemeFrameworkUiSupport(value, dismissed, 3);
    expect(changed.pending).toEqual([2, 3]);
    expect(themeFrameworkUiNoticeVisible(changed)).toBe(true);
  });
  test('installed version updates resurface unsupported notices and only declared support clears pending', () => {
    const value = document();
    const dismissed = dismissThemeFrameworkUiNotice(reconcileThemeFrameworkUiSupport(value, null, 2));
    value.version = '1.1.0';
    const unsupported = reconcileThemeFrameworkUiSupport(value, dismissed, null);
    expect(themeFrameworkUiNoticeVisible(unsupported)).toBe(true);
    value.supportsUiRevisions = [2];
    expect(reconcileThemeFrameworkUiSupport(value, unsupported, null).pending).toEqual([]);
  });
  test('never merges another theme namespace or malformed support state', () => {
    const value = document();
    const state = reconcileThemeFrameworkUiSupport(value, null, 2);
    expect(() => reconcileThemeFrameworkUiSupport({ ...value, id: 'other-theme' }, state, null)).toThrow('separate');
    expect(() => dismissThemeFrameworkUiNotice({ ...state, dismissed: [3] })).toThrow();
    expect(() => reconcileThemeFrameworkUiSupport(value, state, 0)).toThrow();
  });
});

describe('silent and gesture-aware sounds', () => {
  test('all registered events start silent', () => {
    const value = document();
    expect(value.sounds.map((sound) => sound.event)).toEqual([...frameworkSoundEventIds]);
    for (const event of frameworkSoundEventIds)
      expect(resolveThemeFrameworkSound(value, event, { gestureUnlocked: true, muted: false, volume: 1 })).toBeNull();
  });
  test('audio never plays before gesture unlock or while muted, volume cannot exceed host cap', () => {
    const value = document();
    value.assets.push({ id: 'tone', kind: 'audio', mime: 'audio/ogg', path: 'assets/tone.ogg', sha256: 'b'.repeat(64), bytes: 40, durationMs: 300 });
    value.sounds[0] = { event: 'session.login', asset: 'tone', gain: 0.5 };
    const host = { gestureUnlocked: true, muted: false, volume: 0.4 };
    expect(resolveThemeFrameworkSound(value, 'session.login', host)?.gain).toBe(0.2);
    for (const restricted of [
      { ...host, gestureUnlocked: false },
      { ...host, muted: true },
      { ...host, volume: 2 },
    ])
      expect(resolveThemeFrameworkSound(value, 'session.login', restricted)).toBeNull();
    reject((value) => {
      value.sounds[0]!.gain = 1;
    }, 'sound-reference');
  });
});

describe('lossless host legacy adapter', () => {
  test('Default retains exact built-in identity, settings, appearance and all saved namespaces', () => {
    const preferences = {
      palette: 'forest',
      accent: null,
      panelOpacity: 0,
      lowEffects: false,
      theme: { id: 'alpine', version: '1.0.0' },
      inactive: { preserved: true },
    };
    const namespaces: InterfaceThemeSettingsState = {
      formatVersion: 1,
      entries: [
        {
          id: 'orbis-builtin',
          settingsVersion: 1,
          values: [
            { key: 'low-effects', value: false },
            { key: 'panel-tint', value: 0 },
            { key: 'accent', value: null },
          ],
        },
        { id: 'alpine', settingsVersion: 1, values: [{ key: 'panel-blur', value: 0 }] },
      ],
    };
    const snapshot = structuredClone({ preferences, namespaces });
    const adapted = adaptLegacyThemeFramework({ id: 'orbis-builtin', version: '1.0.0' }, preferences, namespaces);
    expect(adapted.name).toBe('Default');
    expect(adapted.identity).toEqual({ id: 'orbis-builtin', version: '1.0.0' });
    expect({ preferences: adapted.preferences, namespaces: adapted.namespaces }).toEqual(snapshot);
    expect(adapted.uiSupport).toBe('host-maintained');
    expect(adapted.sounds.every((sound) => sound.asset === null && sound.gain === 0)).toBe(true);
    adapted.preferences.inactive.preserved = false;
    adapted.namespaces.entries[0]!.values[0]!.value = true;
    expect({ preferences, namespaces }).toEqual(snapshot);
    expect(builtinInterfaceTheme.name).toBe('Orbis');
  });
  test('legacy adapter preserves every registered legacy identity/version and rejects inventions', () => {
    const namespaces: InterfaceThemeSettingsState = { formatVersion: 1, entries: [] };
    for (const identity of legacyThemeIdentities)
      for (const version of legacyThemeVersions) {
        const adapted = adaptLegacyThemeFramework({ id: identity.id, version }, { transparency: 'glass' }, namespaces);
        expect(adapted.identity).toEqual({ id: identity.id, version });
        expect(adapted.name).toBe(identity.name);
        expect(adapted.uiSupport).toBe('legacy-undeclared');
      }
    expect(() => adaptLegacyThemeFramework({ id: 'default', version: '1.0.0' }, {}, namespaces)).toThrow();
    expect(() => adaptLegacyThemeFramework({ id: 'orbis-builtin', version: '2.0.0' }, {}, namespaces)).toThrow();
  });
});

function host(width = 1280, height = 1200, textScale = 1): FrameworkProjectionHost {
  return {
    width,
    height,
    textScale,
    mode: 'light',
    safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    measureText(text, available, scale) {
      const words = text.split(/\s+/).filter(Boolean);
      const widths = words.map((word) => word.length * 8 * scale);
      let lines = 1;
      let line = 0;
      for (const width of widths) {
        if (line && line + 8 * scale + width > available) {
          lines++;
          line = width;
        } else line += (line ? 8 * scale : 0) + width;
      }
      return { minWidth: Math.max(...widths, 0), height: lines * 20 * scale };
    },
    measureCore(component, _width, scale) {
      return { minWidth: component === 'layer.dialogs' ? 240 : 44, height: component === 'layer.dialogs' ? 160 : 44 * scale };
    },
  };
}
function modeData(): ThemeFrameworkDocument {
  const value = document();
  value.conditions = [{ id: 'active', all: [{ setting: 'enabled', equals: true }] }];
  value.modes = [
    {
      mode: 'dark',
      values: [
        { token: 'colours.background', value: '#101010' },
        { token: 'colours.ink', value: '#eeeeee' },
      ],
    },
    { mode: 'oled', values: [{ token: 'colours.background', value: '#000000' }] },
  ];
  value.tokenRules = [{ mode: 'all', when: 'active', values: [{ token: 'colours.accent', value: '#bb0000' }] }];
  value.tokenBindings = [
    { token: 'colours.accent', setting: 'accent', transform: 'identity' },
    { token: 'spacing.gap', setting: 'size', transform: 'identity' },
  ];
  return value;
}

describe('executable mode, condition, token and icon resolution', () => {
  test('mode inheritance, conditions and safe settings resolve deterministically without mutation', () => {
    const value = modeData();
    const before = structuredClone(value);
    const light = resolveThemeFrameworkTokens(value, [], { mode: 'light', textScale: 1, reducedMotion: false });
    const oled = resolveThemeFrameworkTokens(value, [{ key: 'enabled', value: true }], { mode: 'oled', textScale: 1, reducedMotion: false });
    expect(light.colours.background).toBe('#ffffff');
    expect(oled.colours.background).toBe('#000000');
    expect(oled.colours.ink).toBe('#eeeeee');
    expect(oled.colours.accent).toBe('#bb0000');
    expect(oled.spacing.gap).toBe(0);
    const explicit = resolveThemeFrameworkTokens(
      value,
      [
        { key: 'enabled', value: true },
        { key: 'accent', value: '#123456' },
      ],
      { mode: 'dark', textScale: 1, reducedMotion: false },
    );
    expect(explicit.colours.accent).toBe('#123456');
    expect(value).toEqual(before);
  });
  test('percent bindings and core accessibility overrides apply after theme values', () => {
    const value = modeData();
    value.settings.push({ key: 'zoom', label: 'Scale', kind: 'integer', group: 'appearance', min: 85, max: 150, step: 1, default: 100 });
    value.customisation.sections[0]!.settings.push('zoom');
    value.tokenBindings.push({ token: 'typography.scale', setting: 'zoom', transform: 'percent' });
    const forced = { ...value.tokens.colours, background: '#000000', ink: '#ffffff' };
    const output = resolveThemeFrameworkTokens(value, [{ key: 'zoom', value: 125 }], {
      mode: 'oled',
      textScale: 1.5,
      reducedMotion: true,
      forcedColours: forced,
    });
    expect(output.typography.scale).toBe(1.875);
    expect(output.motion.duration).toBe(0);
    expect(output.colours).toEqual(forced);
  });
  test('rejects unsafe token values, incompatible bindings and unknown settings', () => {
    reject((value) => {
      value.modes = [{ mode: 'dark', values: [{ token: 'typography.baseSize', value: 1 }] }];
    }, 'token-value');
    reject((value) => {
      value.tokenBindings = [{ token: 'typography.baseSize', setting: 'size', transform: 'identity' }];
    }, 'token-binding');
    reject((value) => {
      value.tokenBindings = [{ token: 'colours.accent', setting: 'size', transform: 'percent' }];
    }, 'token-binding');
    reject((value) => {
      value.tokenRules = [{ mode: 'all', when: 'missing', values: [] }];
    }, 'condition-reference');
    expect(() =>
      resolveThemeFrameworkTokens(document(), [{ key: 'unknown', value: 1 }], { mode: 'light', textScale: 1, reducedMotion: false }),
    ).toThrow();
    expect(() =>
      resolveThemeFrameworkTokens(
        document(),
        [
          { key: 'enabled', value: false },
          { key: 'enabled', value: true },
        ],
        { mode: 'light', textScale: 1, reducedMotion: false },
      ),
    ).toThrow();
    expect(() => resolveThemeFrameworkTokens(document(), [], { mode: 'light', textScale: 0.5, reducedMotion: false })).toThrow();
  });
  test('maps registered roles to local icons with mode/condition/setting overrides', () => {
    const value = modeData();
    value.assets = [
      { ...asset(), id: 'first', kind: 'icon', path: 'assets/first.png' },
      { ...asset(), id: 'second', kind: 'icon', path: 'assets/second.png' },
    ];
    value.settings.push({ key: 'icon-choice', label: 'Icon', group: 'appearance', kind: 'asset', assetKind: 'icon', default: null });
    value.customisation.sections[0]!.settings.push('icon-choice');
    value.icons = [
      { role: 'navigation.home', mode: 'all', asset: 'first' },
      { role: 'navigation.home', mode: 'dark', when: 'active', asset: 'second', setting: 'icon-choice' },
    ];
    expect(resolveThemeFrameworkIcon(value, 'navigation.home', 'light', [])).toMatchObject({ source: 'asset', asset: { id: 'first' } });
    expect(resolveThemeFrameworkIcon(value, 'navigation.home', 'oled', [{ key: 'enabled', value: true }])).toMatchObject({
      source: 'asset',
      asset: { id: 'second' },
    });
    expect(
      resolveThemeFrameworkIcon(value, 'navigation.home', 'dark', [
        { key: 'enabled', value: true },
        { key: 'icon-choice', value: 'first' },
      ]),
    ).toMatchObject({ source: 'asset', asset: { id: 'first' } });
    expect(resolveThemeFrameworkIcon(value, 'status.info', 'light', [])).toEqual({ source: 'core', role: 'status.info' });
  });
  test('missing, wrong-kind and external icon assets fail before resolution', () => {
    reject((value) => {
      value.icons = [{ role: 'navigation.home', mode: 'all', asset: 'missing' }];
    }, 'icon-reference');
    reject((value) => {
      value.assets = [asset()];
      value.icons = [{ role: 'navigation.home', mode: 'all', asset: 'image' }];
    }, 'icon-reference');
    reject((value) => {
      value.icons = [{ role: 'navigation.home', mode: 'all', asset: 'https://host/icon.png' }];
    }, 'structure');
    reject((value) => {
      value.icons = [{ role: 'navigation.home', mode: 'all', asset: null, setting: 'enabled' }];
    }, 'icon-setting');
  });
});

describe('protected core layout projection', () => {
  test('core order, resize, flow and grouping produce actual declarative geometry', () => {
    const value = document();
    const layout = value.layouts[2]!;
    const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
    navigation.slot = 'shell.primary';
    navigation.parent = 'theme.group';
    navigation.anchor = 'parent.content';
    navigation.placement = { kind: 'flow', span: 4 };
    navigation.constraints = { minWidth: 44, maxWidth: 200, minHeight: 44, maxHeight: 200, scroll: 'content' };
    layout.nodes.push({
      id: 'theme.group',
      kind: 'group',
      axis: 'column',
      label: 'Navigation',
      slot: 'shell.primary',
      parent: null,
      anchor: 'viewport.safe',
      order: 100,
      placement: { kind: 'flow', span: 4 },
    });
    expect(validateThemeFrameworkDocument(value).valid).toBe(true);
    const projection = resolveThemeFrameworkLayout(value, [], host());
    expect(projection.status).toBe('resolved');
    const group = projection.nodes.find((node) => node.id === 'theme.group')!;
    const placed = projection.nodes.find((node) => node.id === 'shell.navigation')!;
    expect(placed.parent).toBe('theme.group');
    expect(placed.rect.width).toBe(200);
    expect(placed.space).toBe('flow-content');
    expect(projection.regions.find((region) => region.parent === 'theme.group')!.rect.y).toBeGreaterThan(0);
    expect(group.rect.y).toBeGreaterThan(0);
    expect(placed.overflow).toBe('auto');
  });
  test('core docking and floating work within safe bounds instead of host-only stubs', () => {
    const value = document();
    const layout = value.layouts[2]!;
    const account = layout.nodes.find((node) => node.id === 'shell.session')!;
    account.placement = { kind: 'dock', edge: 'top', fallback: 'flow' };
    const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
    navigation.placement = { kind: 'float', fallback: 'flow', x: 60, y: 80, width: 30, height: 10 };
    navigation.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
    const projection = resolveThemeFrameworkLayout(value, [], host());
    expect(projection.status).toBe('resolved');
    expect(projection.nodes.find((node) => node.id === 'shell.session')!.placement).toBe('dock');
    expect(projection.nodes.find((node) => node.id === 'shell.navigation')!.placement).toBe('float');
    const floating = projection.nodes.find((node) => node.id === 'shell.navigation')!;
    expect(floating.rect.x + floating.rect.width).toBeLessThanOrEqual(projection.viewport.width);
    expect(floating.rect.y + floating.rect.height).toBeLessThanOrEqual(projection.viewport.height);
  });
  test.each([320, 390])('phone %spx and enlarged text preserve labelled escape controls and scrollable content', (width) => {
    const value = document();
    for (const layout of value.layouts) {
      const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
      navigation.placement = { kind: 'float', fallback: 'flow', x: 20, y: 20, width: 70, height: 70 };
      navigation.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
    }
    const projection = resolveThemeFrameworkLayout(value, [], host(width, 740, 1.5));
    expect(projection.status).toBe('resolved');
    expect(projection.profile).toBe('phone');
    expect(projection.nodes.find((node) => node.id === 'shell.navigation')!.placement).toBe('flow');
    expect(projection.escapes).toHaveLength(3);
    expect(Object.isFrozen(projection.escapes)).toBe(true);
    for (const escapeControl of projection.escapes) {
      expect(escapeControl.visibility).toBe('always');
      expect(escapeControl.style).toBe('host-accessible');
      expect(escapeControl.parent).toBeNull();
      expect(escapeControl.rect.width).toBeGreaterThanOrEqual(66);
      expect(escapeControl.rect.height).toBeGreaterThanOrEqual(66);
      expect(escapeControl.rect.x + escapeControl.rect.width).toBeLessThanOrEqual(width);
      expect(escapeControl.rect.y).toBeGreaterThanOrEqual(projection.viewport.y + projection.viewport.height);
      expect(escapeControl.rect.y + escapeControl.rect.height).toBeLessThanOrEqual(740);
    }
    for (const node of projection.nodes) {
      expect(node.wrap).toBe('words');
      expect(node.revealFocus).toBe(true);
      expect(node.rect.width).toBeLessThanOrEqual(projection.viewport.width);
    }
  });
  test('long natural labels reflow under trusted measurement fixtures', () => {
    const value = document();
    for (const layout of value.layouts)
      layout.nodes.push({ ...textNode(), text: 'Long ordinary labels stay readable with natural wrapping and comfortable space' });
    const projection = resolveThemeFrameworkLayout(value, [], host(320, 740, 1.5));
    expect(projection.status).toBe('resolved');
    const note = projection.nodes.find((node) => node.id === 'theme.note')!;
    expect(note.contentHeight).toBeGreaterThan(30);
    expect(note.contentHeight).toBeGreaterThanOrEqual(note.rect.height);
    expect(note.wrap).toBe('words');
    expect(projection.contentHeight).toBeGreaterThan(projection.viewport.height);
  });
  test('colliding floats and enlarged desktop geometry reflow in reading order', () => {
    const value = document();
    const navigation = value.layouts[2]!.nodes.find((node) => node.id === 'shell.navigation')!;
    navigation.placement = { kind: 'float', fallback: 'flow', x: 0, y: 0, width: 100, height: 30 };
    navigation.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
    const projection = resolveThemeFrameworkLayout(value, [], host());
    expect(projection.nodes.find((node) => node.id === 'shell.navigation')!.reflowed).toBe(true);
    const enlarged = resolveThemeFrameworkLayout(value, [], host(1900, 1500, 1.5));
    expect(enlarged.nodes.find((node) => node.id === 'shell.navigation')!.placement).toBe('flow');
  });
  test('a theme cannot condition, clip or cycle an essential group ancestor', () => {
    for (const change of ['hidden', 'clip', 'cycle'])
      reject(
        (value) => {
          value.conditions = [{ id: 'hidden', all: [{ setting: 'enabled', equals: true }] }];
          const layout = value.layouts[2]!;
          const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
          navigation.slot = 'shell.primary';
          navigation.parent = 'theme.parent';
          navigation.anchor = 'parent.content';
          const parent: FrameworkNode = {
            id: 'theme.parent',
            kind: 'group',
            axis: 'column',
            label: 'Group',
            slot: 'shell.primary',
            parent: null,
            anchor: 'viewport.safe',
            order: 100,
            placement: { kind: 'flow', span: 4 },
          };
          if (change === 'hidden') parent.visibleWhen = 'hidden';
          if (change === 'clip') parent.constraints = { minWidth: 44, maxWidth: 300, minHeight: 44, maxHeight: 44, scroll: 'none' };
          if (change === 'cycle') {
            parent.parent = 'theme.parent';
            parent.anchor = 'parent.content';
          }
          layout.nodes.push(parent);
        },
        change === 'cycle' ? 'dependency-cycle-or-depth' : 'essential-ancestor',
      );
  });
  test('offscreen core frames, false parent anchors and replacement escape fields are refused', () => {
    reject((value) => {
      const node = value.layouts[2]!.nodes[0]!;
      node.placement = { kind: 'float', fallback: 'flow', x: 90, y: 90, width: 50, height: 50 };
      node.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
    }, 'floating-placement');
    reject((value) => {
      value.layouts[2]!.nodes[0]!.anchor = 'parent.content';
    }, 'layout-anchor');
    expect(validateThemeFrameworkDocument({ ...document(), escapes: [] }).valid).toBe(false);
  });
  test('unreflowable measurements request host fallback rather than clipping labels', () => {
    const input = host(320, 740, 1.5);
    input.measureCore = () => ({ minWidth: 1000, height: 200 });
    const projection = resolveThemeFrameworkLayout(document(), [], input);
    expect(projection.status).toBe('host-fallback');
    expect(projection.reason).toBe('content-cannot-reflow');
    expect(projection.nodes).toEqual([]);
    expect(projection.escapes).toHaveLength(3);
    expect(() => resolveThemeFrameworkLayout(document(), [], { ...host(), measureText: () => ({ minWidth: 0, height: Number.NaN }) })).toThrow(
      'measurement',
    );
  });
});

describe('layout scroll-region and adversarial geometry invariants', () => {
  test('fixed bottom docks are outside the long scrolling flow region', () => {
    const value = document();
    const layout = value.layouts[2]!;
    layout.nodes.find((node) => node.id === 'shell.session')!.placement = { kind: 'dock', edge: 'bottom', fallback: 'flow' };
    for (let index = 0; index < 20; index++)
      layout.nodes.push({
        ...textNode(),
        id: `theme.note-${index}`,
        order: 20 + index,
        text: 'Long natural content continues through the scroll region',
      });
    const result = resolveThemeFrameworkLayout(value, [], host(1280, 700));
    expect(result.status).toBe('resolved');
    const dock = result.nodes.find((node) => node.id === 'shell.session')!;
    const region = result.regions.find((region) => region.parent === null)!;
    expect(dock.space).toBe('anchor');
    expect(region.rect.y + region.rect.height).toBeLessThanOrEqual(dock.rect.y);
    expect(region.contentHeight).toBeGreaterThan(region.rect.height);
    expect(region.revealFocus).toBe(true);
    expect(result.nodes.filter((node) => node.id.startsWith('theme.note')).every((node) => node.space === 'flow-content')).toBe(true);
  });
  test('nested resized groups keep their scroll viewport within the group frame', () => {
    const value = document();
    const layout = value.layouts[2]!;
    layout.nodes.push({
      id: 'theme.group',
      kind: 'group',
      axis: 'column',
      label: 'Group heading',
      slot: 'shell.primary',
      parent: null,
      anchor: 'viewport.safe',
      order: 20,
      placement: { kind: 'flow', span: 4 },
      constraints: { minWidth: 44, maxWidth: 400, minHeight: 44, maxHeight: 200, scroll: 'content' },
    });
    for (let index = 0; index < 10; index++)
      layout.nodes.push({
        ...textNode(),
        id: `theme.child-${index}`,
        parent: 'theme.group',
        anchor: 'parent.content',
        order: index,
        text: 'Readable child content remains available through scrolling',
      });
    const result = resolveThemeFrameworkLayout(value, [], host());
    expect(result.status).toBe('resolved');
    const group = result.nodes.find((node) => node.id === 'theme.group')!;
    const region = result.regions.find((region) => region.parent === 'theme.group')!;
    expect(group.rect.height).toBe(200);
    expect(region.rect.y + region.rect.height).toBeLessThanOrEqual(group.rect.height);
    expect(region.contentHeight).toBeGreaterThan(region.rect.height);
    expect(region.rect.width).toBeLessThanOrEqual(group.rect.width);
  });
  test('phone/desktop sizes, safe insets and text scales keep escapes separate and frames bounded', () => {
    for (const width of [320, 390, 768, 1100, 1600])
      for (const scale of [1, 1.25, 1.5, 2]) {
        const input = { ...host(width, 960, scale), safeInsets: { top: 12, right: 8, bottom: 16, left: 8 } };
        const value = document();
        for (const layout of value.layouts) {
          const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
          navigation.placement = { kind: 'dock', edge: 'left', fallback: 'flow' };
        }
        const result = resolveThemeFrameworkLayout(value, [], input);
        expect(result.status).toBe('resolved');
        expect(result.escapes).toHaveLength(3);
        for (const item of result.escapes) {
          expect(item.rect.x).toBeGreaterThanOrEqual(8);
          expect(item.rect.y).toBeGreaterThanOrEqual(result.viewport.y + result.viewport.height);
          expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(width - 8);
          expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(960 - 16);
        }
        for (const node of result.nodes) {
          expect(node.rect.x).toBeGreaterThanOrEqual(0);
          expect(node.rect.y).toBeGreaterThanOrEqual(0);
          expect(node.rect.width).toBeGreaterThan(0);
          expect(node.rect.height).toBeGreaterThan(0);
          expect(node.rect.width).toBeLessThanOrEqual(result.viewport.width);
        }
      }
  });
  test('theme content receives resolved typography while escape controls retain host typography', () => {
    const value = document();
    value.tokens.typography.baseSize = 24;
    const input = host();
    const seen: Array<{ kind: 'text' | 'core'; scale: number; family: string }> = [];
    const originalText = input.measureText;
    const originalCore = input.measureCore;
    input.measureText = (text, width, scale, family) => {
      seen.push({ kind: 'text', scale, family });
      return originalText(text, width, scale, family);
    };
    input.measureCore = (component, width, scale, family) => {
      seen.push({ kind: 'core', scale, family });
      return originalCore(component, width, scale, family);
    };
    expect(resolveThemeFrameworkLayout(value, [], input).status).toBe('resolved');
    expect(seen.filter((item) => item.kind === 'text').every((item) => item.scale === 1 && item.family === 'system')).toBe(true);
    expect(seen.filter((item) => item.kind === 'core').every((item) => item.scale === 1.5 && item.family === 'system')).toBe(true);
  });
});

describe('core placement matrix and strict host boundary', () => {
  test('all supported core placement kinds preserve fixed/scroll separation across responsive profiles', () => {
    for (const placement of [
      { kind: 'flow', span: 1 },
      { kind: 'dock', edge: 'bottom', fallback: 'flow' },
      { kind: 'dock', edge: 'left', fallback: 'flow' },
      { kind: 'float', fallback: 'flow', x: 60, y: 80, width: 30, height: 10 },
    ] as const) {
      for (const input of [host(320, 740, 1.5), host(768, 900), host(1280, 1200)]) {
        const value = document();
        for (const layout of value.layouts) {
          const node = layout.nodes.find((node) => node.id === 'shell.navigation')!;
          node.placement = placement;
          node.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
        }
        const result = resolveThemeFrameworkLayout(value, [], input);
        expect(result.status).toBe('resolved');
        const region = result.regions.find((region) => region.parent === null)!;
        expect(region.rect.width).toBeGreaterThanOrEqual(44);
        expect(region.rect.height).toBeGreaterThanOrEqual(44);
        for (const node of result.nodes.filter((node) => node.parent === null)) {
          expect(node.rect.width).toBeLessThanOrEqual(result.viewport.width);
          expect(node.rect.x).toBeGreaterThanOrEqual(0);
          if (node.space === 'anchor') {
            expect(node.rect.y + node.rect.height).toBeLessThanOrEqual(result.viewport.height);
            expect(node.rect.x + node.rect.width).toBeLessThanOrEqual(result.viewport.width);
          } else expect(node.rect.x + node.rect.width).toBeLessThanOrEqual(region.rect.width);
        }
      }
    }
  });
  test('invalid host insets, missing metrics and under-sized safe areas cannot become a themed projection', () => {
    expect(() => resolveThemeFrameworkLayout(document(), [], { ...host(), safeInsets: {} as FrameworkProjectionHost['safeInsets'] })).toThrow(
      'viewport',
    );
    expect(() => resolveThemeFrameworkLayout(document(), [], { ...host(), safeInsets: { top: Number.NaN, right: 0, bottom: 0, left: 0 } })).toThrow(
      'viewport',
    );
    expect(resolveThemeFrameworkLayout(document(), [], host(160, 160, 2)).status).toBe('host-fallback');
  });
  test('excessive parent depth is refused before geometry or host measurement', () => {
    reject((value) => {
      const layout = value.layouts[2]!;
      let parent: string | null = null;
      for (let index = 0; index < 10; index++) {
        const id = `theme.group-${index}`;
        layout.nodes.push({
          id,
          kind: 'group',
          axis: 'column',
          label: 'Group',
          slot: 'shell.primary',
          parent,
          anchor: parent ? 'parent.content' : 'viewport.safe',
          order: index + 20,
          placement: { kind: 'flow', span: 1 },
        });
        parent = id;
      }
      layout.nodes.push({ ...textNode(), parent, anchor: 'parent.content' });
    }, 'dependency-cycle-or-depth');
  });
});

describe('layout fallback reading order', () => {
  test('a responsive float fallback occupies its declared position rather than the end', () => {
    const value = document();
    for (const layout of value.layouts) {
      const navigation = layout.nodes.find((node) => node.id === 'shell.navigation')!;
      navigation.placement = { kind: 'float', fallback: 'flow', x: 0, y: 0, width: 100, height: 30 };
      navigation.constraints = { minWidth: 44, maxWidth: 800, minHeight: 44, maxHeight: 400, scroll: 'content' };
    }
    for (const input of [host(320, 740, 1.5), host()]) {
      const result = resolveThemeFrameworkLayout(value, [], input);
      expect(result.status).toBe('resolved');
      const navigation = result.nodes.find((node) => node.id === 'shell.navigation')!;
      const account = result.nodes.find((node) => node.id === 'shell.session')!;
      expect(navigation.placement).toBe('flow');
      expect(navigation.order).toBeLessThan(account.order);
      expect(navigation.rect.y).toBeLessThan(account.rect.y);
    }
  });
});
