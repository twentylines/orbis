import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { app, appStore, link, orbisResetReceipt, user } from '@/core/database/drizzle/schema';
import {
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { STAGE_PREFIX } from './reset-preference-store';
import { ResetState, type ResetJournal, type ResetStateOptions } from './reset-state';
import { ResetService } from './reset.service';

const status = vi.hoisted(() => vi.fn());
vi.mock('@/common/restoration-status', () => ({ readOperationStatus: status, notifyClientStatusChanged: vi.fn() }));

const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const request = {} as Request;
const body = (accounts = 'keep') => ({ accounts, confirmation: 'RESET ORBIS', method: 'password', password: 'fixture-pass' });
const journal = (overrides: Partial<ResetJournal> = {}): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: os.hostname(),
  accounts: 'keep',
  users: [7],
  phase: 'prepared',
  createdAt: Date.now(),
  ...overrides,
});
const mountLine = (mount: string, fsType = 'ext4', source = '/dev/sda1') => `36 35 98:0 / ${mount} rw,relatime - ${fsType} ${source} rw`;
const mountTable = (...lines: string[]) => `${lines.join('\n')}\n`;
const stages = async (directory: string) => (await fs.readdir(directory)).filter((name) => name.startsWith(STAGE_PREFIX));

let root: string;
let authority: string;
let legacy: string;
let mounts: string;
let records: { id: number; password: string; totpEnabled: boolean; hasSeenWelcome: boolean; locale: string }[];
let receipts: { id: string; completedAt: number }[];
let mutations: unknown[];
let auth: { operatorActionContext: ReturnType<typeof vi.fn>; verifySensitiveAction: ReturnType<typeof vi.fn> };
let keys: { snapshot: ReturnType<typeof vi.fn>; change: ReturnType<typeof vi.fn> };
let sessions: { destroyAllSessionsByUserId: ReturnType<typeof vi.fn> };
let automatic: { resetOrbisPreferences: ReturnType<typeof vi.fn> };
let passkeys: { verifySensitive: ReturnType<typeof vi.fn>; sensitiveOptions: ReturnType<typeof vi.fn> };
let service: ResetService;

const seams = (extra: ResetStateOptions = {}): ResetStateOptions => ({
  readMounts: async () => mounts,
  descriptorRoot: (_fd, directory) => directory,
  ...extra,
});
const store = (extra: ResetStateOptions = {}) => new ResetState(root, seams(extra));
async function dedicated(extra: ResetStateOptions = {}) {
  await fs.mkdir(authority, { mode: 0o700 });
  mounts = mountTable(mountLine(root), mountLine(authority));
  return store(extra);
}
async function file(relative: string, content = 'old preference') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
  return target;
}
function build(instance: ResetState) {
  const tx = {
    execute: vi.fn(),
    delete: (table: unknown) => ({
      where: async () => {
        mutations.push(table);
        if (table === user) records = [];
      },
    }),
    update: (table: unknown) => ({
      set: (values: object) => ({
        where: async () => {
          mutations.push(table);
          records = records.map((record) => ({ ...record, ...values }));
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: { id: string; completedAt: number }) => ({
        onConflictDoNothing: async () => {
          mutations.push(table);
          receipts.push(value);
        },
      }),
    }),
  };
  const db = {
    select: () => ({ from: (table: unknown) => (table === user ? Promise.resolve(records) : { where: async () => receipts }) }),
    transaction: vi.fn(async (operation) => operation(tx)),
  };
  const cluster = {
    read: vi.fn().mockResolvedValue({ id: 'paired-host' }),
    transaction: vi.fn(async (change) => change({ id: 'paired-host', invite: { ownerId: 7 } })),
  };
  const sync = { transaction: vi.fn(async (_id, change) => change({ revision: 1, receiving: { revision: 1 }, plans: [], receipts: {} })) };
  const config = { get: () => ({ dataDir: root }), setUserSettings: vi.fn().mockResolvedValue(undefined) };
  return new ResetService(
    config as never,
    db as never,
    auth as never,
    passkeys as never,
    keys as never,
    sessions as never,
    cluster as never,
    sync as never,
    automatic as never,
    { preferences: vi.fn().mockResolvedValue({ revision: 1 }), updatePreferences: vi.fn().mockResolvedValue({}) } as never,
    { settings: vi.fn().mockResolvedValue({ revision: 1 }), updateSettings: vi.fn().mockResolvedValue({}) } as never,
    instance,
  );
}
async function complete(instance: ResetState) {
  await vi.waitFor(async () => {
    expect((await instance.read())?.phase).toBe('complete');
    expect(backupMaintenanceActive()).toBe(false);
  });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-reset-dedicated-')));
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
  authority = path.join(root, 'orbis-reset');
  legacy = path.join(root, 'state/orbis-reset');
  mounts = mountTable(mountLine(root));
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  status.mockReset().mockResolvedValue({ state: 'idle' });
  records = [{ id: 7, password: 'existing-hash', totpEnabled: true, hasSeenWelcome: true, locale: 'fr' }];
  receipts = [];
  mutations = [];
  auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue({ operator: true }) };
  keys = { snapshot: vi.fn().mockResolvedValue({ version: 1, users: {} }), change: vi.fn(async (change) => change({ users: { 7: {} } })) };
  sessions = { destroyAllSessionsByUserId: vi.fn().mockResolvedValue(undefined) };
  automatic = { resetOrbisPreferences: vi.fn().mockResolvedValue(undefined) };
  passkeys = { verifySensitive: vi.fn().mockRejectedValue(new Error('Invalid passkey proof')), sensitiveOptions: vi.fn().mockResolvedValue({}) };
});
afterEach(async () => {
  vi.restoreAllMocks();
  setResetRecoveryRequired(false);
  await fs.rm(root, { recursive: true, force: true });
});

