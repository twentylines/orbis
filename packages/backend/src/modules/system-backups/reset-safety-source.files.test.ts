import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { withBackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { user, link } from '@/core/database/drizzle/schema';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';
import { collectResetSafetyState, withResetSafetyState, type ResetSafetySourceOptions } from './reset-safety-source';
import { planResetSafetyExports } from './reset-safety-plan';
import { verifyResetExportProof, withResetExportAccess, type SettingsExportAccess } from './settings-export-authorization';

const phc = '$argon2id$v=19$m=65536,t=3,p=4$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo';
const hostId = '00000000-0000-4000-8000-000000000005';
const clone = <T>(value: T): T => structuredClone(value);
function item<T>(values: T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing synthetic fixture record');
  return value;
}
type Context = Pick<ResetSafetySourceOptions, 'plan' | 'access' | 'lease' | 'signal'>;
let root: string;
let restoreCreation: () => void;
let security: string;
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const keys = { verifySensitive: vi.fn() };

beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-source-')));
  restoreCreation = stabilizeDarwinFixtureCreation(() => root);
  security = 'synthetic-security';
  auth.operatorActionContext.mockImplementation(async () => ({ userId: 1, sessionBinding: 'synthetic-session', securityBinding: security }));
  auth.verifySensitiveAction.mockResolvedValue({});
  keys.verifySensitive.mockResolvedValue({});
});
afterEach(async () => {
  vi.restoreAllMocks();
  restoreCreation();
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function scope<T>(accounts: 'keep' | 'remove', work: (context: Context) => Promise<T>) {
  const plan = planResetSafetyExports({ resetId: randomUUID(), accounts, users: [1, 2], captures: [] }).plan;
  const signal = AbortSignal.timeout(15_000);
  const proof = await verifyResetExportProof(auth as never, keys as never, {} as Request, accounts, {
    method: 'password',
    password: 'synthetic password',
  });
  return withBackupMaintenanceLease(signal, (lease) =>
    withResetExportAccess(proof, plan, lease, signal, (access) => work({ plan, access, lease, signal })),
  );
}
function fixture() {
  const accounts = [1, 2].map((id) => ({
    id,
    username: `synthetic-${id}`,
    password: phc,
    createdAt: 11,
    updatedAt: 22,
    operator: id === 1,
    locale: id === 1 ? 'fr' : 'de',
    hasSeenWelcome: true,
    totpEnabled: id === 1,
    totpSecret: id === 1 ? 'source-ciphertext' : null,
    salt: id === 1 ? 'source-salt' : null,
  }));
  const links = [
    {
      id: 4,
      userId: 2,
      title: 'Saved',
      url: 'https://example.invalid',
      iconUrl: 'https://example.invalid/icon',
      description: 'Original description',
      isVisibleOnGuestDashboard: true,
      createdAt: 33,
      updatedAt: 44,
    },
  ];
  const settings = { orbis: { enabled: true, mode: 'scheduled' as const }, apps: { enabled: false }, schedule: { time: '03:00', timezone: 'UTC' } };
  const attempt = { slot: 'historical-slot', state: 'accepted' as const, at: 10, message: 'Historical evidence', jobId: 'old-job' };
  const automaticValue = {
    state: { version: 1 as const, revision: 4, settings, rules: {}, apps: {}, orbis: attempt, pauseReason: null },
    system: {
      version: 1 as const,
      revision: 5,
      enabled: true,
      phase: 'install' as const,
      settingsRevision: 4,
      policyRevision: 5,
      attempt,
      pauseReason: null,
    },
    policy: { version: 1 as const, orbis: { revision: 4, enabled: true, time: '04:00' }, system: { revision: 5, enabled: true, time: '02:00' } },
  };
  const server = {
    advancedSettings: true,
    allowAutoThemes: false,
    allowErrorMonitoring: false,
    guestDashboard: true,
    themeBase: 'dark',
    themeColor: 'purple',
    timeZone: 'UTC',
  };
  const clusterValue = {
    version: 1 as const,
    id: hostId,
    name: 'Cluster',
    role: 'standalone' as const,
    serverName: 'Server',
    invite: { hash: 'a'.repeat(64), expiresAt: 1000, ownerId: 1, authVersion: 2 as const },
    peers: [{ id: 'foreign-peer', name: 'Peer', url: 'https://example.invalid', secret: 'excluded-peer-secret', insecureLan: false }],
    nonces: [{ value: 'excluded-nonce', expiresAt: 1000 }],
  };
  const syncValue = {
    version: 1,
    hostId,
    revision: 8,
    receiving: { revision: 3, userId: null, categories: [], trustRevision: null },
    plans: [],
    receipts: {},
  };
  const passkeyValue = {
    version: 1 as const,
    users: { '1': { handle: 'synthetic_handle', credentials: [] }, '9': { handle: 'foreign_handle', credentials: [] } },
  };
  let transactions = 0;
  let onTransaction: ((count: number) => void) | undefined;
  let budgetOverride: { count: string; bytes: string } | undefined;
  const selections: string[][] = [];
  const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, config: unknown) => {
    expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    onTransaction?.(++transactions);
    return work({
      select: (columns: Record<string, unknown>) => ({
        from: (table: unknown) => {
          expect(table === user || table === link).toBe(true);
          const rows = table === user ? accounts : links;
          const aggregate = 'count' in columns;
          if (!aggregate) selections.push(Object.keys(columns));
          const selected = aggregate
            ? [budgetOverride ?? { count: String(rows.length), bytes: String(rows.length * 512) }]
            : rows.map((row) => Object.fromEntries(Object.keys(columns).map((key) => [key, row[key as keyof typeof row]])));
          if (aggregate) return Promise.resolve(clone(selected));
          return {
            orderBy: () => ({
              limit: (count: number) => {
                expect(count).toBe(table === user ? 257 : 100_001);
                return Promise.resolve(clone(selected));
              },
            }),
          };
        },
      }),
    });
  });
  const config = {
    get: vi.fn((key: string) => {
      expect(key).toBe('userSettings');
      return server;
    }),
  };
  const automatic = { snapshotForReset: vi.fn(async () => clone(automaticValue)) };
  const machine = {
    withResetPreferencesSnapshot: vi.fn(
      async (_context: unknown, work: (value: ReturnType<typeof defaultTimeMachinePreferences>) => Promise<unknown>) =>
        work(defaultTimeMachinePreferences()),
    ),
  };
  const cluster = { read: vi.fn(async () => clone(clusterValue)) };
  const sync = {
    read: vi.fn(async (id: string) => {
      expect(id).toBe(hostId);
      return clone(syncValue);
    }),
  };
  const passkeys = { snapshot: vi.fn(async () => clone(passkeyValue)), withReadFence: vi.fn(async (work: () => Promise<unknown>) => work()) };
  const encryption = { decrypt: vi.fn(() => 'ABCDEFGHIJKLMNOP') };
  const dependencies = { database: { transaction }, config, automatic, machine, cluster, sync, passkeys, encryption } as unknown as Omit<
    ResetSafetySourceOptions,
    keyof Context
  >;
  return {
    dependencies,
    accounts,
    links,
    automaticValue,
    server,
    clusterValue,
    syncValue,
    config,
    automatic,
    machine,
    cluster,
    sync,
    passkeys,
    encryption,
    selections,
    transaction,
    setTransactionHook: (hook: typeof onTransaction) => {
      onTransaction = hook;
    },
    setBudget: (value: typeof budgetOverride) => {
      budgetOverride = value;
    },
  };
}

