/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  interfaceThemeDescriptorSchema,
  interfaceThemeHostAccessibilitySchema,
  interfaceThemeSettingSchema,
  interfaceThemeSettingsEntryAllows,
  interfaceThemeSettingsStateSchema,
} from '@runtipi/common/schemas/interface-theme';
import { bundledThemePacks } from '../../../../backend/src/modules/theme-packs/theme-pack-catalogue';
import { builtinInterfaceTheme, registeredInterfaceTheme } from './interface-theme-registry';
import { interfaceThemeCompatibility, resolveInterfaceTheme } from './interface-theme-resolver';
import { adaptLegacyThemeManifest, legacyThemeDescriptor } from './legacy-theme-adapter';

const accessibility = { reducedMotion: true, reducedTransparency: true, forcedColours: true, textScale: 150, mutedSounds: true };
const empty = { formatVersion: 1, entries: [] };
const entry = (id: string, values: { key: string; value: unknown }[], settingsVersion = 1) => ({ id, settingsVersion, values });
const state = (...entries: unknown[]) => ({ formatVersion: 1, entries });
const value = (resolved: ReturnType<typeof resolveInterfaceTheme>, key: string) => resolved.values.find((item) => item.key === key)?.value;
const alpine = { id: 'alpine', version: '1.1.0' };

describe('bounded interface theme contracts', () => {
  test('rejects executable fields, resource locations and unsupported top-level shapes', () => {
    for (const addition of [
      { script: 'alert(1)' },
      { css: 'body { display: none }' },
      { url: 'https://example.invalid/theme' },
      { resources: ['https://example.invalid/font.woff2'] },
      { formatVersion: 2 },
      { implementation: '../../module.js' },
      { name: '<script>' },
      { name: '\u202eHidden' },
      { capabilities: ['palette', 'palette'] },
    ]) {
      expect(interfaceThemeDescriptorSchema.allows({ ...builtinInterfaceTheme, ...addition })).toBe(false);
    }
  });

  test('rejects ambiguous settings, invalid defaults, fractional bounds and unsafe keys', () => {
    const integer = { key: 'size', label: 'Size', group: 'layout', kind: 'integer', min: 0, max: 10, step: 2, default: 4 };
    expect(interfaceThemeSettingSchema.allows(integer)).toBe(true);
    for (const addition of [{ default: 3 }, { default: 12 }, { min: 20 }, { max: 9 }, { step: 0 }, { min: 0.5 }, { key: 'constructor' }]) {
      expect(interfaceThemeSettingSchema.allows({ ...integer, ...addition })).toBe(false);
    }
    const enumeration = { key: 'style', label: 'Style', group: 'layout', kind: 'enum', options: [{ value: 'soft', label: 'Soft' }], default: 'soft' };
    expect(interfaceThemeSettingSchema.allows(enumeration)).toBe(true);
    expect(interfaceThemeSettingSchema.allows({ ...enumeration, default: 'unknown' })).toBe(false);
    expect(interfaceThemeSettingSchema.allows({ ...enumeration, options: [...enumeration.options, ...enumeration.options] })).toBe(false);
    expect(interfaceThemeDescriptorSchema.allows({ ...builtinInterfaceTheme, settings: [integer, integer] })).toBe(false);
    expect(interfaceThemeDescriptorSchema.allows({ ...builtinInterfaceTheme, settings: [{ ...integer, validate: 'custom()' }] })).toBe(false);
  });

  test('bounds definition and stored namespace sizes and rejects duplicate entries and keys', () => {
    expect(interfaceThemeDescriptorSchema.allows({ ...builtinInterfaceTheme, settingsVersion: 0 })).toBe(false);
    expect(interfaceThemeSettingsStateSchema.allows(state(...Array.from({ length: 25 }, (_, index) => entry(`theme-${index}`, []))))).toBe(false);
    expect(interfaceThemeSettingsStateSchema.allows(state(entry('alpine', []), entry('alpine', [])))).toBe(false);
    expect(
      interfaceThemeSettingsStateSchema.allows(
        state(
          entry('alpine', [
            { key: 'accent', value: '#123456' },
            { key: 'accent', value: null },
          ]),
        ),
      ),
    ).toBe(false);
    expect(interfaceThemeSettingsStateSchema.allows(state(entry('alpine', [{ key: '__proto__', value: null }])))).toBe(false);
    expect(interfaceThemeSettingsStateSchema.allows(state(entry('alpine', [{ key: 'accent', value: 'url(https://example.invalid)' }])))).toBe(false);
    const definitions = Array.from({ length: 49 }, (_, index) => ({
      key: `key-${index}`,
      label: 'Choice',
      group: 'layout',
      kind: 'boolean',
      default: false,
    }));
    expect(interfaceThemeDescriptorSchema.allows({ ...builtinInterfaceTheme, settings: definitions })).toBe(false);
    expect(
      interfaceThemeSettingsStateSchema.allows(
        state(
          entry(
            'alpine',
            definitions.map((definition) => ({ key: definition.key, value: false })),
          ),
        ),
      ),
    ).toBe(false);
  });

  test('validates writes against the exact descriptor namespace and value type', () => {
    expect(interfaceThemeSettingsEntryAllows(builtinInterfaceTheme, entry('orbis-builtin', [{ key: 'panel-blur', value: 12 }]))).toBe(true);
    for (const candidate of [
      entry('alpine', [{ key: 'panel-blur', value: 12 }]),
      entry('orbis-builtin', [{ key: 'panel-blur', value: 12 }], 2),
      entry('orbis-builtin', [{ key: 'panel-blur', value: 41 }]),
      entry('orbis-builtin', [{ key: 'panel-blur', value: '12' }]),
      entry('orbis-builtin', [{ key: 'motion', value: 'full' }]),
      entry('orbis-builtin', [{ key: 'low-effects', value: 'true' }]),
      entry('orbis-builtin', [{ key: 'arbitrary-css', value: null }]),
    ]) {
      expect(interfaceThemeSettingsEntryAllows(builtinInterfaceTheme, candidate)).toBe(false);
    }
  });
});