it('runs a reset on the verified dedicated mount without writing a legacy journal', async () => {
  const target = await file('state/desktop/7.json');
  const kept = await file('state/desktop/8.json');
  const instance = await dedicated();
  service = build(instance);

  const accepted = await service.accept(request, body());
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  accepted.start();
  await complete(instance);

  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(kept, 'utf8')).toBe('old preference');
  expect((await fs.readdir(path.join(root, 'state/desktop'))).sort()).toEqual(['8.json']);
  await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await stages(path.join(root, 'state/desktop'))).toEqual([]);
  expect(receipts).toHaveLength(1);
  expect(mutations).toEqual([link, user, orbisResetReceipt]);
  expect(mutations).not.toContain(app);
  expect(mutations).not.toContain(appStore);
});

it('keeps an imported journal pending and never replays it without a receipt', async () => {
  const instance = await dedicated();
  status.mockResolvedValue({ state: 'resetting' });
  const imported = journal({ controller: 'another-controller', phase: 'recovery' });
  await instance.save(imported);
  service = build(instance);

  await service.resumePending();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  expect(await instance.read()).toEqual(imported);
  expect(backupMaintenanceActive()).toBe(true);
});

it('finalizes an imported journal only when this database already committed its receipt', async () => {
  const instance = await dedicated();
  status.mockResolvedValue({ state: 'resetting' });
  const imported = journal({ controller: 'another-controller', phase: 'prepared' });
  await instance.save(imported);
  receipts.push({ id: imported.id, completedAt: 1 });
  service = build(instance);

  await service.resumePending();
  expect((await instance.read())?.phase).toBe('complete');
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  expect(backupMaintenanceActive()).toBe(false);
});

it('keeps the dedicated hold after an interrupted erase and finishes it with the original journal', async () => {
  await file('state/desktop/7.json');
  await file('state/wallpapers/7.image');
  const interruptedStore = await dedicated({
    rename: async (from, to) => {
      if (from.endsWith('7.image')) throw Object.assign(new Error('fixture interruption'), { code: 'EIO' });
      await fs.rename(from, to);
    },
  });
  service = build(interruptedStore);

  const accepted = await service.accept(request, body());
  accepted.start();
  await vi.waitFor(async () => expect((await interruptedStore.read())?.phase).toBe('recovery'));
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  expect(await fs.readFile(path.join(root, 'state/wallpapers/7.image'), 'utf8')).toBe('old preference');
  expect(await stages(path.join(root, 'state/wallpapers'))).toEqual([`${STAGE_PREFIX}${accepted.job.id}`]);

  status.mockResolvedValue({ state: 'resetting' });
  await service.resumePending();
  expect(backupMaintenanceActive()).toBe(true);

  const resumedStore = store();
  const resumed = build(resumedStore);
  const recovery = await resumed.accept(request, body(), true);
  expect(recovery.job.id).toBe(accepted.job.id);
  recovery.start();
  await complete(resumedStore);

  await expect(fs.stat(path.join(root, 'state/wallpapers/7.image'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await stages(path.join(root, 'state/wallpapers'))).toEqual([]);
  expect(records[0]).toMatchObject({ hasSeenWelcome: false, locale: 'en' });
  expect(receipts).toHaveLength(1);
  expect(mutations).toEqual([link, user, orbisResetReceipt]);
  await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a reset before intent is written when a preference parent is shared', async () => {
  await file('state/desktop/7.json');
  await fs.chmod(path.join(root, 'state/desktop'), 0o777);
  const instance = await dedicated();
  service = build(instance);

  await expect(service.accept(request, body())).rejects.toThrow('Reset preferences need local review');
  expect(await instance.read()).toBeNull();
  expect(await fs.readdir(authority)).toEqual([]);
  expect(mutations).toEqual([]);
  expect(backupMaintenanceActive()).toBe(false);
});

it('holds startup when the verified mount cannot be resolved after the fact', async () => {
  const instance = await dedicated();
  await instance.save(journal());
  mounts = mountTable(mountLine(root));
  service = build(instance);

  setResetRecoveryRequired(false);
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(true);
});
