import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { app, appStore, link, orbisResetReceipt, user } from '@/core/database/drizzle/schema';
import {
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  backupMaintenanceActive,
  resetOperationActive,
  setResetOperationActive,
  backupMaintenanceLeaseHeld,
  resetRecoveryHeld,
} from '@/common/backup-maintenance';
import { ResetState, type ResetJournal } from './reset-state';
import { ResetService, resetBinding } from './reset.service';
import { archiveBackedResetJournal } from './reset-contract';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { OwnershipWriteLease } from '../sentinel-recovery/ownership-authority';
import type { HostCredentialRecoveryBroker } from '../sentinel-recovery/host-broker';

const status = vi.hoisted(() => vi.fn());
vi.mock('@/common/restoration-status', () => ({ readOperationStatus: status, notifyClientStatusChanged: vi.fn(), notifyResetStarted: vi.fn() }));
let root: string;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
let records: { id: number; password: string; totpEnabled: boolean; hasSeenWelcome: boolean; locale: string }[];
let receipts: { id: string; completedAt: number }[];
let mutations: unknown[];
let auth: { operatorActionContext: ReturnType<typeof vi.fn>; verifySensitiveAction: ReturnType<typeof vi.fn> };
let keys: { snapshot: ReturnType<typeof vi.fn>; change: ReturnType<typeof vi.fn> };
let sessions: { destroyAllSessionsByUserId: ReturnType<typeof vi.fn> };
let automatic: { resetOrbisPreferences: ReturnType<typeof vi.fn> };
let backups: { settings: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
let bundles: {
  reconcileResetOwnership: ReturnType<typeof vi.fn>;
  prepareResetOwnership: ReturnType<typeof vi.fn>;
  completeResetOwnership: ReturnType<typeof vi.fn>;
};
let captures: typeof bundles & { preferences: ReturnType<typeof vi.fn>; updatePreferences: ReturnType<typeof vi.fn> };
let service: ResetService;
let passkeys: { verifySensitive: ReturnType<typeof vi.fn>; sensitiveOptions: ReturnType<typeof vi.fn> };
let ownership: { beginOwnership: ReturnType<typeof vi.fn> };
let ownershipBroker: {
  ownershipPrepare: ReturnType<typeof vi.fn<HostCredentialRecoveryBroker['ownershipPrepare']>>;
  ownershipCheck: ReturnType<typeof vi.fn<HostCredentialRecoveryBroker['ownershipCheck']>>;
  ownershipComplete: ReturnType<typeof vi.fn<HostCredentialRecoveryBroker['ownershipComplete']>>;
};
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
  setResetOperationActive(false);
  setRestoreRecoveryRequired(false);
  status.mockReset().mockResolvedValue({ state: 'idle' });
  records = [{ id: 7, password: 'existing-hash', totpEnabled: true, hasSeenWelcome: true, locale: 'fr' }];
  receipts = [];
  mutations = [];
  auth = { operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue({ operator: true }) };
  keys = { snapshot: vi.fn().mockResolvedValue({ version: 1, users: {} }), change: vi.fn(async (change) => change({ users: { 7: {} } })) };
  sessions = { destroyAllSessionsByUserId: vi.fn().mockResolvedValue(undefined) };
  automatic = { resetOrbisPreferences: vi.fn().mockResolvedValue(undefined) };
  backups = { settings: vi.fn().mockResolvedValue({ revision: 9, retentionHours: 720 }), updateSettings: vi.fn().mockResolvedValue({}) };
  bundles = {
    reconcileResetOwnership: vi.fn().mockResolvedValue(undefined),
    prepareResetOwnership: vi.fn().mockResolvedValue(undefined),
    completeResetOwnership: vi.fn().mockResolvedValue(undefined),
  };
  captures = {
    preferences: vi.fn().mockResolvedValue({ revision: 1 }),
    updatePreferences: vi.fn().mockResolvedValue({}),
    reconcileResetOwnership: vi.fn().mockResolvedValue(undefined),
    prepareResetOwnership: vi.fn().mockResolvedValue(undefined),
    completeResetOwnership: vi.fn().mockResolvedValue(undefined),
  };
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
  ownershipBroker = {
    ownershipPrepare: vi.fn(async ({ requestId, purpose }) => ({
      requestId,
      purpose,
      operationId: 'b'.repeat(64),
      admissionBinding: 'a'.repeat(64),
      state: 'pending' as const,
    })),
    ownershipCheck: vi.fn(async (grant) => grant),
    ownershipComplete: vi.fn(async (grant) => ({ ...grant, state: 'completed' as const })),
  };
  ownership = {
    beginOwnership: vi.fn(async (purpose, request) =>
      request.replay
        ? OwnershipWriteLease.resume(ownershipBroker, purpose, request.requestId)
        : OwnershipWriteLease.prepare(ownershipBroker, purpose, request.requestId),
    ),
  };
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
    captures as never,
    backups as never,
    bundles as never,
    undefined,
    ownership as never,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  setResetRecoveryRequired(false);
  setResetOperationActive(false);
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
    'backups/archive/retained.orbis',
    'backups/time-machine/retained-point/backup.orbis',
    'backups/keyring.json',
  ];
  for (const name of preserved) await file(name);
  await fs.chmod(await file('.orbis-onboarding-origin.json', 'fixture adoption-origin'), 0o644);
  for (const name of ['theme-settings/7.json', 'onboarding/7.json', 'wallpapers/7.image', 'wallpapers/7.image.saved', 'theme-packs/7/custom/asset'])
    await file(`state/${name}`, 'old preference');
  await file(
    'state/desktop/7.json',
    JSON.stringify({
      ...DEFAULT_DESKTOP_PREFERENCES,
      workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
      appearance: { ...DEFAULT_DESKTOP_PREFERENCES.appearance, dockPins: ['jellyfin:fixture'] },
    }),
  );
  const preferences = new DesktopPreferencesService({ get: () => ({ dataDir: root }) } as never);
  expect(await preferences.read(7)).toMatchObject({
    workspace: { pinnedApps: ['jellyfin:fixture'] },
    appearance: { dockPins: ['jellyfin:fixture'] },
  });
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
  expect(await preferences.onboarding(7)).toEqual({ complete: false, generation: accepted.job.id });
  expect(await preferences.read(7)).toMatchObject({
    serverName: 'Server',
    preset: 'frost',
    mode: 'system',
    workspace: { pinnedApps: [] },
    appearance: { dockPins: [] },
  });
  expect(backups.updateSettings).not.toHaveBeenCalled();
  expect(ownership.beginOwnership).not.toHaveBeenCalled();
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
it('reserves backup and capture ownership before reset and releases both only after the database receipt', async () => {
  bundles.completeResetOwnership.mockImplementation(async (value: ResetJournal, verify: () => Promise<boolean>) => {
    expect(value.phase).toBe('complete');
    expect(records).toEqual([]);
    expect(await verify()).toBe(true);
  });
  captures.completeResetOwnership.mockImplementation(async (value: ResetJournal, verify: () => Promise<boolean>) => {
    expect(value.phase).toBe('complete');
    expect(records).toEqual([]);
    expect(await verify()).toBe(true);
  });
  const accepted = await service.accept(request, body('remove'));
  expect(bundles.prepareResetOwnership).toHaveBeenCalledWith(expect.objectContaining({ id: accepted.job.id, users: [7], accounts: 'remove' }));
  expect(bundles.completeResetOwnership).not.toHaveBeenCalled();
  expect(captures.prepareResetOwnership).toHaveBeenCalledWith(expect.objectContaining({ id: accepted.job.id, users: [7], accounts: 'remove' }), [7]);
  expect(captures.completeResetOwnership).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  accepted.start();
  await complete();
  expect(bundles.completeResetOwnership).toHaveBeenCalledTimes(1);
  expect(captures.completeResetOwnership).toHaveBeenCalledTimes(1);
  expect(receipts[0]?.id).toBe(accepted.job.id);
});
it('keeps preferences and accounts when capture retention cannot be reserved', async () => {
  const preference = await file('state/desktop/7.json', 'preserve this preference');
  captures.prepareResetOwnership.mockRejectedValue(new Error('Capture ownership needs review'));
  await expect(service.accept(request, body('remove'))).rejects.toThrow('Capture ownership needs review');
  expect(await fs.readFile(preference, 'utf8')).toBe('preserve this preference');
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
  expect(records).toHaveLength(1);
  expect(backupMaintenanceLeaseHeld()).toBe(false);
  expect(resetRecoveryHeld()).toBe(true);
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
});
it('keeps every preference and account when saved-backup custody cannot be reserved', async () => {
  const preference = await file('state/desktop/7.json', 'preserve this preference');
  bundles.prepareResetOwnership.mockRejectedValue(new Error('Backup ownership needs review'));
  await expect(service.accept(request, body('remove'))).rejects.toThrow('Backup ownership needs review');
  expect(await fs.readFile(preference, 'utf8')).toBe('preserve this preference');
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
  expect(records).toHaveLength(1);
  expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
  expect(backupMaintenanceLeaseHeld()).toBe(false);
  expect(resetRecoveryHeld()).toBe(true);
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
});