it('collects all logical columns, independently scheduled policies and protected credential recovery data from actual dependency APIs', async () => {
  const source = fixture();
  const value = await scope('remove', (context) => collectResetSafetyState({ ...source.dependencies, ...context }));
  expect(value.users.map((entry) => [entry.id, entry.locale, entry.hasSeenWelcome, entry.createdAt, entry.updatedAt])).toEqual([
    [1, 'fr', true, 11, 22],
    [2, 'de', true, 11, 22],
  ]);
  expect(value.links).toEqual(source.links);
  expect(value.preferences.automatic.policy?.orbis.time).toBe('04:00');
  expect(value.preferences.automatic.policy?.system.time).toBe('02:00');
  expect(value.evidence.automatic.state.orbis?.jobId).toBe('old-job');
  expect(value.credentials?.users[0]?.totp).toEqual({ enabled: true, secret: 'ABCDEFGHIJKLMNOP' });
  expect(value.credentials?.users[1]?.totp).toEqual({ enabled: false, secret: null });
  expect(value.credentials?.passkeys.policy).toBe('reenroll');
  expect(Object.keys(value.credentials?.passkeys.state.users ?? {})).toEqual(['1']);
  expect(source.encryption.decrypt).toHaveBeenCalledWith('source-ciphertext', 'source-salt');
  expect(source.transaction).toHaveBeenCalledTimes(2);
  const serialized = JSON.stringify(value);
  for (const excluded of ['source-ciphertext', 'source-salt', 'jwtSecret', 'excluded-peer-secret', 'excluded-nonce', 'foreign_handle'])
    expect(serialized).not.toContain(excluded);
  expect(Object.isFrozen(value.users[0])).toBe(true);
  expect(Object.isFrozen(value.credentials?.users[0]?.totp)).toBe(true);
});

