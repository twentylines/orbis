import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Test, type TestingModule } from '@nestjs/testing';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { BackupManager } from '@/modules/backups/backup.manager';
import { BackupsService } from '@/modules/backups/backups.service';
import { BackupsController } from '@/modules/backups/backups.controller';
import { BackupUploadStorage } from '@/modules/backups/backup-upload.storage';
import { LoggerService } from '@/core/logger/logger.service';
import { acquireBackupMaintenance, setBackupRecoveryRequired } from '@/common/backup-maintenance';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppJobService } from './services/app-job.service';
import { InstallAppHandler } from './handlers/install-app.handler';

const params = { appUrn: castAppUrn('fixture:store'), filename: 'saved.tar.gz' };
let module: TestingModule;
let service: AppLifecycleService;
let mutex: AsyncMutex;
let jobs: ReturnType<typeof mock<AppJobService>>;
let backups: ReturnType<typeof mock<BackupManager>>;
let installs: ReturnType<typeof mock<InstallAppHandler>>;
beforeEach(async () => {
  mutex = new AsyncMutex();
  jobs = mock<AppJobService>();
  backups = mock<BackupManager>();
  installs = mock<InstallAppHandler>();
  jobs.hasUnsettledJob.mockResolvedValue(false);
  backups.hasPendingRestore.mockResolvedValue(false);
  module = await Test.createTestingModule({ providers: [AppLifecycleService] })
    .useMocker((token) => {
      if (token === APP_ASYNC_MUTEX) return mutex;
      if (token === AppJobService) return jobs;
      if (token === BackupManager) return backups;
      if (token === InstallAppHandler) return installs;
      return mock();
    })
    .compile();
  service = module.get(AppLifecycleService);
});
afterEach(async () => {
  setBackupRecoveryRequired(false);
  vi.unstubAllEnvs();
  await module.close();
});

it('holds the app lifecycle lock through the idle checks and backup removal', async () => {
  jobs.hasUnsettledJob.mockImplementation(async () => {
    expect(mutex.resourceLocks.has(params.appUrn)).toBe(true);
    return false;
  });
  backups.deleteBackup.mockImplementation(async () => {
    expect(mutex.resourceLocks.has(params.appUrn)).toBe(true);
  });
  await service.deleteAppBackup(params);
  expect(backups.deleteBackup).toHaveBeenCalledExactlyOnceWith(params.appUrn, params.filename);
  expect(mutex.resourceLocks.size).toBe(0);
});

it('refuses a busy app without waiting for or deleting its backup', async () => {
  const release = await mutex.acquire(params.appUrn);
  try {
    await expect(service.deleteAppBackup(params)).rejects.toThrow('current app operation');
    expect(jobs.hasUnsettledJob).not.toHaveBeenCalled();
    expect(backups.deleteBackup).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

it.each(['job', 'restore'] as const)('preserves backups when an unfinished %s remains after restart', async (kind) => {
  if (kind === 'job') jobs.hasUnsettledJob.mockResolvedValue(true);
  else backups.hasPendingRestore.mockResolvedValue(true);
  await expect(service.deleteAppBackup(params)).rejects.toThrow('unfinished app operation');
  expect(backups.deleteBackup).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('keeps the backup when its install reservation is held', async () => {
  installs.requireNoInstallHold.mockRejectedValue(new Error('Install recovery is pending'));
  await expect(service.deleteAppBackup(params)).rejects.toThrow('Install recovery');
  expect(backups.deleteBackup).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it.each(['record', 'deletion'] as const)('releases app and maintenance locks after a %s failure', async (kind) => {
  if (kind === 'record') jobs.hasUnsettledJob.mockRejectedValue(new Error('Record unavailable'));
  else backups.deleteBackup.mockRejectedValue(new Error('Removal unavailable'));
  await expect(service.deleteAppBackup(params)).rejects.toThrow('unavailable');
  expect(mutex.resourceLocks.size).toBe(0);
  const release = await acquireBackupMaintenance(new AbortController().signal);
  release();
});

it('refuses deletion before app inspection while full-backup recovery is held', async () => {
  setBackupRecoveryRequired(true);
  await expect(service.deleteAppBackup(params)).rejects.toThrow('full backup');
  expect(jobs.hasUnsettledJob).not.toHaveBeenCalled();
  expect(backups.deleteBackup).not.toHaveBeenCalled();
  expect(mutex.resourceLocks.size).toBe(0);
});

it('refuses deletion while the installer holds the installation', async () => {
  vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', '00000000-0000-4000-8000-000000000001');
  vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
  await expect(service.deleteAppBackup(params)).rejects.toThrow('Installation is in progress');
  expect(backups.deleteBackup).not.toHaveBeenCalled();
});

it('routes the existing delete endpoint through the protected lifecycle service', async () => {
  const controller = new BackupsController(mock<BackupsService>(), service, mock<BackupUploadStorage>(), mock<LoggerService>());
  await controller.deleteAppBackup(params.appUrn, { filename: params.filename });
  expect(backups.deleteBackup).toHaveBeenCalledExactlyOnceWith(params.appUrn, params.filename);
});

it('rejects an invalid filename before it can reach backup deletion', async () => {
  const controller = new BackupsController(mock<BackupsService>(), service, mock<BackupUploadStorage>(), mock<LoggerService>());
  await expect(controller.deleteAppBackup(params.appUrn, { filename: '../saved.tar.gz' })).rejects.toThrow('Invalid backup filename');
  expect(backups.deleteBackup).not.toHaveBeenCalled();
});