it('holds Root authority before reconciliation, throughout delayed start and until receipt-backed ownership completion', async () => {
  bundles.reconcileResetOwnership.mockImplementation(async () => {
    expect(backupMaintenanceLeaseHeld()).toBe(false);
    expect(ownershipBroker.ownershipCheck).toHaveBeenCalledTimes(1);
  });
  const accepted = await service.accept(request, body('remove'));
  expect(ownership.beginOwnership).toHaveBeenCalledExactlyOnceWith('account-removal', {
    requestId: createHash('sha256').update(`orbis-main-account-removal-v1:${accepted.job.id}`).digest('hex'),
    replay: false,
  });
  expect(ownershipBroker.ownershipCheck).toHaveBeenCalledTimes(2);
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  accepted.start();
  await complete();
  expect(ownershipBroker.ownershipCheck).toHaveBeenCalledTimes(3);
  const preferenceCall = automatic.resetOrbisPreferences.mock.invocationCallOrder[0];
  const captureCall = captures.completeResetOwnership.mock.invocationCallOrder[0];
  if (preferenceCall === undefined || captureCall === undefined) throw new Error('Expected reset preference and capture custody calls');
  expect(ownershipBroker.ownershipCheck.mock.invocationCallOrder[2]).toBeLessThan(preferenceCall);
  expect(ownershipBroker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ purpose: 'account-removal' }), 'committed');
  expect(ownershipBroker.ownershipComplete.mock.invocationCallOrder[0]).toBeGreaterThan(captureCall);
});

