import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { type AppEvent, appEventResultSchema } from '@/modules/queue/entities/app-events';
import { TasksService } from '@/modules/tasks/tasks.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { AppLifecycleService } from './app-lifecycle.service';

describe('update delivery replay', () => {
  let directory: string;
  let module: TestingModule;
  let service: AppLifecycleService;
  let tasks: TasksService;
  const appUrn = createAppUrn('demo', 'store');
  const factory = mock<AppLifecycleCommandFactory>();
  const backups = mock<BackupManager>();
  const execute = vi.fn();
  const event = (): Extract<AppEvent, { command: 'update' }> => ({
    command: 'update',
    appUrn,
    form: {},
    performBackup: false,
    requestId: randomUUID(),
  });
  const bytes = () => fs.readFile(path.join(directory, 'state/orbis-tasks/history.json'), 'utf8');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-update-replay-'));
    vi.clearAllMocks();
    execute.mockReset();
    factory.reconcileUpdate.mockReset();
    factory.resumeUpdate.mockReset().mockRejectedValue(new Error('No verified saved update'));
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    tasks = new TasksService(config, mock<LoggerService>());
    execute.mockResolvedValue({ success: true, message: 'Updated', updateStatus: 'running' });
    factory.createCommand.mockReturnValue({ execute } as never);
    backups.hasPendingRestore.mockResolvedValue(false);
    module = await Test.createTestingModule({ providers: [AppLifecycleService] })
      .useMocker((token) => {
        if (token === TasksService) return tasks;
        if (token === AppLifecycleCommandFactory) return factory;
        if (token === BackupManager) return backups;
        if (token === APP_ASYNC_MUTEX) return new AsyncMutex();
        if (token === DOCKERODE) return {};
        return mock();
      })
      .compile();
    service = module.get(AppLifecycleService);
  });

  afterEach(async () => {
    await module?.close();
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps the completed task after a lost reply, without repeating the command or inventing its current runtime', async () => {
    const data = event();
    execute.mockResolvedValueOnce({ success: true, message: 'Updated', updateStatus: 'running' });
    execute.mockResolvedValueOnce({ success: false, message: 'This app update request is no longer current.' });
    await expect(service.invokeCommand(data, vi.fn().mockRejectedValue(new Error('Reply channel closed')))).rejects.toThrow('Reply channel closed');
    const before = await bytes();
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply, true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledExactlyOnceWith({ success: true, message: 'This update request has already completed.', alreadyCompleted: true });
    expect(await bytes()).toBe(before);
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
    expect(appEventResultSchema(reply.mock.calls[0]?.[0])).toEqual(reply.mock.calls[0]?.[0]);
  });

  it('keeps the original worker reporting after a requester timeout and settles its single outcome', async () => {
    const data = event();
    let entered!: () => void;
    let continueWork!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueWork = resolve;
    });
    execute.mockImplementationOnce(async () => {
      await tasks.progress(data, 'pulling_images');
      entered();
      await gate;
      await tasks.progress(data, 'verifying');
      expect((await tasks.read()).tasks[0]).toMatchObject({ id: data.requestId, status: 'running', phase: 'verifying' });
      return { success: true, message: 'Updated', updateStatus: 'running' };
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    const running = service.invokeCommand(data, reply);
    await started;
    await tasks.unconfirmed(data);
    expect((await tasks.read()).tasks[0]?.status).toBe('unconfirmed');
    continueWork();
    await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect((await tasks.read()).tasks).toMatchObject([{ id: data.requestId, status: 'succeeded', phase: 'verifying' }]);
    const settled = await bytes();
    await tasks.progress(data, 'starting');
    await tasks.unconfirmed(data);
    expect(await bytes()).toBe(settled);
  });

  it('serializes simultaneous duplicate deliveries and activates only once', async () => {
    const data = event();
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { success: true, message: 'Updated', updateStatus: 'running' };
    });
    const first = service.invokeCommand(data, vi.fn().mockResolvedValue(undefined));
    await started;
    const secondReply = vi.fn().mockResolvedValue(undefined);
    const second = service.invokeCommand(data, secondReply);
    finish();
    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(secondReply).toHaveBeenCalledExactlyOnceWith({
      success: true,
      message: 'This update request has already completed.',
      alreadyCompleted: true,
    });
    expect((await tasks.read()).tasks).toHaveLength(1);
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
  });

  it('also preserves a completed request loaded by a fresh task service', async () => {
    const data = event();
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined));
    const before = await bytes();
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const replacement = new TasksService(config, mock<LoggerService>());
    // This is the same replacement that dependency injection supplies after restart.
    Object.assign(service, { tasks: replacement });
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await bytes()).toBe(before);
  });

  it.each(['queued', 'running', 'unconfirmed', 'interrupted'] as const)('does not repeat an uncertain redelivery recorded as %s', async (status) => {
    const data = event();
    await tasks.enqueue(data);
    if (status !== 'queued') await tasks.start(data);
    if (status === 'unconfirmed') await tasks.unconfirmed(data);
    if (status === 'interrupted') await tasks.interrupt(data);
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply, true);
    expect(execute).not.toHaveBeenCalled();
    expect(backups.hasPendingRestore).toHaveBeenCalledExactlyOnceWith(appUrn);
    expect(factory.resumeUpdate).toHaveBeenCalledExactlyOnceWith(data);
    expect(reply).toHaveBeenCalledWith({ success: false, message: 'This update was interrupted. Review the app before starting a new update.' });
    expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
  });

  it('preserves a failed result and accepts an explicitly new request', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.finish(data, false);
    const failed = structuredClone((await tasks.read()).tasks[0]);
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]).toEqual(failed);
    await service.invokeCommand(event(), vi.fn().mockResolvedValue(undefined));
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await tasks.read()).tasks.find((task) => task.id === data.requestId)).toEqual(failed);
  });

  it('does not treat missing history as permission to execute a broker redelivery', async () => {
    const data = event();
    expect((await tasks.read()).tasks).toEqual([]);
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]).toMatchObject({ id: data.requestId, status: 'interrupted' });
  });

  it.each(['appUrn', 'action'] as const)('refuses request ID reuse with a different %s without changing its history', async (field) => {
    const data = event();
    await tasks.enqueue({ ...data, ...(field === 'appUrn' ? { appUrn: createAppUrn('other', 'store') } : { command: 'backup' as const }) });
    const before = await bytes();
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).not.toHaveBeenCalled();
    expect(await bytes()).toBe(before);
  });
  it('routes interrupted work through the saved-request recovery entry and keeps its completed reply', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.start(data);
    await tasks.interrupt(data);
    factory.resumeUpdate.mockResolvedValue({ success: true, message: 'Saved update verified', updateStatus: 'running' });
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply, true);
    expect(factory.resumeUpdate).toHaveBeenCalledExactlyOnceWith(data);
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success: true, message: 'Saved update verified', updateStatus: 'running' });
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
    await service.invokeCommand(data, reply, true);
    expect(factory.resumeUpdate).toHaveBeenCalledOnce();
  });
  it('records a positively restored interrupted update as failed and never replays it', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.start(data);
    await tasks.interrupt(data);
    const restored = { success: false, statePreserved: true, message: 'Previous app restored', updateStatus: 'running' as const };
    factory.resumeUpdate.mockResolvedValue(restored);
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply, true);
    expect(reply).toHaveBeenCalledWith(restored);
    expect((await tasks.read()).tasks[0]?.status).toBe('failed');
    await service.invokeCommand(data, reply, true);
    expect(factory.resumeUpdate).toHaveBeenCalledExactlyOnceWith(data);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not enter recovery or promote files while a restore is pending', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.start(data);
    backups.hasPendingRestore.mockResolvedValue(true);
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(factory.resumeUpdate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]?.status).toBe('interrupted');
  });
  it('serializes duplicate interrupted deliveries and resumes only once', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.start(data);
    factory.resumeUpdate.mockResolvedValue({ success: true, message: 'Resumed', updateStatus: 'running' });
    await Promise.all([
      service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true),
      service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true),
    ]);
    expect(factory.resumeUpdate).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it('reconciles a positive exact commit receipt after a lost SQL response without replaying the command', async () => {
    const data = event();
    execute.mockResolvedValue({ success: false, message: 'SQL reply lost' });
    factory.reconcileUpdate.mockResolvedValue({ success: true, alreadyCompleted: true, message: 'Verified committed receipt' });
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.invokeCommand(data, reply);
    expect(execute).toHaveBeenCalledOnce();
    expect(factory.reconcileUpdate).toHaveBeenCalledExactlyOnceWith(data);
    expect(reply).toHaveBeenCalledWith({ success: true, alreadyCompleted: true, message: 'Verified committed receipt' });
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
  });
  it('allows a failed request to become completed only through its committed receipt entry', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.finish(data, false);
    factory.reconcileUpdate.mockResolvedValue({ success: true, alreadyCompleted: true, message: 'Verified committed receipt' });
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).not.toHaveBeenCalled();
    expect(factory.resumeUpdate).not.toHaveBeenCalled();
    expect(factory.reconcileUpdate).toHaveBeenCalledExactlyOnceWith(data);
    expect((await tasks.read()).tasks[0]?.status).toBe('succeeded');
  });
  it('does not reconcile a failed request across a pending restore', async () => {
    const data = event();
    await tasks.enqueue(data);
    await tasks.finish(data, false);
    backups.hasPendingRestore.mockResolvedValue(true);
    await service.invokeCommand(data, vi.fn().mockResolvedValue(undefined), true);
    expect(execute).not.toHaveBeenCalled();
    expect(factory.reconcileUpdate).not.toHaveBeenCalled();
    expect((await tasks.read()).tasks[0]?.status).toBe('failed');
  });
});
