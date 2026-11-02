import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { app, appStore, link, orbisResetReceipt, user } from '@/core/database/drizzle/schema';
import {
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  backupMaintenanceActive,
} from '@/common/backup-maintenance';
import { ResetState, type ResetJournal } from './reset-state';
import { ResetService, resetBinding } from './reset.service';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';

const status = vi.hoisted(() => vi.fn());
vi.mock('@/common/restoration-status', () => ({ readOperationStatus: status }));
let root: string;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
let records: { id: number; password: string; totpEnabled: boolean; hasSeenWelcome: boolean; locale: string }[];
let receipts: { id: string; completedAt: number }[];
let mutations: unknown[];
let auth: { operatorActionContext: ReturnType<typeof vi.fn>; verifySensitiveAction: ReturnType<typeof vi.fn> };
let keys: { snapshot: ReturnType<typeof vi.fn>; change: ReturnType<typeof vi.fn> };
let sessions: { destroyAllSessionsByUserId: ReturnType<typeof vi.fn> };
let automatic: { resetOrbisPreferences: ReturnType<typeof vi.fn> };
let service: ResetService;
let passkeys: { verifySensitive: ReturnType<typeof vi.fn>; sensitiveOptions: ReturnType<typeof vi.fn> };
const request = {} as Request;
const body = (accounts = 'keep') => ({ accounts, confirmation: 'RESET ORBIS', method: 'password', password: 'fixture-only-password' });
const journal = (): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: os.hostname(),
  accounts: 'keep',
  users: [7],
  phase: 'prepared',
  createdAt: Date.now(),
});
async function file(relative: string, content = 'unchanged') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
  return target;
}
async function complete() {
  await vi.waitFor(async () => {
    expect((await new ResetState(root).read())?.phase).toBe('complete');
    expect(backupMaintenanceActive()).toBe(false);
  });
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-reset-')));
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
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
  service = new ResetService(
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
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  setResetRecoveryRequired(false);
  await fs.rm(root, { recursive: true, force: true });
});
it('keeps account security, installed app data, app configs and host trust while resetting user preferences', async () => {
  const preserved = [
    'state/adoption-audit/receipt.json',
    'app-data/store/app/data',
    'apps/store/app/docker-compose.yml',
    'state/cluster.json',
    'state/host-authority/receipt.json',
    'state/desktop/99.json',
  ];
  for (const name of preserved) await file(name);
  await fs.chmod(await file('.orbis-onboarding-origin.json', 'fixture adoption-origin'), 0o644);
  for (const name of [
    'desktop/7.json',
    'theme-settings/7.json',
    'onboarding/7.json',
    'wallpapers/7.image',
    'wallpapers/7.image.saved',
    'theme-packs/7/custom/asset',
  ])
    await file(`state/${name}`, 'old preference');
  const accepted = await service.accept(request, body());
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  accepted.start();
  accepted.start();
  await complete();
  expect(records[0]).toMatchObject({ password: 'existing-hash', totpEnabled: true, hasSeenWelcome: false, locale: 'en' });
  expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
  expect(keys.change).not.toHaveBeenCalled();
  for (const name of preserved) expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('unchanged');
  expect(mutations).toEqual([link, user, orbisResetReceipt]);
  expect(mutations).not.toContain(app);
  expect(mutations).not.toContain(appStore);
  await expect(fs.stat(path.join(root, 'state/desktop/7.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const preferences = new DesktopPreferencesService({ get: () => ({ dataDir: root }) } as never);
  expect(await preferences.onboarding(7)).toEqual({ complete: false, generation: accepted.job.id });
  expect(await preferences.read(7)).toMatchObject({ serverName: 'Server', preset: 'frost', mode: 'light' });
  await expect(fs.stat(path.join(root, '.orbis-onboarding-origin.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(backupMaintenanceActive()).toBe(false);
});
it('removes sign-in credentials before deleting only the selected accounts and commits a completion receipt', async () => {
  await file('state/password-change-request', 'fixture-recovery-request');
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await complete();
  expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledWith(7);
  expect(keys.change).toHaveBeenCalledTimes(1);
  expect(records).toEqual([]);
  expect(receipts).toHaveLength(1);
  await expect(fs.stat(path.join(root, 'state/password-change-request'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(mutations).toEqual([link, user, orbisResetReceipt]);
});
it('rejects malformed scope, unconfirmed requests and failed fresh authentication before admission', async () => {
  for (const value of [
    { ...body(), accounts: 'all' },
    { ...body(), confirmation: 'reset' },
    { ...body(), deleteApps: true },
  ])
    await expect(service.accept(request, value)).rejects.toThrow();
  auth.verifySensitiveAction.mockRejectedValue(new Error('rejected'));
  await expect(service.accept(request, body())).rejects.toThrow('rejected');
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
});
it('accepts the confirmation words regardless of case and outer whitespace but still requires fresh authentication', async () => {
  auth.verifySensitiveAction.mockRejectedValue(new Error('fresh authentication required'));
  for (const confirmation of ['reset orbis', '  ReSeT oRbIs  ', '\tRESET ORBIS\n'])
    await expect(service.accept(request, { ...body(), confirmation })).rejects.toThrow('fresh authentication required');
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(3);
  for (const confirmation of ['reset  orbis', 'reset orbis now', null])
    await expect(service.accept(request, { ...body(), confirmation })).rejects.toThrow();
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(3);
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
});
it('rejects a session/security change during fresh confirmation', async () => {
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValue({ ...actor, securityBinding: 'c'.repeat(64) });
  await expect(service.accept(request, body())).rejects.toThrow('sign-in changed');
  expect(await new ResetState(root).read()).toBeNull();
});
it('refuses capture, restore and update locks without creating reset intent', async () => {
  for (const state of ['restoring', 'updating', 'checking']) {
    status.mockResolvedValue({ state });
    await expect(service.accept(request, body())).rejects.toThrow('current system operation');
  }
  expect(await new ResetState(root).read()).toBeNull();
});
it('rejects symbolic and hard-linked preferences before any file or database changes', async () => {
  const outside = await file('outside');
  await fs.mkdir(path.join(root, 'state/desktop'), { mode: 0o700 });
  const target = path.join(root, 'state/desktop/7.json');
  await fs.symlink(outside, target);
  await expect(service.accept(request, body())).rejects.toThrow('review');
  await fs.unlink(target);
  await fs.link(outside, target);
  await expect(service.accept(request, body())).rejects.toThrow('review');
  expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
  expect(mutations).toEqual([]);
});
it('keeps an authoritative recovery lock after a filesystem failure and preserves app data', async () => {
  await file('state/desktop/7.json');
  const appData = await file('app-data/kept');
  const accepted = await service.accept(request, body());
  vi.spyOn(ResetState.prototype, 'erasePreferences').mockRejectedValue(new Error('fixture storage failure'));
  accepted.start();
  await vi.waitFor(async () => expect((await new ResetState(root).read())?.phase).toBe('recovery'));
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  expect(await fs.readFile(appData, 'utf8')).toBe('unchanged');
});
it.each(['absent', 'complete'])('releases the production startup reset hold for a %s journal before bootstrap', async (state) => {
  if (state === 'complete') await new ResetState(root).save({ ...journal(), phase: 'complete' });
  setResetRecoveryRequired(true);
  await service.resumePending();
  expect(backupMaintenanceActive()).toBe(false);
  expect(mutations).toEqual([]);
});
it('keeps the production startup reset hold when the reset journal is unreadable', async () => {
  vi.spyOn(ResetState.prototype, 'read').mockRejectedValue(new Error('unreadable'));
  setResetRecoveryRequired(true);
  await service.resumePending();
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
});
it('never replays a copied or interrupted reset at startup without fresh authorization', async () => {
  status.mockResolvedValue({ state: 'resetting' });
  const pending = { ...journal(), controller: 'another-controller' };
  await new ResetState(root).save(pending);
  await service.resumePending();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  expect((await new ResetState(root).read())?.phase).toBe('recovery');
  expect(backupMaintenanceActive()).toBe(true);
});
it('finishes only a proven database commit after a journal-write interruption', async () => {
  status.mockResolvedValue({ state: 'resetting' });
  const pending = journal();
  await new ResetState(root).save(pending);
  receipts.push({ id: pending.id, completedAt: 1 });
  await service.resumePending();
  expect((await new ResetState(root).read())?.phase).toBe('complete');
  expect(mutations).toEqual([]);
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
});
it('binds passkey authorization to the exact keep/remove choice', () => {
  expect(resetBinding('keep')).not.toBe(resetBinding('remove'));
});
it('requires verified account-bound passkey proof before admitting a reset', async () => {
  await service.options(request, { accounts: 'remove' });
  expect(passkeys.sensitiveOptions).toHaveBeenCalledWith(request, resetBinding('remove'));
  await expect(
    service.accept(request, { accounts: 'remove', confirmation: 'RESET ORBIS', method: 'passkey', challengeId: randomUUID(), response: {} }),
  ).rejects.toThrow('Invalid passkey proof');
  expect(passkeys.verifySensitive.mock.calls[0]?.[1]).toBe(resetBinding('remove'));
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
});
it('keeps startup consumers held until reset intent has been inspected without replaying it', async () => {
  setResetRecoveryRequired(true);
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(false);
  const pending = journal();
  await new ResetState(root).save(pending);
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  expect((await new ResetState(root).read())?.phase).toBe('prepared');
});
it('uses an exclusive durable lock and refuses to steal an interrupted process lease', async () => {
  const store = new ResetState(root);
  const release = await store.acquireLease();
  await expect(new ResetState(root).acquireLease()).rejects.toThrow('locked');
  await release();
  const next = await new ResetState(root).acquireLease();
  await next();
});
it('does not finalize reset metadata while protected restore or update remains active', async () => {
  const pending = journal();
  await new ResetState(root).save(pending);
  receipts.push({ id: pending.id, completedAt: 1 });
  status.mockResolvedValue({ state: 'restoring' });
  await service.resumePending();
  expect((await new ResetState(root).read())?.phase).toBe('prepared');
  expect(mutations).toEqual([]);
});
it('requires fresh authentication before recovery and retains the original account choice', async () => {
  await new ResetState(root).save({ ...journal(), phase: 'recovery' });
  status.mockResolvedValue({ state: 'resetting' });
  setResetRecoveryRequired(true);
  await expect(service.accept(request, body('remove'), true)).rejects.toThrow('original reset choice');
  const accepted = await service.accept(request, body(), true);
  accepted.start();
  await complete();
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
  expect(records).toHaveLength(1);
});