it('Root refusal precedes reconciliation, reservation, journal creation and all reset writes', async () => {
  ownership.beginOwnership.mockRejectedValue(new Error('Root ownership unavailable'));
  await expect(service.accept(request, body('remove'))).rejects.toThrow('Root ownership unavailable');
  expect(bundles.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(captures.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(bundles.prepareResetOwnership).not.toHaveBeenCalled();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(await new ResetState(root).read()).toBeNull();
  expect(mutations).toEqual([]);
});

it('missing ownership issuer cannot silently bypass an account-removal guard', async () => {
  Object.defineProperty(service, 'ownership', { value: undefined });
  await expect(service.accept(request, body('remove'))).rejects.toMatchObject({ status: 503 });
  expect(bundles.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(captures.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
});

it('a failed initial Root check permits only unwritten retirement before any reconciliation', async () => {
  ownershipBroker.ownershipCheck.mockRejectedValue(new Error('Root authority changed'));
  await expect(service.accept(request, body('remove'))).rejects.toThrow();
  expect(bundles.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(captures.reconcileResetOwnership).not.toHaveBeenCalled();
  expect(ownershipBroker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'not-written');
  expect(await new ResetState(root).read()).toBeNull();
});

it('the worker rechecks Root inside its writer gate before changing any preference or account', async () => {
  ownershipBroker.ownershipCheck
    .mockImplementationOnce(async (grant) => grant)
    .mockImplementationOnce(async (grant) => grant)
    .mockRejectedValueOnce(new Error('Root authority changed before worker'));
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await vi.waitFor(() => expect(resetOperationActive()).toBe(false));
  expect((await new ResetState(root).read())?.phase).toBe('recovery');
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
  expect(keys.change).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
  expect(resetRecoveryHeld()).toBe(true);
});

it('lost Root completion retains committed SQL effects and recovery evidence without rolling accounts back', async () => {
  ownershipBroker.ownershipComplete.mockRejectedValue(new Error('Root completion reply lost'));
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await vi.waitFor(() => expect(resetOperationActive()).toBe(false));
  expect(records).toEqual([]);
  expect(receipts[0]?.id).toBe(accepted.job.id);
  expect((await new ResetState(root).read())?.phase).toBe('recovery');
  expect(resetRecoveryHeld()).toBe(true);
  expect(ownershipBroker.ownershipComplete).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'committed');
});

it('a retry preserves its original Root request and never retires earlier possible writes as not-written', async () => {
  ownershipBroker.ownershipCheck
    .mockImplementationOnce(async (grant) => grant)
    .mockImplementationOnce(async (grant) => grant)
    .mockRejectedValueOnce(new Error('Root unavailable before worker'));
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await vi.waitFor(() => expect(resetOperationActive()).toBe(false));
  status.mockResolvedValue({ state: 'resetting' });
  ownershipBroker.ownershipCheck.mockRejectedValue(new Error('Root still unavailable'));
  await expect(service.accept(request, body('remove'), true)).rejects.toThrow();
  const expected = createHash('sha256').update(`orbis-main-account-removal-v1:${accepted.job.id}`).digest('hex');
  expect(ownership.beginOwnership).toHaveBeenLastCalledWith('account-removal', { requestId: expected, replay: true });
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
  expect(records).toHaveLength(1);
  expect(resetRecoveryHeld()).toBe(true);
});
it('keeps reset active until backup custody and the held drain have both finished', async () => {
  let finish!: () => void;
  bundles.completeResetOwnership.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const accepted = await service.accept(request, body('remove'));
  expect(resetOperationActive()).toBe(true);
  accepted.start();
  await vi.waitFor(() => expect(bundles.completeResetOwnership).toHaveBeenCalledOnce());
  try {
    expect((await new ResetState(root).read())?.phase).toBe('complete');
    expect(resetOperationActive()).toBe(true);
    expect(backupMaintenanceActive()).toBe(true);
  } finally {
    finish();
    await complete();
  }
  expect(resetOperationActive()).toBe(false);
});
it('recovers backup custody from a proven reset commit without deleting accounts a second time', async () => {
  bundles.completeResetOwnership.mockRejectedValueOnce(new Error('Fixture custody commit interruption'));
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await vi.waitFor(async () => {
    expect((await new ResetState(root).read())?.phase).toBe('recovery');
    await expect(fs.lstat(path.join(root, 'state/orbis-reset/operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  expect(backupMaintenanceActive()).toBe(true);
  expect(receipts).toHaveLength(1);
  const committedMutations = [...mutations];
  status.mockResolvedValue({ state: 'resetting' });
  bundles.completeResetOwnership.mockImplementation(async (_value: ResetJournal, verify: () => Promise<boolean>) => {
    expect(await verify()).toBe(true);
  });
  await service.resumePending();
  expect((await new ResetState(root).read())?.phase).toBe('complete');
  expect(mutations).toEqual(committedMutations);
  expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledTimes(1);
  expect(backupMaintenanceActive()).toBe(false);
});
it('withholds prepared backup custody at startup when the completed reset has no matching database receipt', async () => {
  const completed = { ...journal(), accounts: 'remove' as const, phase: 'complete' as const };
  await new ResetState(root).save(completed);
  bundles.completeResetOwnership.mockImplementation(async (_value: ResetJournal, verify: () => Promise<boolean>) => {
    if (!(await verify())) throw new Error('Missing receipt');
  });
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(true);
  expect(mutations).toEqual([]);
  expect(records).toHaveLength(1);
});
it('finishes interrupted capture ownership from the reset receipt without replaying account erasure', async () => {
  captures.completeResetOwnership.mockRejectedValueOnce(new Error('Fixture capture commit interruption'));
  const accepted = await service.accept(request, body('remove'));
  accepted.start();
  await vi.waitFor(async () => {
    expect((await new ResetState(root).read())?.phase).toBe('recovery');
    await expect(fs.lstat(path.join(root, 'state/orbis-reset/operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  const committed = [...mutations];
  expect(receipts).toHaveLength(1);
  expect(backupMaintenanceActive()).toBe(true);
  status.mockResolvedValue({ state: 'resetting' });
  captures.completeResetOwnership.mockImplementation(async (_value: ResetJournal, verify: () => Promise<boolean>) => {
    expect(await verify()).toBe(true);
  });
  await service.resumePending();
  expect((await new ResetState(root).read())?.phase).toBe('complete');
  expect(mutations).toEqual(committed);
  expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledTimes(1);
  expect(backupMaintenanceActive()).toBe(false);
});
it('preserves passkey authorization while reserving account-removal backup custody', async () => {
  passkeys.verifySensitive.mockResolvedValue(undefined);
  const accepted = await service.accept(request, {
    accounts: 'remove',
    confirmation: 'RESET ORBIS',
    method: 'passkey',
    challengeId: randomUUID(),
    response: {},
  });
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(passkeys.verifySensitive).toHaveBeenCalledWith(request, resetBinding('remove'), expect.any(Object));
  expect(bundles.prepareResetOwnership).toHaveBeenCalledWith(expect.objectContaining({ id: accepted.job.id, accounts: 'remove' }));
  accepted.start();
  await complete();
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
it('treats an absent reset directory as idle while rejecting an existing reset under a writable state directory', async () => {
  await fs.mkdir(path.join(root, 'state'), { mode: 0o777, recursive: true });
  await fs.chmod(path.join(root, 'state'), 0o777);
  expect(await new ResetState(root).read()).toBeNull();
  await fs.mkdir(path.join(root, 'state/orbis-reset'), { mode: 0o700 });
  await expect(new ResetState(root).read()).rejects.toThrow('Reset storage needs local review');
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

it('SQL-receipt startup finalization neither replays account removal nor retires Root authority', async () => {
  status.mockResolvedValue({ state: 'resetting' });
  const pending = { ...journal(), accounts: 'remove' as const };
  records = [];
  receipts.push({ id: pending.id, completedAt: 1 });
  await new ResetState(root).save(pending);
  await service.resumePending();
  expect((await new ResetState(root).read())?.phase).toBe('complete');
  expect(ownership.beginOwnership).not.toHaveBeenCalled();
  expect(ownershipBroker.ownershipCheck).not.toHaveBeenCalled();
  expect(ownershipBroker.ownershipComplete).not.toHaveBeenCalled();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(keys.change).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
});
it('binds passkey authorization to the exact keep/remove choice', () => {
  expect(resetBinding('keep')).not.toBe(resetBinding('remove'));
});

it.each(['prepared', 'complete'] as const)('holds an archive-backed %s journal without using a legacy SQL receipt', async (phase) => {
  const source = { ...journal(), accounts: 'remove' as const };
  if (source.version !== 1) throw new Error('Legacy fixture required');
  const pending = {
    ...archiveBackedResetJournal(source, {
      format: 'orbis-reset-safety-commitment',
      version: 1,
      resetId: source.id,
      backupId: randomUUID(),
      accounts: source.accounts,
      users: source.users,
      selectionSha256: 'a'.repeat(64),
      fullScopeSha256: 'b'.repeat(64),
      exportInventorySha256: 'c'.repeat(64),
      targetInventorySha256: 'd'.repeat(64),
      sha256: 'e'.repeat(64),
      bytes: 1024,
    }),
    phase,
  };
  const store = new ResetState(root);
  await store.save(pending);
  receipts.push({ id: pending.id, completedAt: 1 });
  status.mockResolvedValue({ state: 'resetting' });
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(true);
  await service.resumePending();
  expect(await store.read()).toEqual(pending);
  expect(bundles.completeResetOwnership).not.toHaveBeenCalled();
  expect(captures.completeResetOwnership).not.toHaveBeenCalled();
  expect(automatic.resetOrbisPreferences).not.toHaveBeenCalled();
  expect(keys.change).not.toHaveBeenCalled();
  expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
  expect(mutations).toEqual([]);
  expect(records).toHaveLength(1);
  for (const recovery of [false, true]) await expect(service.accept(request, body('remove'), recovery)).rejects.toThrow('archive');
  expect(await store.read()).toEqual(pending);
  expect(bundles.reconcileResetOwnership).not.toHaveBeenCalled();
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
