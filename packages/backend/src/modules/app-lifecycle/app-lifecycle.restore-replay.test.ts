import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { AppEventsQueue, type AppEvent } from '@/modules/queue/entities/app-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Test, type TestingModule } from '@nestjs/testing';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppLifecycleService } from './app-lifecycle.service';

describe('restore request replay protection', () => {
  let directory: string;
  let module: TestingModule | undefined;
  let config = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  let queue = mock<AppEventsQueue>();
  let backups = mock<BackupManager>();
  let factory = mock<AppLifecycleCommandFactory>();
  let docker = mock<Dockerode>();
  let execute = vi.fn();
  let mutex = new AsyncMutex();
  const event = (): AppEvent => ({
    requestId: randomUUID(),
    appUrn: 'demo:official' as AppEvent['appUrn'],
    command: 'restore',
    filename: 'demo.tar.gz',
    form: {},
  });

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-replay-'));
    config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    queue = mock<AppEventsQueue>();
    backups = mock<BackupManager>();
    factory = mock<AppLifecycleCommandFactory>();
    docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);
    execute = vi.fn().mockResolvedValue({ success: true, message: 'Restored' });
    factory.createCommand.mockReturnValue({ execute } as never);
    backups.hasPendingRestore.mockResolvedValue(false);
    mutex = new AsyncMutex();
    module = undefined;
  });

  afterEach(async () => {
    await module?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const boot = async () => {
    const tasks = new TasksService(config, logger);
    module = await Test.createTestingModule({ providers: [AppLifecycleService] })
      .useMocker((token) => {
        if (token === AppEventsQueue) return queue;
        if (token === TasksService) return tasks;
        if (token === BackupManager) return backups;
        if (token === DOCKERODE) return docker;
        if (token === AppLifecycleCommandFactory) return factory;
        if (token === APP_ASYNC_MUTEX) return mutex;
        return mock();
      })
      .compile();
    const deliver = async (data: AppEvent, redelivered = false) => {
      const callback = queue.onEvent.mock.calls[0]?.[0];
      if (!callback) throw new Error('Lifecycle consumer was not registered');
      const reply = vi.fn().mockResolvedValue(undefined);
      await callback({ ...data, eventId: data.requestId }, reply, { redelivered });
      return reply;
    };
    return { tasks, deliver };
  };

  it('executes a new restore and records its outcome', async () => {
    const { tasks, deliver } = await boot();
    const data = event();
    const reply = await deliver(data);
    expect(execute).toHaveBeenCalledExactlyOnceWith(data.appUrn, data.form);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ success: true, message: 'Restored' });
    expect((await tasks.read()).tasks[0]).toMatchObject({ id: data.requestId, status: 'succeeded' });
  });

  it.each([true, false])('recovers an interrupted restore without executing a repeated command (redelivery %s)', async (redelivered) => {
    const data = event();
    await new TasksService(config, logger).start(data);
    const { tasks, deliver } = await boot();
    backups.hasPendingRestore.mockResolvedValue(true);
    const reply = await deliver(data, redelivered);
    expect(backups.recoverRestore).toHaveBeenCalledExactlyOnceWith(data.appUrn);
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success: false, message: expect.stringContaining('interrupted') });
    expect((await tasks.read()).tasks[0]).toMatchObject({ id: data.requestId, status: 'interrupted' });
    expect(mutex.resourceLocks.size).toBe(0);
  });

  it('refuses a broker redelivery even when its earlier task is no longer retained', async () => {
    const { tasks, deliver } = await boot();
    const data = event();
    await deliver(data, true);
    expect(execute).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]).toMatchObject({ id: data.requestId, status: 'interrupted' });
  });

  it('refuses redelivery with unreadable history and preserves the original history file', async () => {
    const file = path.join(directory, 'state', 'orbis-tasks', 'history.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'unreadable history');
    const { tasks, deliver } = await boot();
    await deliver(event(), true);
    expect(execute).not.toHaveBeenCalled();
    expect(await tasks.read()).toMatchObject({ storage: 'unavailable', tasks: [{ status: 'interrupted' }] });
    expect(await fs.readFile(file, 'utf8')).toBe('unreadable history');
  });

  it.each([true, false])('retains the previous terminal outcome (%s) after duplicate delivery', async (success) => {
    const data = event();
    const previous = new TasksService(config, logger);
    await previous.start(data);
    await previous.finish(data, success);
    const expected = (await previous.read()).tasks;
    const { tasks, deliver } = await boot();
    const reply = await deliver(data, true);
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success, message: expect.any(String) });
    expect((await tasks.read()).tasks).toEqual(expected);
  });

  it('serializes duplicate requests and executes a restore only once', async () => {
    const { tasks, deliver } = await boot();
    const data = event();
    await Promise.all([deliver(data), deliver(data)]);
    expect(execute).toHaveBeenCalledOnce();
    expect((await tasks.read()).tasks).toHaveLength(1);
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
    expect(mutex.resourceLocks.size).toBe(0);
  });

  it('keeps the interrupted outcome when recovery cannot finish', async () => {
    const data = event();
    await new TasksService(config, logger).start(data);
    const { tasks, deliver } = await boot();
    backups.hasPendingRestore.mockResolvedValue(true);
    backups.recoverRestore.mockRejectedValue(new Error('Recovery storage unavailable'));
    await expect(deliver(data, true)).rejects.toThrow('Recovery storage unavailable');
    expect(execute).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
    expect(mutex.resourceLocks.size).toBe(0);
  });
});
