import { type } from 'arktype';

export const syncCategoryNames = {
  customisation: 'Customisation',
  'orbis-updates': 'Orbis updates',
  'app-updates': 'App updates',
  schedules: 'App schedules',
} as const;
export type SyncCategory = keyof typeof syncCategoryNames;
export const syncCategoryKeys = Object.keys(syncCategoryNames) as SyncCategory[];
const category = type.enumerated('customisation', 'orbis-updates', 'app-updates', 'schedules');
const categories = category
  .array()
  .atMostLength(4)
  .narrow((items) => new Set(items).size === items.length);
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const revisions = type({ '+': 'reject', 'customisation?': hash, 'orbis-updates?': hash, 'app-updates?': hash, 'schedules?': hash });
const result = type({
  '+': 'reject',
  category,
  status: "'applied' | 'unchanged' | 'conflict' | 'refused' | 'failed' | 'unsupported'",
  'revision?': hash,
  skippedApps: 'number.integer >= 0 & number <= 256',
});
const status = "'idle' | 'synced' | 'conflict' | 'partial' | 'unavailable' | 'disabled'";
const plan = type({
  '+': 'reject',
  hostId: uuid,
  revision: 'number.integer >= 0',
  categories,
  automatic: 'boolean',
  status,
  lastAttemptAt: 'number >= 0 | null',
  results: result.array().atMostLength(4),
  usesYourAccount: 'boolean',
  trustCurrent: 'boolean',
});
const receipt = type({ '+': 'reject', sourceRevision: hash, at: 'number > 0' });
const host = type({
  '+': 'reject',
  id: uuid,
  name: 'string <= 64',
  available: 'boolean',
  accepted: categories,
  revisions,
  receipts: { '+': 'reject', 'customisation?': receipt, 'orbis-updates?': receipt, 'app-updates?': receipt, 'schedules?': receipt },
  plan: plan.or('null'),
});
export const clusterSyncSchema = type({
  '+': 'reject',
  version: '1',
  role: "'standalone' | 'admin' | 'member'",
  receiving: { '+': 'reject', revision: 'number.integer >= 0', categories, usesYourAccount: 'boolean', configured: 'boolean' },
  hosts: host.array().atMostLength(12),
  source: type({
    '+': 'reject',
    orbis: { '+': 'reject', enabled: 'boolean', mode: "'idle' | 'scheduled'" },
    appCount: 'number.integer >= 0 & number <= 256',
    time: 'string <= 5',
  }).or('null'),
});
const runResult = type({ '+': 'reject', hostId: uuid, status, results: result.array().atMostLength(4) });
export type ClusterSyncSnapshot = typeof clusterSyncSchema.infer;
export type ClusterSyncHost = typeof host.infer;
export type SyncRevisions = typeof revisions.infer;
export const clusterSyncKey = (userId: number | undefined) => ['cluster-settings-sync', userId] as const;

export class ClusterSyncError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401
        ? 'Sign in again to manage settings sync.'
        : status === 403
          ? 'Use an operator session on the correct primary or receiving server.'
          : status === 409
            ? 'Settings or receiving choices changed. Refresh, review this host and save or sync again.'
            : status === 404
              ? 'Settings sync is unavailable on this paired server. Update both servers before trying again.'
              : status === 429
                ? 'Too many requests. Wait a minute before retrying.'
                : 'Settings sync did not finish. Refresh status and check the paired server connection.',
    );
  }
}
function parse<T>(schema: (raw: unknown) => T | type.errors, raw: unknown): T {
  const value = schema(raw);
  if (value instanceof type.errors) throw new Error('The settings sync response could not be verified. Refresh both servers.');
  return value;
}
export function syncEndpoint(path: string) {
  if (path === '' || path === '/receiving') return `/api/cluster/settings-sync${path}`;
  const matched = /^\/plans\/([^/]+)(\/run)?$/.exec(path);
  if (!matched?.[1] || uuid(matched[1]) instanceof type.errors) throw new Error('Choose one paired server for settings sync.');
  return `/api/cluster/settings-sync${path}`;
}
async function request(path: string, method: 'GET' | 'PUT' | 'POST', body?: unknown, signal?: AbortSignal) {
  const response = await fetch(syncEndpoint(path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ClusterSyncError(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error('Settings sync returned an unreadable response. Refresh status before retrying.');
  }
}
export async function readClusterSync(signal?: AbortSignal) {
  return parse(clusterSyncSchema, await request('', 'GET', undefined, signal));
}
export async function saveReceiving(revision: number, selected: SyncCategory[], signal?: AbortSignal) {
  parse(categories, selected);
  return parse(type({ '+': 'reject', saved: 'true' }), await request('/receiving', 'PUT', { revision, categories: selected }, signal));
}
export async function saveClusterSync(host: ClusterSyncHost, selected: SyncCategory[], automatic: boolean, signal?: AbortSignal) {
  parse(categories, selected);
  return parse(
    type({ '+': 'reject', saved: 'true' }),
    await request(
      `/plans/${host.id}`,
      'PUT',
      { revision: host.plan?.revision ?? 0, categories: selected, automatic, expected: host.revisions },
      signal,
    ),
  );
}
export async function runClusterSync(host: ClusterSyncHost, signal?: AbortSignal) {
  if (!host.plan || !host.plan.usesYourAccount || !host.plan.trustCurrent)
    throw new Error('Save and review this host’s sync choices using your account first.');
  return parse(runResult, await request(`/plans/${host.id}/run`, 'POST', { revision: host.plan.revision, expected: host.revisions }, signal));
}
