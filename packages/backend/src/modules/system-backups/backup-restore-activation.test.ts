import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupRestoreActivationService } from './backup-restore-activation.service';
import { readRestoreOperation } from './backup-restore-runtime';
import { captureRestoreStartupRole, restoreStartupRole } from './backup-restore-startup';
import { releaseRestoreInstallationMode } from '@/common/installation-mode';

vi.mock('./backup-restore-journal', () => ({ BackupRestoreJournal: { active: vi.fn() } }));
vi.mock('./backup-restore-runtime', () => ({ readRestoreOperation: vi.fn() }));
vi.mock('./backup-restore-startup', () => ({ restoreStartupRole: vi.fn(), captureRestoreStartupRole: vi.fn() }));
vi.mock('@/common/installation-mode', () => ({ releaseRestoreInstallationMode: vi.fn() }));

const candidateId = 'a'.repeat(64);
const transactionId = 'f92e8862-38b5-4e81-bc84-f9131944872d';
const appUrn = 'photos:fixture-store';
const selected = { id: 17, appUrn };

function journal(phase = 'committing', decision: string | null = 'commit', controller = candidateId) {
  return { state: { id: transactionId, phase, decision, candidateController: controller } };
}

function app(status: string, appName = 'photos', appStoreSlug = 'fixture-store') {
  return { id: selected.id, status, appName, appStoreSlug };
}

function createService(
  options: {
    status?: string;
    appRow?: unknown;
    appRows?: readonly unknown[];
    statusSequence?: readonly string[];
    containers?: readonly { Id: string }[];
    inspect?: (id: string) => Promise<{ State: { Running: boolean; Restarting?: boolean; Paused?: boolean; Health?: { Status: string } } }>;
  } = {},
) {
  const appRows = options.appRows ?? [options.appRow ?? app(options.status ?? 'running')];
  let reads = 0;
  const getAppById = vi.fn(async (id: number) => {
    const row = appRows.find((item) => (item as { id: number }).id === id) as { status?: string } | undefined;
    if (!row) return null;
    const status = options.statusSequence?.[Math.min(reads, options.statusSequence.length - 1)];
    reads++;
    return status ? { ...row, status } : row;
  });
  const startApp = vi.fn().mockResolvedValue(undefined);
  const containers = [...(options.containers ?? [{ Id: 'app-container' }])];
  const listContainers = vi.fn().mockResolvedValue(containers);
  const inspect = options.inspect ?? (async () => ({ State: { Running: true, Health: { Status: 'healthy' } } }));
  const getContainer = vi.fn((id: string) => ({ inspect: () => inspect(id) }));
  const service = new BackupRestoreActivationService({ getAppById } as never, { startApp } as never, { listContainers, getContainer } as never);
  return { service, getAppById, startApp, listContainers, getContainer };
}

beforeEach(() => {
  vi.mocked(restoreStartupRole).mockReturnValue('candidate');
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(journal() as never);
  vi.mocked(readRestoreOperation).mockResolvedValue({ resumeApps: [selected] } as never);
  vi.mocked(releaseRestoreInstallationMode).mockReturnValue(true);
  vi.spyOn(os, 'hostname').mockReturnValue(candidateId.slice(0, 12));
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

it('releases installer mode only after the matching candidate journal completes, then stops polling', async () => {
  vi.useFakeTimers();
  const { service } = createService();
  await service.resumeApps();
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();

  service.onModuleInit();
  await vi.advanceTimersByTimeAsync(1000);
  expect(releaseRestoreInstallationMode).not.toHaveBeenCalled();

  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(journal('completed') as never);
  await vi.advanceTimersByTimeAsync(1000);
  expect(releaseRestoreInstallationMode).toHaveBeenCalledExactlyOnceWith(transactionId);
  expect(captureRestoreStartupRole).toHaveBeenCalledExactlyOnceWith('ordinary');

  await vi.advanceTimersByTimeAsync(5000);
  expect(BackupRestoreJournal.active).toHaveBeenCalledTimes(3);
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
  const { service, getAppById, startApp, getContainer } = createService({
    appRows: [selectedStopped, unselected],
    statusSequence: ['stopped', 'running'],
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
  expect(startApp).toHaveBeenCalledExactlyOnceWith({ appUrn });
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

it.each([
  ['missing app row', { appRow: undefined, appRows: [] }],
  ['app still stopped', { appRow: app('stopped') }],
  ['app container missing', { statusSequence: ['running', 'stopped'], containers: [] }],
] as const)('does not report success when recovery is incomplete: %s', async (_name, options) => {
  const { service } = createService(options);

  await expect(service.resumeApps()).rejects.toThrow();
});

it('does not report success for an unhealthy container', async () => {
  let appReads = 0;
  const current = vi.fn(async (_id: number) => {
    appReads++;
    return appReads === 1 ? app('running') : app('stopped');
  });
  const startApp = vi.fn();
  const service = new BackupRestoreActivationService(
    { getAppById: current } as never,
    { startApp } as never,
    {
      listContainers: vi.fn().mockResolvedValue([{ Id: 'app-container' }]),
      getContainer: vi.fn(() => ({ inspect: async () => ({ State: { Running: true, Health: { Status: 'unhealthy' } } }) })),
    } as never,
  );

  await expect(service.resumeApps()).rejects.toThrow();
  expect(appReads).toBe(2);
});
