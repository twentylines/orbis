import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Test, type TestingModule } from '@nestjs/testing';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppsRepository } from '../apps/apps.repository';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppLifecycleService } from './app-lifecycle.service';
import { TasksService } from '../tasks/tasks.service';

describe('Interrupted restore lifecycle guards', () => {
  const appUrn = createAppUrn('demo', 'store');
  let module: TestingModule;
  let service: AppLifecycleService;
  let backups = mock<BackupManager>();
  let docker = mock<Dockerode>();
  let repository = mock<AppsRepository>();
  let factory = mock<AppLifecycleCommandFactory>();
  let release = vi.fn();
  const stopped = { State: { Running: false, Paused: false } } as Dockerode.ContainerInspectInfo;

  beforeEach(async () => {
    backups = mock<BackupManager>();
    docker = mock<Dockerode>();
    repository = mock<AppsRepository>();
    factory = mock<AppLifecycleCommandFactory>();
    release = vi.fn();
    module = await Test.createTestingModule({ providers: [AppLifecycleService] })
      .useMocker((token) => {
        if (token === BackupManager) return backups;
        if (token === DOCKERODE) return docker;
        if (token === AppsRepository) return repository;
        if (token === AppLifecycleCommandFactory) return factory;
        if (token === APP_ASYNC_MUTEX) return { acquire: vi.fn().mockResolvedValue(release) };
        return mock();
      })
      .compile();
    service = module.get(AppLifecycleService);
    backups.getPendingRestores.mockResolvedValue([appUrn]);
    backups.hasPendingRestore.mockResolvedValue(true);
    docker.listContainers.mockResolvedValue([]);
  });

  afterEach(async () => {
    await module.close();
    vi.unstubAllEnvs();
  });

  it('refuses installer resume while an interrupted restore is present', async () => {
    await expect(service.requireNoPendingRestores()).rejects.toThrow('An interrupted restore needs recovery');
    expect(backups.recoverRestore).not.toHaveBeenCalled();
    expect(docker.listContainers).not.toHaveBeenCalled();
    backups.getPendingRestores.mockResolvedValue([]);
    await expect(service.requireNoPendingRestores()).resolves.toBeUndefined();
  });

  it('holds direct lifecycle dispatch before task changes, locks or Docker commands', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    const reply = vi.fn();
    await service.invokeCommand({ command: 'start', appUrn, form: {}, requestId: 'f92e8862-38b5-4e81-bc84-f9131944872d' }, reply);
    expect(reply).toHaveBeenCalledWith({ success: false, message: 'Installation is in progress. Wait for the installer to finish.' });
    expect(module.get(TasksService).enqueue).not.toHaveBeenCalled();
    expect(module.get(APP_ASYNC_MUTEX).acquire).not.toHaveBeenCalled();
    expect(factory.createCommand).not.toHaveBeenCalled();
  });

  it('stops and verifies running app containers before replacing interrupted files', async () => {
    const order: string[] = [];
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValueOnce({ State: { Running: true, Paused: true } } as Dockerode.ContainerInspectInfo).mockResolvedValue(stopped);
    container.unpause.mockImplementation(async () => {
      order.push('unpaused');
    });
    container.stop.mockImplementation(async () => {
      order.push('stopped');
    });
    backups.recoverRestore.mockImplementation(async () => {
      order.push('recovered');
    });
    repository.getAppByUrn.mockResolvedValue({ id: 42 } as never);
    await service.recoverInterruptedRestores();
    expect(order).toEqual(['unpaused', 'stopped', 'recovered']);
    expect(container.inspect).toHaveBeenCalledTimes(2);
    expect(docker.listContainers).toHaveBeenCalledExactlyOnceWith({ all: true, filters: { label: ['com.docker.compose.project=demo_store'] } });
    expect(backups.recoverRestore).toHaveBeenCalledExactlyOnceWith(appUrn);
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves the journal and releases its lock when a container cannot be stopped', async () => {
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValue({ State: { Running: true, Paused: false } } as Dockerode.ContainerInspectInfo);
    container.stop.mockRejectedValue(new Error('Docker stop failed'));
    await expect(service.recoverInterruptedRestores()).rejects.toThrow('Docker stop failed');
    expect(backups.recoverRestore).not.toHaveBeenCalled();
    expect(repository.updateAppById).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuses recovery if Docker reports a container still running after stop', async () => {
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValue({ State: { Running: true, Paused: false } } as Dockerode.ContainerInspectInfo);
    container.stop.mockResolvedValue(undefined);
    await expect(service.recoverInterruptedRestores()).rejects.toThrow('must be stopped');
    expect(backups.recoverRestore).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('stops a restarting container and refuses file recovery until its restart loop ends', async () => {
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValue({ State: { Running: false, Restarting: true, Paused: false } } as Dockerode.ContainerInspectInfo);
    container.stop.mockResolvedValue(undefined);
    await expect(service.recoverInterruptedRestores()).rejects.toThrow('must be stopped');
    expect(container.stop).toHaveBeenCalledExactlyOnceWith({ t: 30 });
    expect(backups.recoverRestore).not.toHaveBeenCalled();
  });

  it('accepts an already-stopped response only after independently inspecting the stopped container', async () => {
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockResolvedValueOnce({ State: { Running: true } } as Dockerode.ContainerInspectInfo).mockResolvedValue(stopped);
    container.stop.mockRejectedValue({ statusCode: 304 });
    await service.recoverInterruptedRestores();
    expect(container.inspect).toHaveBeenCalledTimes(2);
    expect(backups.recoverRestore).toHaveBeenCalledExactlyOnceWith(appUrn);
  });

  it('recovers safely if a listed container was removed before its inspection', async () => {
    const container = mock<Dockerode.Container>();
    docker.listContainers.mockResolvedValue([{ Id: 'app-container' } as Dockerode.ContainerInfo]);
    docker.getContainer.mockReturnValue(container);
    container.inspect.mockRejectedValue({ statusCode: 404 });
    await service.recoverInterruptedRestores();
    expect(container.stop).not.toHaveBeenCalled();
    expect(backups.recoverRestore).toHaveBeenCalledExactlyOnceWith(appUrn);
  });

  it('rejects queued app commands before file access when recovery remains incomplete', async () => {
    backups.recoverRestore.mockRejectedValue(new Error('Original directories are retained; recovery storage is unavailable'));
    const data = { appUrn, command: 'start', requestId: 'recovery-test', form: {} } as Parameters<AppLifecycleService['invokeCommand']>[0];
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply);
    expect(factory.createCommand).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      success: false,
      message: 'Error: Original directories are retained; recovery storage is unavailable',
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
import { createAppUrn } from '@/common/helpers/app-helpers';