describe('trusted adapters and pure theme resolution', () => {
  test('adapts all six existing catalogue versions without mutating any manifest or creating interface claims', () => {
    expect(bundledThemePacks).toHaveLength(6);
    for (const pack of bundledThemePacks) {
      const original = JSON.stringify(pack);
      const descriptor = adaptLegacyThemeManifest(pack);
      expect(descriptor?.kind).toBe('legacy-pack');
      expect(descriptor?.id).toBe(pack.id);
      expect(descriptor?.version).toBe(pack.version);
      expect(descriptor?.capabilities).not.toContain('shell');
      expect(descriptor?.settings.some((setting) => setting.key === 'palette')).toBe(false);
      expect(interfaceThemeDescriptorSchema.allows(descriptor)).toBe(true);
      expect(JSON.stringify(pack)).toBe(original);
    }
  });

  test('denies unregistered identities and package versions instead of interpreting an implementation or URL', () => {
    const pack = bundledThemePacks[0];
    expect(pack).toBeDefined();
    expect(adaptLegacyThemeManifest({ ...pack, id: 'unknown' })).toBeNull();
    expect(adaptLegacyThemeManifest({ ...pack, script: 'run()' })).toBeNull();
    expect(legacyThemeDescriptor('alpine', '99.0.0')).toBeNull();
    expect(registeredInterfaceTheme({ id: 'orbis-builtin', version: '1.0.0', implementation: 'unsafe' })).toBeNull();
    expect(resolveInterfaceTheme({ id: 'unknown', version: '1.0.0' }, empty, accessibility).fallback).toBe('unavailable');
    expect(resolveInterfaceTheme({ ...alpine, url: 'https://example.invalid' }, empty, accessibility).fallback).toBe('invalid-identity');
    expect(resolveInterfaceTheme({ id: 'alpine', version: '99.0.0' }, empty, accessibility).descriptor.id).toBe('orbis-builtin');
  });

  test('keeps theme settings isolated while compatible package versions share their namespace', () => {
    const settings = state(
      entry('orbis-builtin', [{ key: 'accent', value: '#112233' }]),
      entry('alpine', [{ key: 'accent', value: '#445566' }]),
      entry('tideline', [{ key: 'panel-blur', value: 20 }]),
    );
    expect(value(resolveInterfaceTheme(alpine, settings, accessibility), 'accent')).toBe('#445566');
    expect(value(resolveInterfaceTheme({ ...alpine, version: '1.0.0' }, settings, accessibility), 'accent')).toBe('#445566');
    expect(value(resolveInterfaceTheme({ id: 'tideline', version: '1.1.0' }, settings, accessibility), 'accent')).toBeNull();
    expect(value(resolveInterfaceTheme(null, settings, accessibility), 'accent')).toBe('#112233');
    const old = resolveInterfaceTheme({ ...alpine, version: '1.0.0' }, settings, accessibility);
    const current = resolveInterfaceTheme(alpine, settings, accessibility);
    expect(old.settingsNamespace).toEqual(current.settingsNamespace);
    expect(old.identity).not.toEqual(current.identity);
  });

  test('retains incompatible namespace input unchanged and uses defaults until a supported version is available', () => {
    const settings = state(entry('alpine', [{ key: 'accent', value: '#445566' }], 2));
    const original = JSON.stringify(settings);
    expect(value(resolveInterfaceTheme(alpine, settings, accessibility), 'accent')).toBeNull();
    expect(JSON.stringify(settings)).toBe(original);
    expect(resolveInterfaceTheme(alpine, settings, accessibility).rejectedSettings).toBe(false);
  });

  test('rejects an invalid active namespace as a whole, preserving valid defaults and other themes', () => {
    const settings = state(
      entry('alpine', [
        { key: 'accent', value: '#445566' },
        { key: 'panel-blur', value: 900 },
      ]),
    );
    const result = resolveInterfaceTheme(alpine, settings, accessibility);
    expect(result.rejectedSettings).toBe(true);
    expect(value(result, 'accent')).toBeNull();
    expect(value(result, 'panel-blur')).toBeNull();
    expect(resolveInterfaceTheme(alpine, { formatVersion: 2, entries: [] }, accessibility).rejectedSettings).toBe(true);
  });

  test('host accessibility has a separate validated output channel that theme values cannot override', () => {
    const settings = state(
      entry('alpine', [
        { key: 'motion', value: 'system' },
        { key: 'transparency', value: 'glass' },
      ]),
    );
    const resolved = resolveInterfaceTheme(alpine, settings, accessibility);
    expect(value(resolved, 'transparency')).toBe('glass');
    expect(resolved.accessibility).toEqual(accessibility);
    expect(resolved.accessibility).not.toBe(accessibility);
    expect(interfaceThemeHostAccessibilitySchema.allows({ ...accessibility, textScale: 99 })).toBe(false);
    expect(resolveInterfaceTheme(alpine, empty, { ...accessibility, script: 'run()' }).accessibility).toEqual({
      reducedMotion: true,
      reducedTransparency: true,
      forcedColours: true,
      textScale: 100,
      mutedSounds: true,
    });
    expect(interfaceThemeSettingsEntryAllows(resolved.descriptor, entry('alpine', [{ key: 'reduced-motion', value: false }]))).toBe(false);
  });

  test('rejects future interface capabilities and implementations until reviewed host support exists', () => {
    expect(interfaceThemeCompatibility({ ...builtinInterfaceTheme, hostApiVersion: 2 })).toBe('host-api');
    expect(interfaceThemeCompatibility({ ...builtinInterfaceTheme, capabilities: ['shell', 'sounds'] })).toBe('capability');
    expect(interfaceThemeCompatibility({ ...builtinInterfaceTheme, implementation: 'unreviewed' })).toBe('implementation');
    expect(interfaceThemeCompatibility({ ...builtinInterfaceTheme, kind: 'interface' })).toBe('implementation');
    expect(interfaceThemeCompatibility({ ...builtinInterfaceTheme, code: 'unsafe' })).toBe('invalid-descriptor');
    expect(interfaceThemeCompatibility(builtinInterfaceTheme)).toBeNull();
  });

  test('registry definitions cannot be modified through a resolved descriptor', () => {
    const theme = registeredInterfaceTheme(alpine);
    expect(theme).not.toBeNull();
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme?.settings)).toBe(true);
    expect(Object.isFrozen(theme?.settings[0])).toBe(true);
    expect(Object.isFrozen(builtinInterfaceTheme.settings[0]?.kind === 'enum' ? builtinInterfaceTheme.settings[0].options : null)).toBe(true);
  });
});
