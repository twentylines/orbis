import { type } from 'arktype';

const colour = type('string | null').narrow((value) => value === null || /^#[0-9a-f]{6}$/i.test(value));
const image = type('string | null').narrow((value) => value === null || /^[a-f0-9]{64}$/.test(value));
const appPins = type('string > 2 & string <= 180')
  .array()
  .narrow((items) => items.length <= 6 && new Set(items).size === items.length && items.every((item) => /^[^:]+:[^:]+$/.test(item)));

export const desktopAppearanceSchema = type({
  'accent?': colour,
  'wallpaperImage?': image,
  'wallpaperFit?': type.enumerated('cover', 'contain'),
  'wallpaperX?': '0 <= number.integer <= 100',
  'wallpaperY?': '0 <= number.integer <= 100',
  'wallpaperDim?': '0 <= number.integer <= 70',
  'wallpaperBlur?': '0 <= number.integer <= 24',
  'surfaceOpacity?': '90 <= number.integer <= 100 | null',
  'chromeOpacity?': '80 <= number.integer <= 100 | null',
  'glassBlur?': '0 <= number.integer <= 40 | null',
  'chromeBlur?': '0 <= number.integer <= 64 | null',
  'glassTint?': '0 <= number.integer <= 30 | null',
  'textScale?': '85 <= number.integer <= 150',
  'timeFormat?': type.enumerated('12h', '24h'),
  'motion?': type.enumerated('system', 'reduced'),
  'transparency?': type.enumerated('system', 'glass', 'solid'),
  'lowEffects?': 'boolean',
  'dockPlacement?': type.enumerated('bottom', 'left', 'right'),
  'dockSize?': type.enumerated('compact', 'comfortable', 'large'),
  'dockAutoHide?': 'boolean',
  'dockPins?': appPins,
}).onUndeclaredKey('reject');

export type DesktopAppearance = Required<typeof desktopAppearanceSchema.infer>;

export const defaultDesktopAppearance: DesktopAppearance = {
  accent: null,
  wallpaperImage: null,
  wallpaperFit: 'cover',
  wallpaperX: 50,
  wallpaperY: 0,
  wallpaperDim: 0,
  wallpaperBlur: 0,
  surfaceOpacity: null,
  chromeOpacity: null,
  glassBlur: null,
  chromeBlur: null,
  glassTint: null,
  textScale: 100,
  timeFormat: '12h',
  motion: 'system',
  transparency: 'system',
  lowEffects: false,
  dockPlacement: 'bottom',
  dockSize: 'comfortable',
  dockAutoHide: false,
  dockPins: [],
};

export function normaliseDesktopAppearance(value?: unknown): DesktopAppearance {
  const parsed = desktopAppearanceSchema(value ?? {});
  return parsed instanceof type.errors
    ? { ...defaultDesktopAppearance, dockPins: [] }
    : { ...defaultDesktopAppearance, ...parsed, dockPins: parsed.dockPins ?? [] };
}
