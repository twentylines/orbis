import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { TasksService } from './tasks.service';
import { taskAttentionKey, type TaskRecord } from '@runtipi/common/schemas/task-history';
import { TasksController } from './tasks.controller';

function taskAlert(task: TaskRecord | undefined) {
  if (!task) throw new Error('Expected a recorded task');
  const key = taskAttentionKey(task);
  if (!key) throw new Error('Expected a task alert');
  return key;
}

describe('persistent lifecycle history', () => {
  let directory: string;
  let app: INestApplication;
  let service: TasksService;
  let config: ConfigurationService;
  const logger = mock<LoggerService>();
  const event = () => ({
    requestId: randomUUID(),
    command: 'backup' as const,
    appUrn: 'demo:official' as AppUrn,
    form: { password: 'excluded-secret' },
  });
  const historyFile = () => path.join(directory, 'state', 'orbis-tasks', 'history.json');

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-tasks-'));
    const configuration = mock<ConfigurationService>();
    configuration.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    config = configuration;
    const module = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [TasksService, AuthGuard, { provide: ConfigurationService, useValue: config }, { provide: LoggerService, useValue: logger }],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer test') req.user = { id: 1 };
      if (req.headers.authorization === 'Bearer other') req.user = { id: 2 };
      if (req.headers['x-task-session'] === 'true') req.authMethod = 'session';
      next();
    }) as NestMiddleware['use']);
    await app.listen(0, '127.0.0.1');
    service = module.get(TasksService);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('requires authentication and persists concurrent operations without configuration or error payloads', async () => {
    expect((await request(app.getHttpServer()).get('/tasks')).status).toBe(401);
    const first = event();
    const second = event();
    await Promise.all([service.enqueue(first), service.enqueue(second)]);
    await service.start(first);
    await service.finish(first, true);
    await service.unconfirmed(first);
    const response = await request(app.getHttpServer()).get('/tasks').set('Authorization', 'Bearer test');
    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(2);
    expect(response.body.tasks.find((task: { id: string }) => task.id === first.requestId).status).toBe('succeeded');
    expect(await fs.readFile(historyFile(), 'utf8')).not.toContain('excluded-secret');
    expect((await fs.stat(historyFile())).mode & 0o777).toBe(0o600);
  });

  it('marks unresolved work interrupted after restart and allows a redelivered command to settle', async () => {
    const pending = event();
    await service.start(pending);
    const reloaded = new TasksService(config, logger);
    expect((await reloaded.read()).tasks[0]?.status).toBe('interrupted');
    await reloaded.start(pending);
    await reloaded.finish(pending, false);
    expect((await reloaded.read()).tasks[0]?.status).toBe('failed');
  });

  it('preserves a detected app name for task history after its container is removed', async () => {
    const pending = { ...event(), command: 'uninstall' as const, displayName: 'Photos and documents' };
    await service.enqueue(pending);
    await service.finish(pending, true);
    const reloaded = new TasksService(config, logger);
    expect((await reloaded.read()).tasks[0]?.displayName).toBe('Photos and documents');
  });

  it('preserves corrupt history and shows storage unavailability while new operations continue in memory', async () => {
    await fs.mkdir(path.dirname(historyFile()), { recursive: true });
    await fs.writeFile(historyFile(), 'invalid-history');
    const reloaded = new TasksService(config, logger);
    const pending = event();
    await reloaded.start(pending);
    await reloaded.finish(pending, true);
    expect(await reloaded.read()).toMatchObject({ storage: 'unavailable', tasks: [{ status: 'succeeded' }] });
    expect(await fs.readFile(historyFile(), 'utf8')).toBe('invalid-history');
  });

  it('bounds retained history and removes outcomes older than thirty days', async () => {
    const now = Date.now();
    const records = Array.from({ length: 300 }, (_, index) => {
      const at = new Date(now - index * 60000).toISOString();
      return {
        id: randomUUID(),
        appUrn: 'demo:official',
        action: 'backup',
        status: 'succeeded',
        createdAt: at,
        updatedAt: index === 299 ? new Date(now - 31 * 86400000).toISOString() : at,
        startedAt: at,
        finishedAt: at,
      };
    });
    await fs.mkdir(path.dirname(historyFile()), { recursive: true });
    await fs.writeFile(historyFile(), JSON.stringify(records));
    const reloaded = new TasksService(config, logger);
    expect((await reloaded.read()).tasks).toHaveLength(299);
    await reloaded.enqueue(event());
    await reloaded.enqueue(event());
    const history = await reloaded.read();
    expect(history.tasks).toHaveLength(300);
    expect(history.tasks.some((task) => task.id === records[298]?.id)).toBe(false);
  });

  it('authenticates personal attention and retains the existing session Origin guard', async () => {
    expect((await request(app.getHttpServer()).get('/tasks/attention')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/tasks/attention').send({ version: 1, keys: [] })).status).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/tasks/attention')
          .set('Authorization', 'Bearer test')
          .set('x-task-session', 'true')
          .set('Host', 'server.test')
          .set('Origin', 'http://other.test')
          .send({ version: 1, keys: [] })
      ).status,
    ).toBe(403);
    const accepted = await request(app.getHttpServer())
      .post('/tasks/attention')
      .set('Authorization', 'Bearer test')
      .set('x-task-session', 'true')
      .set('Host', 'server.test')
      .set('Origin', 'http://server.test')
      .send({ version: 1, keys: [] });
    expect(accepted.status).toBe(201);
    expect(accepted.headers['cache-control']).toBe('private, no-store');
  });

  it('atomically merges only observed current alerts, persists through reload and isolates accounts and hosts', async () => {
    const first = event();
    const second = event();
    await service.finish(first, false);
    await service.finish(second, false);
    const keys = (await service.read()).tasks.map(taskAttentionKey) as string[];
    await Promise.all(keys.map((key) => service.acknowledgeAttention(1, { version: 1, keys: [key] })));
    const file = path.join(directory, 'state/orbis-tasks/attention/1.json');
    const reloaded = new TasksService(config, logger);
    expect(new Set((await reloaded.readAttention(1)).keys)).toEqual(new Set(keys));
    expect((await reloaded.readAttention(2)).keys).toEqual([]);
    const other = mock<ConfigurationService>();
    other.get.calledWith('directories').mockReturnValue({ dataDir: path.join(directory, 'other-host') } as never);
    expect((await new TasksService(other, logger).readAttention(1)).keys).toEqual([]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')))).toEqual(['version', 'keys']);
    const unknown = `${randomUUID()}:failed:1`;
    await expect(service.acknowledgeAttention(1, { version: 1, keys: [unknown] })).rejects.toThrow('Tasks changed');
    await expect(service.acknowledgeAttention(1, { version: 1, keys, userId: 2 })).rejects.toThrow('observed');
    expect((await request(app.getHttpServer()).get('/tasks/attention').set('Authorization', 'Bearer other')).body.keys).toEqual([]);
  });

  it('keeps repeated same-state updates read but surfaces a later failure and rejects stale acknowledgement', async () => {
    const pending = event();
    await service.finish(pending, false);
    const first = taskAlert((await service.read()).tasks[0]);
    await service.acknowledgeAttention(1, { version: 1, keys: [first] });
    await service.finish(pending, false);
    expect(taskAlert((await service.read()).tasks[0])).toBe(first);
    await service.start(pending);
    await service.finish(pending, false);
    const next = taskAlert((await service.read()).tasks[0]);
    expect(next).not.toBe(first);
    expect((await service.readAttention(1)).keys).not.toContain(next);
    await expect(service.acknowledgeAttention(1, { version: 1, keys: [first] })).rejects.toThrow('Tasks changed');
    await service.acknowledgeAttention(1, { version: 1, keys: [next] });
    expect((await service.readAttention(1)).keys).toEqual([first, next]);
    const another = event();
    await service.start(another);
    await service.unconfirmed(another);
    const unconfirmed = taskAlert((await service.read()).tasks.find((task) => task.id === another.requestId));
    await service.unconfirmed(another);
    expect(taskAlert((await service.read()).tasks.find((task) => task.id === another.requestId))).toBe(unconfirmed);
  });

  it('does not erase old backfilled acknowledgements at the former 302 key boundary or on empty client observations', async () => {
    const now = new Date().toISOString();
    const records = Array.from({ length: 300 }, () => ({
      id: randomUUID(),
      appUrn: 'demo:official',
      action: 'backup',
      status: 'failed',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: now,
      attentionRevision: 1,
    }));
    await fs.mkdir(path.dirname(historyFile()), { recursive: true });
    await fs.writeFile(historyFile(), JSON.stringify(records));
    const reloaded = new TasksService(config, logger);
    const first = (await reloaded.read()).tasks.map(taskAttentionKey) as string[];
    await reloaded.acknowledgeAttention(1, { version: 1, keys: first });
    const additional: string[] = [];
    for (const record of records.slice(0, 4)) {
      const retry = { requestId: record.id, appUrn: record.appUrn as AppUrn, command: 'backup' as const };
      await reloaded.start(retry);
      await reloaded.finish(retry, false);
      additional.push(taskAlert((await reloaded.read()).tasks.find((task) => task.id === record.id)));
    }
    await reloaded.acknowledgeAttention(1, { version: 1, keys: additional });
    await reloaded.acknowledgeAttention(1, { version: 1, keys: [] });
    const after = (await new TasksService(config, logger).readAttention(1)).keys;
    expect(after).toHaveLength(304);
    expect(first.every((key) => after.includes(key))).toBe(true);
    expect((await reloaded.read()).tasks).toHaveLength(300);
  });

  it('preserves the existing ledger on real file corruption, unsafe modes and a failed atomic replacement', async () => {
    const pending = event();
    await service.finish(pending, false);
    const first = taskAlert((await service.read()).tasks[0]);
    await service.acknowledgeAttention(1, { version: 1, keys: [first] });
    const file = path.join(directory, 'state/orbis-tasks/attention/1.json');
    const original = await fs.readFile(file, 'utf8');
    await service.start(pending);
    await service.finish(pending, false);
    const next = taskAlert((await service.read()).tasks[0]);
    const replace = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('No storage space'));
    await expect(service.acknowledgeAttention(1, { version: 1, keys: [next] })).rejects.toThrow('could not be saved');
    replace.mockRestore();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    await fs.chmod(file, 0o644);
    await expect(service.readAttention(1)).rejects.toThrow('preserved');
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, 'invalid');
    await expect(service.acknowledgeAttention(1, { version: 1, keys: [next] })).rejects.toThrow('preserved');
    expect(await fs.readFile(file, 'utf8')).toBe('invalid');
  });

  it('fails closed without erasing existing acknowledgement versions when its bound is full', async () => {
    const now = new Date().toISOString();
    const id = randomUUID();
    await fs.mkdir(path.dirname(historyFile()), { recursive: true });
    await fs.writeFile(
      historyFile(),
      JSON.stringify([
        {
          id,
          appUrn: 'demo:official',
          action: 'backup',
          status: 'failed',
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: now,
          attentionRevision: 4097,
        },
      ]),
    );
    const reloaded = new TasksService(config, logger);
    const next = taskAlert((await reloaded.read()).tasks[0]);
    const file = path.join(directory, 'state/orbis-tasks/attention/1.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const original = JSON.stringify({ version: 1, keys: Array.from({ length: 4096 }, (_, index) => `${id}:failed:${index + 1}`) });
    await fs.writeFile(file, original, { mode: 0o600 });
    await expect(reloaded.acknowledgeAttention(1, { version: 1, keys: [next] })).rejects.toThrow('storage is full');
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('keeps empty acknowledgements as a no-op and preserves absent IDs through missing history and later backfill', async () => {
    expect((await service.read()).tasks).toEqual([]);
    const oldId = randomUUID();
    const oldKey = `${oldId}:failed:1`;
    const file = path.join(directory, 'state/orbis-tasks/attention/1.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const original = JSON.stringify({ version: 1, keys: [oldKey] });
    await fs.writeFile(file, original, { mode: 0o600 });
    for (const mode of ['empty', 'missing']) {
      if (mode === 'empty') await fs.writeFile(historyFile(), '[]', { mode: 0o600 });
      else await fs.rm(historyFile());
      const response = await request(app.getHttpServer())
        .post('/tasks/attention')
        .set('Authorization', 'Bearer test')
        .set('x-task-session', 'true')
        .set('Host', 'server.test')
        .set('Origin', 'http://server.test')
        .send({ version: 1, keys: [] });
      expect(response.status).toBe(201);
      expect(response.body.keys).toEqual([oldKey]);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
      if (mode === 'missing') await expect(fs.stat(historyFile())).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const pending = event();
    await service.finish(pending, false);
    const current = (await service.read()).tasks;
    await service.acknowledgeAttention(1, { version: 1, keys: [taskAlert(current[0])] });
    expect((await service.readAttention(1)).keys).toContain(oldKey);
    const now = new Date().toISOString();
    await fs.writeFile(
      historyFile(),
      JSON.stringify([
        ...current,
        {
          id: oldId,
          appUrn: 'demo:official',
          action: 'backup',
          status: 'failed',
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: now,
          attentionRevision: 1,
        },
      ]),
    );
    const reloaded = new TasksService(config, logger);
    const backfilled = (await reloaded.read()).tasks.find((task) => task.id === oldId);
    expect((await reloaded.readAttention(1)).keys).toContain(taskAlert(backfilled));
  });
});