it('keeps accounts without querying credential columns, passkeys or source decryption', async () => {
  const source = fixture();
  delete (source.server as Partial<typeof source.server>).themeBase;
  delete (source.server as Partial<typeof source.server>).themeColor;
  const value = await scope('keep', (context) => collectResetSafetyState({ ...source.dependencies, ...context }));
  expect(value.credentials).toBeNull();
  expect(value.preferences.server.themeBase).toBeNull();
  expect(value.preferences.server.themeColor).toBeNull();
  expect(source.passkeys.snapshot).not.toHaveBeenCalled();
  expect(source.encryption.decrypt).not.toHaveBeenCalled();
  expect(source.selections.flat()).not.toContain('password');
  expect(source.selections.flat()).not.toContain('totpSecret');
});

it.each(['cohort', 'foreign-link', 'locale', 'credential'] as const)('rejects database %s drift', async (change) => {
  const source = fixture();
  if (change === 'cohort') source.accounts.pop();
  else if (change === 'foreign-link') item(source.links).userId = 9;
  else
    source.setTransactionHook((count) => {
      if (count === 2) {
        if (change === 'locale') item(source.accounts, 1).locale = 'it';
        else item(source.accounts, 1).password = `${phc}changed`;
      }
    });
  await expect(scope('remove', (context) => collectResetSafetyState({ ...source.dependencies, ...context }))).rejects.toThrow();
});

it.each(['automatic', 'server', 'cluster', 'sync', 'passkeys'] as const)('rejects %s drift across the fenced read', async (change) => {
  const source = fixture();
  source.automatic.snapshotForReset.mockImplementation(async () => {
    if (source.automatic.snapshotForReset.mock.calls.length === 2) {
      if (change === 'automatic') source.automaticValue.state.revision++;
      if (change === 'server') source.server.guestDashboard = false;
      if (change === 'cluster') item(source.clusterValue.nonces).value = 'changed';
      if (change === 'sync') source.syncValue.revision++;
      if (change === 'passkeys')
        source.passkeys.snapshot.mockResolvedValueOnce(clone({ version: 1, users: { '1': { handle: 'old', credentials: [] } } }) as never);
    }
    return clone(source.automaticValue);
  });
  await expect(scope('remove', (context) => collectResetSafetyState({ ...source.dependencies, ...context }))).rejects.toThrow();
});

it.each(['password', 'totp-ciphertext', 'totp-salt', 'decrypt-failure'] as const)('fails closed for missing or unreadable %s', async (change) => {
  const source = fixture();
  if (change === 'password') item(source.accounts).password = '';
  if (change === 'totp-ciphertext') item(source.accounts).totpSecret = null;
  if (change === 'totp-salt') item(source.accounts).salt = null;
  if (change === 'decrypt-failure')
    source.encryption.decrypt.mockImplementation(() => {
      throw new Error('source-ciphertext source-salt must not escape');
    });
  const failed = scope('remove', (context) => collectResetSafetyState({ ...source.dependencies, ...context }));
  await expect(failed).rejects.toThrow();
  await expect(failed).rejects.not.toThrow('source-ciphertext');
});

