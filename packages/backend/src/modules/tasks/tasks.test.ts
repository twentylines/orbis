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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

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
      next();
    }) as NestMiddleware['use']);
    await app.init();
    service = module.get(TasksService);
  });
  afterEach(async () => {
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
});
