import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { type } from 'arktype';
import { desktopAppearanceSchema } from '@runtipi/common/schemas';
import type { DesktopPreferences } from '../desktop-preferences/desktop-preferences.service';
import { customisationAppearanceKeys } from '../desktop-preferences/desktop-preferences-sync';

export const syncCategories = ['customisation', 'orbis-updates', 'app-updates', 'schedules'] as const;
export type SyncCategory = (typeof syncCategories)[number];
export const syncCategorySchema = type.enumerated(...syncCategories);
export const syncCategoryList = syncCategorySchema
  .array()
  .atMostLength(4)
  .narrow((items) => new Set(items).size === items.length);
export const syncId = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
export const syncRevision = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const time = type('string').narrow((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
const urn = type('string <= 180').narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value) && !value.endsWith(':_user'));
export const syncAppearanceKeys = customisationAppearanceKeys;
export const customisationSchema = type({
  '+': 'reject',
  preset: "'frost' | 'graphite' | 'forest' | 'stone' | 'ocean' | 'blush'",
  mode: "'light' | 'dark' | 'system'",
  density: "'comfortable' | 'compact'",
  appearance: desktopAppearanceSchema.narrow((value) => Object.keys(value).every((key) => (syncAppearanceKeys as readonly string[]).includes(key))),
});
const orbis = type({ '+': 'reject', enabled: 'boolean', mode: "'idle' | 'scheduled'" });
const apps = type({ '+': 'reject', urn, enabled: 'boolean' })
  .array()
  .atMostLength(256)
  .narrow((items) => new Set(items.map((item) => item.urn)).size === items.length);
const schedules = type({
  '+': 'reject',
  time,
  apps: type({ '+': 'reject', urn, mode: "'global' | 'custom'", 'time?': time })
    .narrow((item) => (item.mode === 'custom' ? item.time !== undefined : item.time === undefined))
    .array()
    .atMostLength(256)
    .narrow((items) => new Set(items.map((item) => item.urn)).size === items.length),
});
export const syncValueSchemas = { customisation: customisationSchema, 'orbis-updates': orbis, 'app-updates': apps, schedules };
export type SyncValues = { [Category in SyncCategory]: (typeof syncValueSchemas)[Category]['infer'] };
const envelope = { '+': 'reject', expectedRevision: syncRevision, sourceRevision: syncRevision } as const;
export const syncChangeSchema = type({ ...envelope, category: "'customisation'", value: customisationSchema })
  .or({ ...envelope, category: "'orbis-updates'", value: orbis })
  .or({ ...envelope, category: "'app-updates'", value: apps })
  .or({ ...envelope, category: "'schedules'", value: schedules });
export type SyncChange = typeof syncChangeSchema.infer;
export const syncPeerSchema = type({ '+': 'reject', version: '1', action: "'status'", sourceId: syncId, targetId: syncId }).or({
  '+': 'reject',
  version: '1',
  action: "'apply'",
  sourceId: syncId,
  targetId: syncId,
  changes: syncChangeSchema
    .array()
    .atLeastLength(1)
    .atMostLength(4)
    .narrow((items) => new Set(items.map((item) => item.category)).size === items.length),
});
export const syncRevisionsSchema = type({
  '+': 'reject',
  'customisation?': syncRevision,
  'orbis-updates?': syncRevision,
  'app-updates?': syncRevision,
  'schedules?': syncRevision,
});
export function parseSync<T>(schema: (value: unknown) => T | type.errors, raw: unknown): T {
  const value = schema(raw);
  if (value instanceof type.errors) throw new BadRequestException('Choose supported settings, exact paired hosts and current sync revisions.');
  return value;
}
export function syncHash(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : input;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function projectCustomisation(value: DesktopPreferences): SyncValues['customisation'] {
  return parseSync(customisationSchema, {
    preset: value.preset,
    mode: value.mode ?? 'light',
    density: value.density,
    appearance: Object.fromEntries(
      syncAppearanceKeys.filter((key) => value.appearance?.[key] !== undefined).map((key) => [key, value.appearance?.[key]]),
    ),
  });
}
