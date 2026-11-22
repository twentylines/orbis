import fs from 'node:fs/promises';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupRestoreActivationService } from './backup-restore-activation.service';
import { readRestoreOperation } from './backup-restore-runtime';
import { captureRestoreStartupRole, restoreStartupRole, retainedBootstrapStartup } from './backup-restore-startup';
import { releaseRestoreInstallationMode } from '@/common/installation-mode';
import { acquireBackupMaintenance, coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { RetainedRootTransaction } from './time-machine-retained-root-client';
import { finishRetainedNormalBootstrap } from './backup-retained-normal-bootstrap';
import { verifyRetainedCandidateApps } from './time-machine-retained-app-result';

vi.mock('./backup-restores.service', () => ({ BackupRestoresService: class {} }));
vi.mock('./backup-restore-journal', () => ({ BackupRestoreJournal: { active: vi.fn(), latest: vi.fn() } }));
const candidateAppEffect = vi.fn();
vi.mock('./backup-restore-runtime', () => ({
  readRestoreOperation: vi.fn(),
  BackupRestoreDockerRuntime: class {
    candidateAppEffect = candidateAppEffect;
  },
}));
vi.mock('./backup-restore-startup', () => ({
  restoreStartupRole: vi.fn(),
  captureRestoreStartupRole: vi.fn(),
  retainedBootstrapStartup: vi.fn().mockReturnValue(false),
  setRetainedBootstrapStartup: vi.fn(),
}));
vi.mock('@/common/installation-mode', () => ({
  releaseRestoreInstallationMode: vi.fn(),
  installationMode: vi.fn().mockReturnValue({ phase: 'normal', transactionId: null }),
}));
vi.mock('@/common/backup-maintenance', () => ({
  acquireBackupMaintenance: vi.fn(),
  setRestoreRecoveryRequired: vi.fn(),
  coreCaptureRecoveryRequired: vi.fn().mockReturnValue(false),
}));
vi.mock('./time-machine-retained-root-client', () => ({ RetainedRootTransaction: { read: vi.fn() } }));
vi.mock('./backup-retained-normal-bootstrap', () => ({ finishRetainedNormalBootstrap: vi.fn() }));
vi.mock('./time-machine-retained-app-result', () => ({ verifyRetainedCandidateApps: vi.fn() }));
vi.mock('@/common/restoration-root-status', () => ({ readRootRestorationState: vi.fn().mockResolvedValue('idle') }));

const candidateId = 'a'.repeat(64);
const transactionId = 'f92e8862-38b5-4e81-bc84-f9131944872d';
const appUrn = 'photos:fixture-store';
const selected = { id: 17, appUrn };

function journal(phase = 'committing', decision: string | null = 'commit', controller = candidateId) {
  return { directory: '/private/transaction', state: { id: transactionId, phase, decision, candidateController: controller } };
}

function app(status: string, appName = 'photos', appStoreSlug = 'fixture-store') {
  return { id: selected.id, status, appName, appStoreSlug };
}

function createService(
  options: {
    status?: string;
    appRow?: unknown;
    appRows?: readonly unknown[];
    containers?: readonly { Id: string }[];
    inspect?: (id: string) => Promise<{ State: { Running: boolean; Restarting?: boolean; Paused?: boolean; Health?: { Status: string } } }>;
  } = {},
) {
  const appRows = options.appRows ?? [options.appRow ?? app(options.status ?? 'running')];
  const getAppById = vi.fn(async (id: number) => {
    const row = appRows.find((item) => (item as { id: number }).id === id) as { status?: string } | undefined;
    if (!row) return null;
    return row;
  });
  const startEffect = vi.fn();
  const startApp = vi.fn(async (_urn, _id, _appId, start) => start(startEffect));
  const updateAppById = vi.fn();
  const containers = [...(options.containers ?? [{ Id: 'app-container' }])];
  const listContainers = vi.fn().mockResolvedValue(containers);
  const inspect = options.inspect ?? (async () => ({ State: { Running: true, Health: { Status: 'healthy' } } }));
  const getContainer = vi.fn((id: string) => ({ inspect: () => inspect(id) }));
  const startRetainedSettlement = vi.fn().mockResolvedValue(undefined);
  const service = new BackupRestoreActivationService(
    { getAppById, updateAppById } as never,
    { resumeRestoredApp: startApp } as never,
    { startRetainedSettlement } as never,
    { listContainers, getContainer } as never,
    { resumeRetainedAfterSettlement: vi.fn() } as never,
  );
  return { service, getAppById, startApp, startEffect, updateAppById, listContainers, getContainer, startRetainedSettlement };
}

beforeEach(() => {
  candidateAppEffect.mockImplementation(async (_host, _urn, effect) => effect());
  vi.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('absent'), { code: 'ENOENT' }));
  vi.mocked(coreCaptureRecoveryRequired).mockReturnValue(false);
  vi.mocked(restoreStartupRole).mockReturnValue('candidate');
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(journal() as never);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(undefined);
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  vi.mocked(readRestoreOperation).mockResolvedValue({ id: transactionId, resumeApps: [selected] } as never);
  vi.mocked(releaseRestoreInstallationMode).mockReturnValue(true);
  vi.spyOn(os, 'hostname').mockReturnValue(candidateId.slice(0, 12));
});