it.each([
  { count: '100001', bytes: '1' },
  { count: '2', bytes: String(8 * 1024 ** 2 + 1) },
  { count: 'invalid', bytes: '1' },
])('rejects invalid or excessive SQL budgets before fetching rows: %j', async (budget) => {
  const source = fixture();
  source.setBudget(budget);
  await expect(scope('keep', (context) => collectResetSafetyState({ ...source.dependencies, ...context }))).rejects.toThrow();
  expect(source.selections).toEqual([]);
});

it('rejects revoked or forged root authority before further dependency reads', async () => {
  const source = fixture();
  await scope('keep', async (context) => {
    await expect(collectResetSafetyState({ ...source.dependencies, ...context, access: {} as SettingsExportAccess })).rejects.toThrow();
    expect(source.machine.withResetPreferencesSnapshot).not.toHaveBeenCalled();
  });
  source.setTransactionHook(() => {
    security = 'revoked';
  });
  await expect(scope('remove', (context) => collectResetSafetyState({ ...source.dependencies, ...context }))).rejects.toThrow();
  expect(source.encryption.decrypt).not.toHaveBeenCalled();
});

it('holds the capture/preferences fence through preparation and checks a third database snapshot before releasing the result', async () => {
  const source = fixture();
  let active = false;
  source.machine.withResetPreferencesSnapshot.mockImplementation(async (_context, work) => {
    active = true;
    try {
      return await work(defaultTimeMachinePreferences());
    } finally {
      active = false;
    }
  });
  const result = await scope('remove', (context) =>
    withResetSafetyState({ ...source.dependencies, ...context }, async (state) => {
      expect(active).toBe(true);
      expect(source.transaction).toHaveBeenCalledTimes(2);
      expect(Object.isFrozen(state.credentials?.users[0])).toBe(true);
      expect(() => {
        item(state.users).username = 'mutated';
      }).toThrow();
      return { packaged: true };
    }),
  );
  expect(result).toEqual({ packaged: true });
  expect(active).toBe(false);
  expect(source.transaction).toHaveBeenCalledTimes(3);
});

it.each(['database', 'credentials', 'server', 'automatic', 'cluster', 'sync', 'passkeys'] as const)(
  'withholds prepared results when %s changes during preparation',
  async (change) => {
    const source = fixture();
    let prepared = false;
    const result = scope('remove', (context) =>
      withResetSafetyState({ ...source.dependencies, ...context }, async () => {
        prepared = true;
        if (change === 'database') item(source.accounts).locale = 'it';
        if (change === 'credentials') item(source.accounts).totpSecret = 'changed-source-cipher';
        if (change === 'server') source.server.guestDashboard = !source.server.guestDashboard;
        if (change === 'automatic') source.automaticValue.state.revision++;
        if (change === 'cluster') source.clusterValue.name = 'Changed';
        if (change === 'sync') source.syncValue.revision++;
        if (change === 'passkeys') {
          const value = await source.passkeys.snapshot();
          value.users['1'].handle = 'changed_handle';
          source.passkeys.snapshot.mockResolvedValue(value);
        }
        return { mustNotBeReleased: true };
      }),
    );
    await expect(result).rejects.toMatchObject({ code: 'drift' });
    expect(prepared).toBe(true);
  },
);

it('releases the source fence after a failed preparation callback without swallowing its error', async () => {
  const source = fixture();
  let active = false;
  source.machine.withResetPreferencesSnapshot.mockImplementation(async (_context, work) => {
    active = true;
    try {
      return await work(defaultTimeMachinePreferences());
    } finally {
      active = false;
    }
  });
  await expect(
    scope('keep', (context) =>
      withResetSafetyState({ ...source.dependencies, ...context }, async () => {
        throw new Error('synthetic preparation interruption');
      }),
    ),
  ).rejects.toThrow('synthetic preparation interruption');
  expect(active).toBe(false);
  expect(source.transaction).toHaveBeenCalledTimes(2);
});

it('refuses a prepared result when the authorizing session changes inside its callback', async () => {
  const source = fixture();
  await expect(
    scope('keep', (context) =>
      withResetSafetyState({ ...source.dependencies, ...context }, async () => {
        security = 'changed-during-preparation';
        return { mustNotBeReleased: true };
      }),
    ),
  ).rejects.toThrow();
});
