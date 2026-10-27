import { afterEach, expect, it, vi } from 'vitest';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { acquireBackupMaintenance, setBackupRecoveryRequired } from '@/common/backup-maintenance';

afterEach(() => setBackupRecoveryRequired(false));
it.each([
  ['restartRunningApps', 'running', 'startApp'],
  ['startAllApps', 'stopped', 'startApp'],
  ['stopAllApps', 'running', 'stopApp'],
  ['backupAllApps', 'running', 'backupApp'],
  ['restartAllApps', 'running', 'restartApp'],
] as const)('holds admission through the complete %s loop, including the app lookup', async (method, status, action) => {
  let lookup: (value: unknown) => void = () => undefined;
  let complete: () => void = () => undefined;
  const operation = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const actor = Object.assign(Object.create(AppLifecycleService.prototype), {
    appRepository: {
      getApps: vi.fn(
        () =>
          new Promise((resolve) => {
            lookup = resolve;
          }),
      ),
    },
    logger: { warn: vi.fn() },
    [action]: operation,
  }) as AppLifecycleService;
  const work = actor[method]();
  let acquired = false;
  const waiting = acquireBackupMaintenance(new AbortController().signal).then((release) => {
    acquired = true;
    return release;
  });
  await Promise.resolve();
  expect(acquired).toBe(false);
  lookup([{ appName: 'fixture', appStoreSlug: 'store', status }]);
  await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
  expect(acquired).toBe(false);
  complete();
  await work;
  const release = await waiting;
  expect(acquired).toBe(true);
  release();
});
