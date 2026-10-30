import { themePackSnapshotSchema, type ThemePackSnapshot, type ThemePackReference } from '@runtipi/common/schemas/theme-pack';

export const themePacksChanged = 'orbis-theme-packs-changed';
export async function themePacksRequest(action = '', method = 'GET', body?: unknown, signal?: AbortSignal): Promise<ThemePackSnapshot> {
  if (action !== '' && !/^\/(?:install|selection|[a-z][a-z0-9-]{2,47}(?:\/(?:update|rollback))?)$/.test(action))
    throw new Error('Invalid theme action.');
  const response = await fetch(`/api/theme-packs${action}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Sign in again to manage themes.'
        : response.status === 400
          ? 'The theme could not be validated. Refresh and try again.'
          : 'Themes could not be loaded or saved. Check the connection and retry.',
    );
  const value: unknown = await response.json();
  if (!themePackSnapshotSchema.allows(value)) throw new Error('The server returned an unsupported theme catalogue.');
  if (method !== 'GET') window.dispatchEvent(new Event(themePacksChanged));
  return value;
}
export const selectThemePack = (selected: ThemePackReference | null, signal?: AbortSignal) =>
  themePacksRequest('/selection', 'PUT', { selected }, signal);