it('keeps restore activation polling stopped during a core capture hold', () => {
  vi.useFakeTimers();
  vi.mocked(coreCaptureRecoveryRequired).mockReturnValue(true);
  const { service } = createService();
  service.onModuleInit();
  expect(vi.getTimerCount()).toBe(0);
  expect(BackupRestoreJournal.active).not.toHaveBeenCalled();
  service.onModuleDestroy();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(['ordinary', 'verify'] as const)('does nothing on the %s startup role', async (role) => {
  vi.mocked(restoreStartupRole).mockReturnValue(role);
  const { service, getAppById, startApp, listContainers } = createService();

  await expect(service.resumeApps()).resolves.toBeUndefined();

  expect(BackupRestoreJournal.active).not.toHaveBeenCalled();
  expect(readRestoreOperation).not.toHaveBeenCalled();
  expect(getAppById).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
  expect(listContainers).not.toHaveBeenCalled();
});

it('does not start user-stopped apps after a committed restore has already completed', async () => {
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(journal('completed') as never);
  const { service, getAppById, startApp } = createService({ status: 'stopped' });

  await expect(service.resumeApps()).resolves.toBeUndefined();

  expect(readRestoreOperation).not.toHaveBeenCalled();
  expect(getAppById).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
});

it('refuses a hold discovered after command preparation at the actual start callback', async () => {
  candidateAppEffect.mockImplementationOnce(async (_host, _urn, effect) => effect()).mockRejectedValueOnce(new Error('Late hold'));
  const { service, startApp, startEffect, updateAppById } = createService({ status: 'stopped' });
  await expect(service.resumeApps()).rejects.toThrow('Late hold');
  expect(startApp).toHaveBeenCalledOnce();
  expect(startEffect).not.toHaveBeenCalled();
  expect(updateAppById).not.toHaveBeenCalled();
});

it('refuses a retained request before using the direct app start path', async () => {
  vi.mocked(fs.lstat).mockResolvedValue({} as never);
  const { service, startApp } = createService({ status: 'stopped' });
  await expect(service.resumeApps()).rejects.toThrow('protected app activation');
  expect(startApp).not.toHaveBeenCalled();
  expect(readRestoreOperation).not.toHaveBeenCalled();
});

it('releases installer mode only after the matching candidate journal completes, then stops polling', async () => {
  vi.useFakeTimers();
  const { service, startRetainedSettlement } = createService();
  await service.resumeApps();
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();

  service.onModuleInit();
  await vi.advanceTimersByTimeAsync(1000);
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();

  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(journal('completed') as never);
  await vi.advanceTimersByTimeAsync(1000);
  expect(releaseRestoreInstallationMode).toHaveBeenCalledExactlyOnceWith(transactionId);
  expect(captureRestoreStartupRole).toHaveBeenCalledExactlyOnceWith('ordinary');
  expect(startRetainedSettlement).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(5000);
  expect(BackupRestoreJournal.active).toHaveBeenCalledTimes(3);
});

it('prepares while held and activates the scoped continuation only after acknowledgement', async () => {
  vi.useFakeTimers();
  const value = { ...journal('completed'), directory: '/private/transaction' };
  const release = vi.fn();
  vi.mocked(acquireBackupMaintenance).mockResolvedValue(release);
  const { service, startRetainedSettlement } = createService();
  const prepare = vi.fn().mockResolvedValue(undefined);
  const activate = vi.fn();
  service.configureRetainedContinuation({ prepare, activate });
  await service.resumeApps();
  service.onModuleInit();
  vi.mocked(readRootRestorationState).mockResolvedValue('checking');
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({
    terminalProof: vi.fn().mockResolvedValue({ proofSha256: 'proof' }),
    normalBootstrapStatus: vi.fn().mockResolvedValue({ required: true }),
  } as never);
  vi.mocked(finishRetainedNormalBootstrap).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(value as never);
  await vi.advanceTimersByTimeAsync(1000);
  expect(startRetainedSettlement).toHaveBeenCalledOnce();
  expect(finishRetainedNormalBootstrap).not.toHaveBeenCalled();
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(value as never);
  await vi.advanceTimersByTimeAsync(1000);
  expect(finishRetainedNormalBootstrap).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledBefore(vi.mocked(finishRetainedNormalBootstrap));
  expect(finishRetainedNormalBootstrap).toHaveBeenCalledBefore(activate);
  expect(activate).toHaveBeenCalledBefore(release);
  expect(releaseRestoreInstallationMode).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it('keeps its hold when scoped preparation fails before acknowledgement', async () => {
  vi.useFakeTimers();
  const value = { ...journal('completed'), directory: '/private/transaction' };
  const release = vi.fn();
  vi.mocked(acquireBackupMaintenance).mockResolvedValue(release);
  const { service } = createService();
  service.configureRetainedContinuation({ prepare: vi.fn().mockRejectedValue(new Error('unavailable')), activate: vi.fn() });
  await service.resumeApps();
  service.onModuleInit();
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(value as never);
  vi.mocked(readRootRestorationState).mockResolvedValue('checking');
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({
    terminalProof: vi.fn().mockResolvedValue({ proofSha256: 'proof' }),
    normalBootstrapStatus: vi.fn().mockResolvedValue({ required: true }),
  } as never);
  await vi.advanceTimersByTimeAsync(1000);
  expect(finishRetainedNormalBootstrap).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();
});

it('retries scoped activation after acknowledgement without losing its hold', async () => {
  vi.useFakeTimers();
  const value = { ...journal('completed'), directory: '/private/transaction' };
  const release = vi.fn();
  const activate = vi.fn().mockImplementationOnce(() => {
    throw new Error('interrupted');
  });
  vi.mocked(acquireBackupMaintenance).mockResolvedValue(release);
  const { service } = createService();
  service.configureRetainedContinuation({ prepare: vi.fn().mockResolvedValue(undefined), activate });
  await service.resumeApps();
  service.onModuleInit();
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(value as never);
  vi.mocked(readRootRestorationState).mockResolvedValue('checking');
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({
    terminalProof: vi.fn().mockResolvedValue({ proofSha256: 'proof' }),
    normalBootstrapStatus: vi.fn().mockResolvedValue({ required: true }),
  } as never);
  vi.mocked(finishRetainedNormalBootstrap).mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(release).not.toHaveBeenCalled();
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  await vi.advanceTimersByTimeAsync(1000);
  expect(acquireBackupMaintenance).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
});

it('retains the same hold across a lost acknowledgement and finishes after root becomes idle', async () => {
  vi.useFakeTimers();
  const value = { ...journal('completed'), directory: '/private/transaction' };
  const release = vi.fn();
  vi.mocked(acquireBackupMaintenance).mockResolvedValue(release);
  const { service } = createService();
  service.configureRetainedContinuation({ prepare: vi.fn().mockResolvedValue(undefined), activate: vi.fn() });
  await service.resumeApps();
  service.onModuleInit();
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(value as never);
  vi.mocked(readRootRestorationState).mockResolvedValue('checking');
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({
    terminalProof: vi.fn().mockResolvedValue({ proofSha256: 'proof' }),
    normalBootstrapStatus: vi.fn().mockResolvedValue({ required: true }),
  } as never);
  vi.mocked(finishRetainedNormalBootstrap).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce(undefined);
  await vi.advanceTimersByTimeAsync(1000);
  expect(acquireBackupMaintenance).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  await vi.advanceTimersByTimeAsync(1000);
  expect(acquireBackupMaintenance).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  ['missing journal', undefined],
  ['non-commit decision', journal('committing', 'rollback')],
  ['wrong candidate controller', journal('committing', 'commit', 'b'.repeat(64))],
] as const)('rejects an unsafe recovery journal: %s', async (_name, active) => {
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(active as never);
  const { service, getAppById, startApp } = createService({ status: 'stopped' });

  await expect(service.resumeApps()).rejects.toThrow();

  expect(getAppById).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
});

it('uses only protected Engine result verification for retained app activation', async () => {
  vi.mocked(retainedBootstrapStartup).mockReturnValue(true);
  const { service, startApp, listContainers } = createService();
  try {
    await expect(service.resumeApps()).resolves.toBeUndefined();
    expect(verifyRetainedCandidateApps).toHaveBeenCalledOnce();
    expect(startApp).not.toHaveBeenCalled();
    expect(listContainers).not.toHaveBeenCalled();
  } finally {
    vi.mocked(retainedBootstrapStartup).mockReturnValue(false);
  }
});

it('validates each selected database ID against its recorded app URN before starting it', async () => {
  const { service, getAppById, startApp } = createService({ appRow: app('stopped', 'other-app') });

  await expect(service.resumeApps()).rejects.toThrow();

  expect(getAppById).toHaveBeenCalledExactlyOnceWith(selected.id);
  expect(startApp).not.toHaveBeenCalled();
});

it('starts only selected stopped apps and waits until their containers are running and healthy', async () => {
  const selectedStopped = app('stopped');
  const unselected = { id: 18, appName: 'other', appStoreSlug: 'fixture-store', status: 'stopped' };
  let inspections = 0;
  const { service, getAppById, startApp, startEffect, updateAppById, getContainer } = createService({
    appRows: [selectedStopped, unselected],
    inspect: async () => {
      inspections++;
      return inspections === 1
        ? { State: { Running: false, Health: { Status: 'starting' } } }
        : { State: { Running: true, Health: { Status: 'healthy' } } };
    },
  });

  await expect(service.resumeApps()).resolves.toBeUndefined();

  expect(getAppById).toHaveBeenCalledTimes(3);
  expect(getAppById).toHaveBeenNthCalledWith(1, selected.id);
  expect(getAppById).toHaveBeenNthCalledWith(2, selected.id);
  expect(getAppById).toHaveBeenNthCalledWith(3, selected.id);
  expect(startApp).toHaveBeenCalledExactlyOnceWith(appUrn, transactionId, selected.id, expect.any(Function));
  expect(startEffect).toHaveBeenCalledOnce();
  expect(updateAppById).toHaveBeenCalledExactlyOnceWith(selected.id, { status: 'running', pendingRestart: false });
  expect(getContainer).toHaveBeenCalledTimes(2);
  expect(inspections).toBe(2);
});

it('does not duplicate a start for an already-running selected app', async () => {
  const { service, startApp, listContainers } = createService({ status: 'running' });

  await expect(service.resumeApps()).resolves.toBeUndefined();

  expect(startApp).not.toHaveBeenCalled();
  expect(listContainers).toHaveBeenCalledExactlyOnceWith({
    all: true,
    filters: { label: ['com.docker.compose.project=photos_fixture-store'] },
  });
});

it('refuses a missing selected row before dispatch', async () => {
  const { service, startEffect } = createService({ appRows: [] });
  await expect(service.resumeApps()).rejects.toThrow();
  expect(startEffect).not.toHaveBeenCalled();
});

it.each(['missing', 'unhealthy'])('times out when the app remains %s', async (condition) => {
  const { service, updateAppById } = createService({
    containers: condition === 'missing' ? [] : [{ Id: 'app-container' }],
    inspect: async () => ({ State: { Running: true, Health: { Status: 'unhealthy' } } }),
  });
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1)
    .mockReturnValue(15 * 60_000);
  try {
    await expect(service.resumeApps()).rejects.toThrow('Some restored apps could not start');
    expect(updateAppById).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
