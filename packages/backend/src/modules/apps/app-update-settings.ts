import { createHash } from 'node:crypto';
import { type } from 'arktype';
import type { AppInfo } from '@runtipi/common/schemas';
import type { appFormSchema } from '../app-lifecycle/dto/app-lifecycle.dto';
import { getAppConfigUpdate } from '../app-lifecycle/services/app-config';

/** The saved request and normalized target settings travel with the update's existing receipt. */
export const appUpdateSettingsSchema = type({
  sourceSha256: '/^[a-f0-9]{64}$/',
  values: type({
    exposed: 'boolean',
    exposedLocal: 'boolean',
    openPort: 'boolean',
    'port?': 'number',
    domain: 'string | null',
    localSubdomain: 'string | null',
    config: { '[string]': 'unknown' },
    isVisibleOnGuestDashboard: 'boolean',
    enableAuth: 'boolean',
    maxBackups: 'number | null',
  }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type AppUpdateSettings = typeof appUpdateSettingsSchema.infer;

export function appUpdateInputHash(value: unknown) {
  const bytes = JSON.stringify(value, (_key, child) =>
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : child,
  );
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('App update settings could not be verified.');
  return createHash('sha256').update(bytes).digest('hex');
}

export function appUpdateSettings(info: AppInfo, original: unknown, validated: typeof appFormSchema.infer): AppUpdateSettings {
  const result = appUpdateSettingsSchema.assert({
    sourceSha256: appUpdateInputHash(original),
    values: JSON.parse(JSON.stringify(getAppConfigUpdate(info, validated))),
  });
  appUpdateInputHash(result);
  return structuredClone(result);
}

export function matchesAppUpdateSettings(row: object, settings: AppUpdateSettings, committed: boolean) {
  const parsed = appUpdateSettingsSchema.assert(settings);
  return committed
    ? Object.entries(parsed.values).every(([key, value]) => appUpdateInputHash(Reflect.get(row, key)) === appUpdateInputHash(value))
    : appUpdateInputHash(Reflect.get(row, 'config')) === parsed.sourceSha256;
}
