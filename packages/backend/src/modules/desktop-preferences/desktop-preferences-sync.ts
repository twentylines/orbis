import { type } from 'arktype';
import { desktopAppearanceSchema, normaliseDesktopAppearance, defaultDesktopAppearance } from '@runtipi/common/schemas';
import type { DesktopPreferences } from './desktop-preferences.service';

export const customisationAppearanceKeys = [
  'accent',
  'surfaceOpacity',
  'chromeOpacity',
  'glassBlur',
  'chromeBlur',
  'glassTint',
  'textScale',
  'timeFormat',
  'motion',
  'transparency',
  'lowEffects',
  'dockPlacement',
  'dockSize',
  'dockAutoHide',
] as const;
export class UnsupportedDesktopPreferencesError extends Error {
  constructor() {
    super('Local customisation uses unsupported settings. Review or update this host before syncing it.');
  }
}
type Entry = { start: number; end: number };
type ObjectRanges = { entries: Map<string, Entry>; close: number };
const whitespace = (character: string | undefined) => character !== undefined && /\s/.test(character);

function objectRanges(text: string, start = 0): ObjectRanges {
  let index = start;
  while (whitespace(text[index])) index++;
  if (text[index++] !== '{') throw new UnsupportedDesktopPreferencesError();
  const entries = new Map<string, Entry>();
  while (index < text.length) {
    while (whitespace(text[index])) index++;
    if (text[index] === '}') return { entries, close: index };
    const keyStart = index;
    if (text[index++] !== '"') throw new UnsupportedDesktopPreferencesError();
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') break;
    }
    const key = JSON.parse(text.slice(keyStart, index)) as string;
    if (entries.has(key)) throw new UnsupportedDesktopPreferencesError();
    while (whitespace(text[index])) index++;
    if (text[index++] !== ':') throw new UnsupportedDesktopPreferencesError();
    while (whitespace(text[index])) index++;
    const valueStart = index;
    let depth = 0;
    let quoted = false;
    for (; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character === '\\') index++;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '[' || character === '{') depth++;
      else if (character === ']' || character === '}') {
        if (depth === 0) break;
        depth--;
      } else if (character === ',' && depth === 0) break;
    }
    let end = index;
    while (whitespace(text[end - 1])) end--;
    entries.set(key, { start: valueStart, end });
    if (text[index] === ',') index++;
  }
  throw new UnsupportedDesktopPreferencesError();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UnsupportedDesktopPreferencesError();
  return value as Record<string, unknown>;
}
function supportedVersion(value: Record<string, unknown>) {
  if (['version', 'schemaVersion', '$schema'].some((key) => Object.hasOwn(value, key))) throw new UnsupportedDesktopPreferencesError();
}

export function selectedPreferences(raw: string, defaults: DesktopPreferences): DesktopPreferences {
  let root: Record<string, unknown>;
  try {
    root = record(JSON.parse(raw));
    objectRanges(raw);
  } catch {
    throw new UnsupportedDesktopPreferencesError();
  }
  supportedVersion(root);
  const appearance = root.appearance === undefined ? {} : record(root.appearance);
  supportedVersion(appearance);
  const top = type({
    preset: "'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush'",
    mode: "'light' | 'dark' | 'system'",
    density: "'comfortable' | 'compact'",
  })({
    preset: Object.hasOwn(root, 'preset') ? root.preset : defaults.preset,
    mode: Object.hasOwn(root, 'mode') ? root.mode : defaults.mode,
    density: Object.hasOwn(root, 'density') ? root.density : defaults.density,
  });
  const parsedAppearance = desktopAppearanceSchema(
    Object.fromEntries(
      Object.keys(defaultDesktopAppearance)
        .filter((key) => Object.hasOwn(appearance, key))
        .map((key) => [key, appearance[key]]),
    ),
  );
  if (top instanceof type.errors || parsedAppearance instanceof type.errors) throw new UnsupportedDesktopPreferencesError();
  const appearanceRange = objectRanges(raw).entries.get('appearance');
  if (appearanceRange) objectRanges(raw, appearanceRange.start);
  return { ...defaults, ...top, appearance: normaliseDesktopAppearance(parsedAppearance) };
}

export function patchSelectedPreferences(raw: string, current: DesktopPreferences, next: DesktopPreferences): string {
  const top = objectRanges(raw);
  const appearanceRange = top.entries.get('appearance');
  const appearance = appearanceRange ? objectRanges(raw, appearanceRange.start) : undefined;
  const edits: { start: number; end: number; value: string }[] = [];
  const additions = new Map<ObjectRanges, string[]>();
  const add = (object: ObjectRanges, key: string, value: unknown) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new UnsupportedDesktopPreferencesError();
    const entry = object.entries.get(key);
    if (entry) edits.push({ ...entry, value: encoded });
    else additions.set(object, [...(additions.get(object) ?? []), `${JSON.stringify(key)}:${encoded}`]);
  };
  for (const key of ['preset', 'mode', 'density'] as const) if (next[key] !== current[key]) add(top, key, next[key]);
  const changedAppearance: Record<string, unknown> = {};
  for (const key of customisationAppearanceKeys)
    if (next.appearance?.[key] !== current.appearance?.[key]) changedAppearance[key] = next.appearance?.[key];
  if (Object.keys(changedAppearance).length) {
    if (appearance) for (const [key, value] of Object.entries(changedAppearance)) add(appearance, key, value);
    else add(top, 'appearance', changedAppearance);
  }
  for (const [object, properties] of additions)
    edits.push({ start: object.close, end: object.close, value: `${object.entries.size ? ',' : ''}${properties.join(',')}` });
  let output = raw;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  selectedPreferences(output, current);
  return output;
}
