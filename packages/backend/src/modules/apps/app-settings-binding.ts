import { createHash } from 'node:crypto';
import type { App } from '@/core/database/drizzle/types';

/** Bind the SQL app row, excluding the independently refreshed catalogue relation. */
export function appSettingsBinding(value: App) {
  const { appStore: _catalogue, ...row } = value as App & { appStore?: unknown };
  const body = JSON.stringify(row, (_key, entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
  if (!body || Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Application settings could not be verified.');
  return createHash('sha256').update(body).digest('hex');
}
