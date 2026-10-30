import { type } from 'arktype';
import { themePackVersionSchema } from './theme-pack.js';

const identifier = type('string').narrow(
  (value) => /^[a-z][a-z0-9-]{0,47}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value),
);
const label = type('string > 0 & string <= 160').narrow(
  (value) =>
    value.trim().length > 0 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) &&
    !/[<>\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value),
);
const colour = type('string').narrow((value) => /^#[a-f0-9]{6}$/i.test(value));
const integer = type('-1000000 <= number.integer <= 1000000');
const settingsVersion = type('1 <= number.integer <= 9999');
const settingBase = { key: identifier, label, group: identifier, 'help?': label };
const booleanSetting = type({ ...settingBase, kind: "'boolean'", default: 'boolean' }).onUndeclaredKey('reject');
const colourSetting = type({ ...settingBase, kind: "'colour'", default: colour.or('null') }).onUndeclaredKey('reject');
const enumSetting = type({
  ...settingBase,
  kind: "'enum'",
  default: identifier,
  options: type({ value: identifier, label })
    .onUndeclaredKey('reject')
    .array()
    .narrow((options) => options.length >= 1 && options.length <= 24 && new Set(options.map((option) => option.value)).size === options.length),
})
  .onUndeclaredKey('reject')
  .narrow((setting) => setting.options.some((option) => option.value === setting.default));
const integerSetting = type({
  ...settingBase,
  kind: "'integer'",
  default: integer.or('null'),
  min: integer,
  max: integer,
  step: '1 <= number.integer <= 1000000',
})
  .onUndeclaredKey('reject')
  .narrow(
    (setting) =>
      setting.min <= setting.max &&
      (setting.max - setting.min) % setting.step === 0 &&
      (setting.default === null ||
        (setting.default >= setting.min && setting.default <= setting.max && (setting.default - setting.min) % setting.step === 0)),
  );

export const interfaceThemeSettingSchema = booleanSetting.or(colourSetting).or(enumSetting).or(integerSetting);
export type InterfaceThemeSetting = typeof interfaceThemeSettingSchema.infer;
export const interfaceThemeCapabilitySchema = type.enumerated(
  'palette',
  'material',
  'wallpaper',
  'typography',
  'icon-treatment',
  'control-treatment',
  'chart-treatment',
  'menu-treatment',
  'motion-treatment',
  'shell',
  'navigation',
  'windows',
  'components',
  'layouts',
  'fonts',
  'icons',
  'animations',
  'sounds',
);
export type InterfaceThemeCapability = typeof interfaceThemeCapabilitySchema.infer;
export const interfaceThemeIdentitySchema = type({ id: identifier, version: themePackVersionSchema }).onUndeclaredKey('reject');
export type InterfaceThemeIdentity = typeof interfaceThemeIdentitySchema.infer;
export const interfaceThemeDescriptorSchema = type({
  formatVersion: '1',
  id: identifier,
  version: themePackVersionSchema,
  hostApiVersion: '1 <= number.integer <= 9999',
  settingsVersion,
  name: label,
  kind: type.enumerated('builtin', 'legacy-pack', 'interface'),
  implementation: identifier,
  capabilities: interfaceThemeCapabilitySchema.array().narrow((items) => items.length <= 18 && new Set(items).size === items.length),
  settings: interfaceThemeSettingSchema
    .array()
    .narrow((items) => items.length <= 48 && new Set(items.map((setting) => setting.key)).size === items.length),
}).onUndeclaredKey('reject');
export type InterfaceThemeDescriptor = typeof interfaceThemeDescriptorSchema.infer;
export const interfaceThemeValueSchema = type('boolean | null').or(integer).or(colour).or(identifier);
export type InterfaceThemeValue = typeof interfaceThemeValueSchema.infer;
export const interfaceThemeSettingsValuesSchema = type({ key: identifier, value: interfaceThemeValueSchema })
  .onUndeclaredKey('reject')
  .array()
  .narrow((items) => items.length <= 48 && new Set(items.map((item) => item.key)).size === items.length);
export const interfaceThemeSettingsEntrySchema = type({
  id: identifier,
  settingsVersion,
  values: interfaceThemeSettingsValuesSchema,
}).onUndeclaredKey('reject');
export type InterfaceThemeSettingsEntry = typeof interfaceThemeSettingsEntrySchema.infer;
export const interfaceThemeSettingsStateSchema = type({
  formatVersion: '1',
  entries: interfaceThemeSettingsEntrySchema
    .array()
    .narrow((items) => items.length <= 24 && new Set(items.map((entry) => `${entry.id}:${entry.settingsVersion}`)).size === items.length),
}).onUndeclaredKey('reject');
export type InterfaceThemeSettingsState = typeof interfaceThemeSettingsStateSchema.infer;

export function interfaceThemeSettingAllows(setting: InterfaceThemeSetting, value: unknown): value is InterfaceThemeValue {
  switch (setting.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'colour':
      return value === null || colour.allows(value);
    case 'enum':
      return setting.options.some((option) => option.value === value);
    case 'integer':
      return (
        value === null ||
        (typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= setting.min &&
          value <= setting.max &&
          (value - setting.min) % setting.step === 0)
      );
  }
}

export function interfaceThemeSettingsEntryAllows(descriptor: InterfaceThemeDescriptor, value: unknown): value is InterfaceThemeSettingsEntry {
  if (!interfaceThemeDescriptorSchema.allows(descriptor) || !interfaceThemeSettingsEntrySchema.allows(value)) return false;
  return (
    value.id === descriptor.id &&
    value.settingsVersion === descriptor.settingsVersion &&
    value.values.every((item) => {
      const setting = descriptor.settings.find((definition) => definition.key === item.key);
      return Boolean(setting && interfaceThemeSettingAllows(setting, item.value));
    })
  );
}

// The host must apply this separate channel after theme values; packages cannot supply it.
export const interfaceThemeHostAccessibilitySchema = type({
  reducedMotion: 'boolean',
  reducedTransparency: 'boolean',
  forcedColours: 'boolean',
  textScale: '100 <= number.integer <= 150',
  mutedSounds: 'boolean',
}).onUndeclaredKey('reject');
export type InterfaceThemeHostAccessibility = typeof interfaceThemeHostAccessibilitySchema.infer;
