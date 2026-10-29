import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service';
import { SessionManager } from '@/modules/auth/session.manager';
import { BackupDirectorySwap } from '@/modules/system-backups/backup-directory-swap';
import { BackupRestoreJournal } from '@/modules/system-backups/backup-restore-journal';
import { captureRestoreStartupRole, waitForRestoreStartup } from '@/modules/system-backups/backup-restore-startup';

// The production cache path is redirected to private test storage; every database is real Node SQLite.
const sqlite = vi.hoisted(() => ({
  path: '',
  calls: [] as string[],
  opened: [] as { close: () => void }[],
  failure: undefined as Error | undefined,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const { fsMock } = await import('@/tests/__mocks__/fs');
  return { ...fsMock, constants: actual.constants };
});
vi.mock('node:sqlite', () => {
  const actual = require('node:sqlite') as typeof import('node:sqlite');
  return {
    ...actual,
    DatabaseSync: new Proxy(actual.DatabaseSync, {
      construct(target, args) {
        const filename = String(args[0]);
        sqlite.calls.push(filename);
        if (filename === '/cache/cache.sqlite') {
          if (sqlite.failure) throw sqlite.failure;
          args[0] = sqlite.path;
        }
        const database = Reflect.construct(target, args) as import('node:sqlite').DatabaseSync;
        sqlite.opened.push(database);
        return database;
      },
    }),
  };
});
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cache-role-')));
  sqlite.path = path.join(root, 'cache', 'cache.sqlite');
  sqlite.calls = [];
  sqlite.opened = [];
  sqlite.failure = undefined;
  captureRestoreStartupRole('ordinary');
});
afterEach(async () => {
  captureRestoreStartupRole('ordinary');
  vi.unstubAllEnvs();
  for (const database of sqlite.opened) {
    try {
      database.close();
    } catch {}
  }
  await fs.rm(root, { recursive: true, force: true });
});
async function verifiedRole() {
  const value = await BackupRestoreJournal.create(path.join(root, 'backups', 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    verifierController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(stateRoot, { mode: 0o700 });
  const swap = await BackupDirectorySwap.create({ id: value.state.id, root: stateRoot, journal: value.rootJournal('state') });
  await swap.seal(new AbortController().signal);
  await value.advance('prepared');
  await value.advance('quiescing');
  await value.advance('promoting');
  await value.advance('verifying');
  const held = vi.fn();
  const role = await waitForRestoreStartup({
    dataDirectory: root,
    controller: '2'.repeat(12),
    installation: { phase: 'hold', transactionId: value.state.id },
    onHeld: held,
  });
  expect(role).toBe('verify');
  expect(held).not.toHaveBeenCalled();
  captureRestoreStartupRole(role);
  sqlite.calls = [];
}
describe('restore verifier cache isolation', () => {
  it('uses real isolated memory SQLite only after the preboot journal admits the verifier role', async () => {
    await verifiedRole();
    const first = new CacheService();
    const sessions = new SessionManager(first);
    const session = await sessions.createSession(57);
    expect(sessions.isSessionForUser(session, 57)).toBe(true);
    const second = new CacheService();
    expect(new SessionManager(second).isSessionForUser(session, 57)).toBe(false);
    expect(sqlite.calls).toEqual([':memory:', ':memory:']);
    await expect(fs.lstat(path.dirname(sqlite.path))).rejects.toHaveProperty('code', 'ENOENT');
  });
  it.each(['ordinary', 'candidate'] as const)('keeps %s sessions persistent across real CacheService instances', async (role) => {
    captureRestoreStartupRole(role);
    await fs.mkdir(path.dirname(sqlite.path), { mode: 0o700 });
    const first = new CacheService();
    const session = await new SessionManager(first).createSession(57);
    sqlite.opened[0]?.close();
    const second = new CacheService();
    expect(new SessionManager(second).isSessionForUser(session, 57)).toBe(true);
    expect(sqlite.calls).toEqual(['/cache/cache.sqlite', '/cache/cache.sqlite']);
    expect((await fs.lstat(sqlite.path)).isFile()).toBe(true);
  });
  it('does not let a raw installer hold environment choose the memory cache', async () => {
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', randomUUID());
    await fs.mkdir(path.dirname(sqlite.path), { mode: 0o700 });
    const cache = new CacheService();
    cache.set('ordinary', 'kept');
    expect(sqlite.calls).toEqual(['/cache/cache.sqlite']);
    expect(cache.get('ordinary')).toBe('kept');
  });
  it('does not mask an ordinary persistent SQLite failure with a memory fallback', () => {
    const failure = new Error('fixture persistent cache unavailable');
    sqlite.failure = failure;
    expect(() => new CacheService()).toThrow(failure);
    expect(sqlite.calls).toEqual(['/cache/cache.sqlite']);
  });
  it('does not attempt the unavailable host cache for an admitted verifier', async () => {
    await verifiedRole();
    sqlite.failure = new Error('fixture host cache unavailable');
    const cache = new CacheService();
    cache.set('health', 'ready');
    expect(cache.get('health')).toBe('ready');
    expect(sqlite.calls).toEqual([':memory:']);
    await expect(fs.lstat(path.dirname(sqlite.path))).rejects.toHaveProperty('code', 'ENOENT');
  });
});
