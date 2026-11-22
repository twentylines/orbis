import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { type } from 'arktype';
import { beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import { AppEventsQueue, appEventSchema } from '@/modules/queue/entities/app-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { AppLifecycleCommandFactory } from '../app-lifecycle-command.factory';
import { UninstallAppHandler } from '../handlers/uninstall-app.handler';
import { StatusManagerService } from '../services/status-manager.service';

const appUrn = createAppUrn('demo', 'store');
const requestId = '00000000-0000-4000-8000-000000000001';
let files: ReturnType<typeof mock<AppFilesManager>>;
let backups: ReturnType<typeof mock<BackupManager>>;
let docker: ReturnType<typeof mock<DockerService>>;
let apps: ReturnType<typeof mock<AppsRepository>>;
let queue: ReturnType<typeof mock<AppEventsQueue>>;
let status: ReturnType<typeof mock<StatusManagerService>>;
let factory: AppLifecycleCommandFactory;
let engine: ReturnType<typeof mock<Dockerode>>;
let finish: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
  files = mock<AppFilesManager>();
  backups = mock<BackupManager>();
  docker = mock<DockerService>();
  engine = mock<Dockerode>();
  engine.listContainers.mockResolvedValue([]);
  finish = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  docker.prepareAppUninstallCleanup.mockResolvedValue(finish);
  apps = mock<AppsRepository>();
  queue = mock<AppEventsQueue>();
  status = mock<StatusManagerService>();
  apps.getAppByUrn.mockResolvedValue(createMockApp({ appName: 'demo', appStoreSlug: 'store' }));
  queue.publish.mockReturnValue(new Promise(() => {}));
  const providers = new Map<unknown, unknown>([
    [AppFilesManager, files],
    [BackupManager, backups],
    [DockerService, docker],
    [LoggerService, mock<LoggerService>()],
    [TasksService, mock<TasksService>()],
  ]);
  const ref = { get: (key: unknown) => providers.get(key) } as unknown as ModuleRef;
  factory = new AppLifecycleCommandFactory(ref, engine);
});

const event = (removeBackups?: boolean) =>
  appEventSchema.assert({ command: 'uninstall', appUrn, requestId, form: {}, ...(removeBackups === undefined ? {} : { removeBackups }) });

it('queues the selected choice without deleting archives until the guarded worker executes it', async () => {
  const handler = new UninstallAppHandler(apps, queue, status);
  await handler.execute(appUrn, { removeBackups: true });
  expect(backups.deleteAppBackupsByUrn).not.toHaveBeenCalled();
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
  expect(queue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'uninstall', appUrn, removeBackups: true }));
  const selected = queue.publish.mock.calls[0]?.[0];
  expect(selected).toBeDefined();
  const result = await factory.createCommand(appEventSchema.assert(selected)).execute(appUrn, {});
  expect(result.success).toBe(true);
  expect(backups.deleteAppBackupsByUrn).toHaveBeenCalledExactlyOnceWith(appUrn);
  expect(docker.requireAppImagePinUpdate.mock.invocationCallOrder[0]).toBeLessThan(backups.deleteAppBackupsByUrn.mock.invocationCallOrder[0] ?? 0);
  expect(files.deleteAppDataDir).toHaveBeenCalledExactlyOnceWith(appUrn);
  expect(engine.listContainers).toHaveBeenCalledExactlyOnceWith({ all: true, filters: { label: ['com.docker.compose.project=demo_store'] } });
  expect(docker.composeApp.mock.invocationCallOrder[0]).toBeLessThan(engine.listContainers.mock.invocationCallOrder[0] ?? 0);
  expect(engine.listContainers.mock.invocationCallOrder[0]).toBeLessThan(files.deleteAppDataDir.mock.invocationCallOrder[0] ?? 0);
  expect(files.deleteAppFolder.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0] ?? 0);
  expect(finish).toHaveBeenCalledOnce();
});

it.each([undefined, false])('preserves backups when the queued choice is %s', async (choice) => {
  expect((await factory.createCommand(event(choice)).execute(appUrn, {})).success).toBe(true);
  expect(backups.deleteAppBackupsByUrn).not.toHaveBeenCalled();
  expect(files.deleteAppFolder).toHaveBeenCalledExactlyOnceWith(appUrn);
});

it('preserves backups and app files when the worker refuses image/storage recovery admission', async () => {
  docker.requireAppImagePinUpdate.mockRejectedValue(new Error('Recovery must finish first.'));
  await expect(factory.createCommand(event(true)).execute(appUrn, {})).rejects.toThrow('Recovery must finish first.');
  expect(backups.deleteAppBackupsByUrn).not.toHaveBeenCalled();
  expect(docker.composeApp).not.toHaveBeenCalled();
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
});

it('does not remove the app when explicitly selected archive removal fails', async () => {
  backups.deleteAppBackupsByUrn.mockRejectedValue(new Error('Archive removal was refused.'));
  expect(await factory.createCommand(event(true)).execute(appUrn, {})).toMatchObject({ success: false, message: 'Archive removal was refused.' });
  expect(docker.composeApp).not.toHaveBeenCalled();
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
  expect(files.deleteAppDataDir).not.toHaveBeenCalled();
});

it('does not remove archives if the status transition refuses the request', async () => {
  status.transitionTo.mockRejectedValue(new Error('App is busy.'));
  await expect(new UninstallAppHandler(apps, queue, status).execute(appUrn, { removeBackups: true })).rejects.toThrow('App is busy.');
  expect(queue.publish).not.toHaveBeenCalled();
  expect(backups.deleteAppBackupsByUrn).not.toHaveBeenCalled();
});

it('validates the opt-in as a boolean in the queue contract', () => {
  expect(appEventSchema({ command: 'uninstall', appUrn, requestId, form: {}, removeBackups: 'yes' })).toBeInstanceOf(type.errors);
});

it('preserves app files and active pins when Docker shutdown fails', async () => {
  docker.composeApp.mockRejectedValue(new Error('Engine connection lost.'));
  expect(await factory.createCommand(event()).execute(appUrn, {})).toMatchObject({ success: false, message: 'Engine connection lost.' });
  expect(engine.listContainers).not.toHaveBeenCalled();
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
  expect(files.deleteAppDataDir).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
  expect(backups.deleteAppBackupsByUrn).not.toHaveBeenCalled();
});

it.each(['remaining', 'unavailable', 'invalid'])('preserves files and active pins when container removal is %s', async (state) => {
  if (state === 'remaining') engine.listContainers.mockResolvedValue([{ Id: 'remaining-child' }] as never);
  else if (state === 'invalid') engine.listContainers.mockResolvedValue(undefined as never);
  else engine.listContainers.mockRejectedValue(new Error('Engine unavailable.'));
  expect((await factory.createCommand(event()).execute(appUrn, {})).success).toBe(false);
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
  expect(files.deleteAppDataDir).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});

it('keeps installed metadata and pins if data removal fails', async () => {
  files.deleteAppDataDir.mockRejectedValue(new Error('Storage removal failed.'));
  expect((await factory.createCommand(event()).execute(appUrn, {})).success).toBe(false);
  expect(files.deleteAppFolder).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});

it('does not report success when active-pin cleanup fails', async () => {
  finish.mockRejectedValue(new Error('Retained record changed.'));
  expect(await factory.createCommand(event()).execute(appUrn, {})).toMatchObject({ success: false, message: 'Retained record changed.' });
});
