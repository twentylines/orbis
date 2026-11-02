import { type } from 'arktype';
import {
  frameworkActionIds,
  frameworkComponentIds,
  frameworkSlotIds,
  frameworkSoundEventIds,
  frameworkTokenIds,
  frameworkModes,
  frameworkIconRoles,
} from './theme-framework-registry.js';

export const frameworkIdSchema = type('string <= 64').and(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: plain labels must exclude control and bidi formatting characters in the generated schema.
const label = type('0 < string <= 160').and(/^[^<>\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/);
const colour = type('string').and(/^#[a-fA-F0-9]{6}$/);
const integer = type('-1000000 <= number.integer <= 1000000');
const version = type('string <= 32').and(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const release = type('string <= 80').and(/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-(beta|rc)\.(0|[1-9]\d{0,8}))?$/);
const boundedIds = frameworkIdSchema.array().atMostLength(96);
export const frameworkValueSchema = type('boolean | null')
  .or(integer)
  .or(type('string <= 64').and(/^[a-zA-Z0-9#.-]+$/));
const assetBase = {
  id: frameworkIdSchema,
  path: type('string <= 180').and(/^assets\/(?:[a-z0-9_-]+\/){0,3}[a-z0-9][a-z0-9._-]*\.(?:png|jpg|jpeg|webp|woff2|mp3|ogg|wav)$/),
  sha256: type('string').and(/^[a-f0-9]{64}$/),
  bytes: type('1 <= number.integer <= 8388608'),
};
const raster = type({
  ...assetBase,
  kind: type.enumerated('image', 'icon'),
  mime: type.enumerated('image/png', 'image/jpeg', 'image/webp'),
  width: '1 <= number.integer <= 8192',
  height: '1 <= number.integer <= 8192',
}).onUndeclaredKey('reject');
const font = type({ ...assetBase, kind: "'font'", mime: "'font/woff2'" }).onUndeclaredKey('reject');
const audio = type({
  ...assetBase,
  kind: "'audio'",
  mime: type.enumerated('audio/mpeg', 'audio/ogg', 'audio/wav'),
  durationMs: '1 <= number.integer <= 30000',
}).onUndeclaredKey('reject');
export const frameworkAssetSchema = raster.or(font).or(audio);
const settingBase = { key: frameworkIdSchema, label, group: frameworkIdSchema, 'visibleWhen?': frameworkIdSchema };
const booleanSetting = type({ ...settingBase, kind: "'boolean'", default: 'boolean' }).onUndeclaredKey('reject');
const integerSetting = type({
  ...settingBase,
  kind: "'integer'",
  default: integer.or('null'),
  min: integer,
  max: integer,
  step: '1 <= number.integer <= 1000000',
}).onUndeclaredKey('reject');
const enumSetting = type({
  ...settingBase,
  kind: "'enum'",
  default: frameworkIdSchema,
  options: type({ value: frameworkIdSchema, label }).onUndeclaredKey('reject').array().atLeastLength(1).atMostLength(24),
}).onUndeclaredKey('reject');
const colourSetting = type({ ...settingBase, kind: "'colour'", default: colour.or('null') }).onUndeclaredKey('reject');
const assetSetting = type({
  ...settingBase,
  kind: "'asset'",
  assetKind: type.enumerated('image', 'icon', 'font', 'audio'),
  default: frameworkIdSchema.or('null'),
}).onUndeclaredKey('reject');
export const frameworkSettingSchema = booleanSetting.or(integerSetting).or(enumSetting).or(colourSetting).or(assetSetting);
const condition = type({
  id: frameworkIdSchema,
  all: type({ setting: frameworkIdSchema, equals: frameworkValueSchema }).onUndeclaredKey('reject').array().atLeastLength(1).atMostLength(16),
}).onUndeclaredKey('reject');
const constraints = type({
  minWidth: '0 <= number <= 1100',
  maxWidth: '44 <= number <= 8192',
  minHeight: '0 <= number <= 640',
  maxHeight: '44 <= number <= 8192',
  scroll: type.enumerated('content', 'none'),
}).onUndeclaredKey('reject');
const placement = type({ kind: "'flow'", span: '1 <= number.integer <= 12' })
  .onUndeclaredKey('reject')
  .or(type({ kind: "'dock'", fallback: "'flow'", edge: type.enumerated('top', 'bottom', 'left', 'right') }).onUndeclaredKey('reject'))
  .or(
    type({
      kind: "'float'",
      fallback: "'flow'",
      x: '0 <= number <= 100',
      y: '0 <= number <= 100',
      width: '10 <= number <= 100',
      height: '10 <= number <= 100',
    }).onUndeclaredKey('reject'),
  )
  .or(type({ kind: "'host'" }).onUndeclaredKey('reject'));
const nodeBase = {
  id: frameworkIdSchema,
  slot: type.enumerated(...frameworkSlotIds),
  parent: frameworkIdSchema.or('null'),
  order: type('0 <= number.integer <= 256'),
  placement,
  'constraints?': constraints,
  'visibleWhen?': frameworkIdSchema,
  anchor: type.enumerated('viewport.safe', 'parent.content'),
};
export const frameworkNodeSchema = type({ ...nodeBase, kind: "'core'", component: type.enumerated(...frameworkComponentIds) })
  .onUndeclaredKey('reject')
  .or(type({ ...nodeBase, kind: "'group'", label, axis: type.enumerated('row', 'column') }).onUndeclaredKey('reject'))
  .or(type({ ...nodeBase, kind: "'text'", text: label }).onUndeclaredKey('reject'))
  .or(type({ ...nodeBase, kind: "'image'", asset: frameworkIdSchema, alt: label }).onUndeclaredKey('reject'))
  .or(type({ ...nodeBase, kind: "'action'", label, action: type.enumerated(...frameworkActionIds) }).onUndeclaredKey('reject'))
  .or(type({ ...nodeBase, kind: "'control'", setting: frameworkIdSchema }).onUndeclaredKey('reject'));
const tokenValue = type('-1000000 <= number <= 1000000').or(type('string <= 64').and(/^[a-zA-Z0-9#.-]+$/));
const tokenAssignment = type({ token: type.enumerated(...frameworkTokenIds), value: tokenValue }).onUndeclaredKey('reject');
const mode = type.enumerated(...frameworkModes);
export const themeFrameworkDocumentSchema = type({
  schema: "'orbis.theme-framework.v1'",
  id: frameworkIdSchema,
  version,
  name: label,
  settingsVersion: '1 <= number.integer <= 9999',
  requires: type({ api: '1', releases: release.array().atLeastLength(1).atMostLength(32) }).onUndeclaredKey('reject'),
  supportsUiRevisions: type('1 <= number.integer <= 9007199254740991').array().atMostLength(64),
  components: type({ id: type.enumerated(...frameworkComponentIds), variant: frameworkIdSchema })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(32),
  tokens: type({
    colours: type({ background: colour, surface: colour, ink: colour, muted: colour, accent: colour, danger: colour, focus: colour }).onUndeclaredKey(
      'reject',
    ),
    typography: type({ family: frameworkIdSchema, baseSize: '14 <= number <= 24', scale: '0.85 <= number <= 1.5' }).onUndeclaredKey('reject'),
    spacing: type({ unit: '2 <= number <= 12', gap: '0 <= number <= 48', inset: '0 <= number <= 20' }).onUndeclaredKey('reject'),
    shape: type({ radius: '0 <= number <= 32', borderWidth: '0 <= number <= 3' }).onUndeclaredKey('reject'),
    motion: type({ duration: '0 <= number <= 600', curve: type.enumerated('linear', 'standard', 'decelerate') }).onUndeclaredKey('reject'),
  }).onUndeclaredKey('reject'),
  modes: type({ mode, values: tokenAssignment.array().atMostLength(17) })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(3),
  tokenRules: type({ mode: mode.or("'all'"), when: frameworkIdSchema, values: tokenAssignment.array().atMostLength(17) })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(64),
  tokenBindings: type({
    token: type.enumerated(...frameworkTokenIds),
    setting: frameworkIdSchema,
    transform: type.enumerated('identity', 'percent'),
    'when?': frameworkIdSchema,
  })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(64),
  icons: type({
    role: type.enumerated(...frameworkIconRoles),
    mode: mode.or("'all'"),
    asset: frameworkIdSchema.or('null'),
    'setting?': frameworkIdSchema,
    'when?': frameworkIdSchema,
  })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(96),
  assets: frameworkAssetSchema.array().atMostLength(128),
  settings: frameworkSettingSchema.array().atMostLength(96),
  conditions: condition.array().atMostLength(96),
  customisation: type({
    hostControls: "'always'",
    sections: type({ id: frameworkIdSchema, label, settings: boundedIds, 'visibleWhen?': frameworkIdSchema })
      .onUndeclaredKey('reject')
      .array()
      .atMostLength(24),
    presets: type({
      id: frameworkIdSchema,
      label,
      values: type({ key: frameworkIdSchema, value: frameworkValueSchema }).onUndeclaredKey('reject').array().atMostLength(96),
    })
      .onUndeclaredKey('reject')
      .array()
      .atMostLength(24),
  }).onUndeclaredKey('reject'),
  layouts: type({
    viewport: type.enumerated('phone', 'tablet', 'desktop'),
    columns: '1 <= number.integer <= 12',
    nodes: frameworkNodeSchema.array().atMostLength(128),
  })
    .onUndeclaredKey('reject')
    .array()
    .atLeastLength(3)
    .atMostLength(3),
  sounds: type({ event: type.enumerated(...frameworkSoundEventIds), asset: frameworkIdSchema.or('null'), gain: '0 <= number <= 1' })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(14),
}).onUndeclaredKey('reject');
export type ThemeFrameworkDocument = typeof themeFrameworkDocumentSchema.infer;
export type FrameworkSetting = typeof frameworkSettingSchema.infer;
export type FrameworkNode = typeof frameworkNodeSchema.infer;
export type FrameworkAsset = typeof frameworkAssetSchema.infer;
export function themeFrameworkJsonSchema(): Record<string, unknown> {
  return {
    ...themeFrameworkDocumentSchema.toJsonSchema(),
    $id: 'urn:orbis:theme-framework:v1',
    $comment:
      'Structural constraints only. validateThemeFrameworkDocument additionally enforces references, resources and layout safety. This schema does not enable runtime support.',
  };
}
