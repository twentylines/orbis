import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { createMockApp } from '@/tests/helpers/app-mocks';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { Test } from '@nestjs/testing';
import { installRecoveryReviewSchema } from '@runtipi/common/schemas/install-recovery-review';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppsRepository } from '../../apps/apps.repository';
import { AppLifecycleController } from '../app-lifecycle.controller';
import { AppLifecycleService } from '../app-lifecycle.service';
import { installRequestDirectory, reserveInstallRequest, takeInstallRequestReceipt } from '../install-request-receipt';
import { InstallRecoveryReviewService } from './install-recovery-review.service';
import { AppJobService } from './app-job.service';

const urn = createAppUrn('demo', 'store');
const app = createMockApp({ id: 42, createdAt: 1000, appName: 'demo', appStoreSlug: 'store' });

describe('install recovery review', () => {
  let directory: string;
  const receipt = () => ({ app, requestId: randomUUID(), owner: randomUUID(), skipRun: false });

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-install-review-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  function setup() {
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const apps = mock<AppsRepository>();
    apps.getAppByUrn.mockResolvedValue(app);
    const mutex = new AsyncMutex();
    return { apps, mutex, review: new InstallRecoveryReviewService(config, apps, mutex) };
  }

  it('returns no notice for an app without a receipt and does not require a database lookup', async () => {
    const f = setup();
    expect(await f.review.review(urn)).toMatchObject({ appUrn: urn, state: 'clear', hold: null });
    expect(f.apps.getAppByUrn).not.toHaveBeenCalled();
  });

  it('reads a provisional hold after an interrupted database reservation', async () => {
    const f = setup();
    const record = receipt();
    await expect(
      reserveInstallRequest(directory, urn, record, async () => {
        throw new Error('Insert reply lost');
      }),
    ).rejects.toThrow('Insert reply lost');
    const report = await f.review.review(urn);
    expect(installRecoveryReviewSchema.assert(report)).toMatchObject({
      state: 'held',
      hold: { requestId: record.requestId, phase: 'provisional', reservation: 'unconfirmed' },
    });
    expect(f.apps.getAppByUrn).not.toHaveBeenCalled();
  });

  it('correlates the exact pending receipt and leaves all evidence intact', async () => {
    const f = setup();
    const record = receipt();
    await reserveInstallRequest(directory, urn, record, async () => app);
    const original = path.join(installRequestDirectory(directory, urn), record.requestId);
    const bytes = await fs.readFile(original);
    const report = await f.review.review(urn);
    expect(installRecoveryReviewSchema.assert(report)).toMatchObject({
      state: 'held',
      hold: { requestId: record.requestId, phase: 'pending', reservation: 'matches' },
    });
    expect(JSON.stringify(report)).not.toContain(record.owner);
    expect(JSON.stringify(report)).not.toContain(directory);
    expect(await fs.readFile(original)).toEqual(bytes);
  });

  it.each(['missing', 'changed'] as const)('reports a spent receipt with a %s row without authorizing release', async (reservation) => {
    const f = setup();
    const record = receipt();
    await reserveInstallRequest(directory, urn, record, async () => app);
    expect(await takeInstallRequestReceipt(directory, record)).toBeTypeOf('function');
    f.apps.getAppByUrn.mockResolvedValue(reservation === 'missing' ? undefined : { ...app, createdAt: 1001 });
    expect(await f.review.review(urn)).toMatchObject({ state: 'held', hold: { requestId: record.requestId, phase: 'spent', reservation } });
  });

  it('keeps historical non-versioned receipts reviewable without inventing a version match', async () => {
    const f = setup();
    const record = receipt();
    const { version: _version, ...legacy } = app;
    await reserveInstallRequest(directory, urn, record, async () => legacy);
    expect(await f.review.review(urn)).toMatchObject({ state: 'held', hold: { requestId: record.requestId, reservation: 'matches' } });
  });
  it('reports a changed version for a version-bound receipt without authorizing any release', async () => {
    const f = setup();
    const record = receipt();
    await reserveInstallRequest(directory, urn, record, async () => app);
    f.apps.getAppByUrn.mockResolvedValue({ ...app, version: app.version + 1 });
    expect(await f.review.review(urn)).toMatchObject({ state: 'held', hold: { requestId: record.requestId, reservation: 'changed' } });
  });
  it.each([-1, 0.5, '4', null])('keeps malformed v2 version evidence unverified: %s', async (value) => {
    const f = setup();
    const record = receipt();
    await reserveInstallRequest(directory, urn, record, async () => app);
    const file = path.join(installRequestDirectory(directory, urn), record.requestId);
    const body = JSON.parse(await fs.readFile(file, 'utf8'));
    body[7] = value;
    await fs.writeFile(file, JSON.stringify(body));
    expect(await f.review.review(urn)).toMatchObject({ state: 'unverified', hold: null });
    expect(await fs.stat(file)).toBeTruthy();
  });
  it('withholds the receipt while another app worker owns the mutex', async () => {
    const f = setup();
    const record = receipt();
    await reserveInstallRequest(directory, urn, record, async () => app);
    const release = await f.mutex.acquire(urn);
    try {
      expect(await f.review.review(urn)).toMatchObject({ state: 'busy', hold: null });
      expect(f.apps.getAppByUrn).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it.each(['linked', 'oversized', 'multiple', 'wrong app', 'changed during review'] as const)(
    'treats %s hold evidence as unverified',
    async (issue) => {
      const f = setup();
      const record = receipt();
      await reserveInstallRequest(directory, urn, record, async () => app);
      const receiptDirectory = installRequestDirectory(directory, urn);
      const file = path.join(receiptDirectory, record.requestId);
      if (issue === 'linked') {
        const other = path.join(directory, 'other');
        await fs.rename(file, other);
        await fs.symlink(other, file);
      } else if (issue === 'oversized') {
        await fs.writeFile(file, 'x'.repeat(4097));
      } else if (issue === 'multiple') {
        await fs.writeFile(path.join(receiptDirectory, randomUUID()), '', { mode: 0o600 });
      } else if (issue === 'wrong app') {
        await fs.writeFile(file, JSON.stringify([1, record.owner, 42, 1000, 'other', 'store', false]));
      } else {
        f.apps.getAppByUrn.mockImplementation(async () => {
          await fs.rename(file, path.join(receiptDirectory, randomUUID()));
          return app;
        });
      }
      expect(await f.review.review(urn)).toMatchObject({ state: 'unverified', hold: null });
      expect((await fs.readdir(receiptDirectory)).length).toBeGreaterThan(0);
    },
  );

  it('serves an operator-session review only, with no caching or mutation route', async () => {
    const f = setup();
    const module = await Test.createTestingModule({
      controllers: [AppLifecycleController],
      providers: [
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: AppJobService, useValue: mock<AppJobService>() },
        { provide: InstallRecoveryReviewService, useValue: f.review },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    const server = module.createNestApplication();
    server.use((req: Request, _res: Response, next: NextFunction) => {
      const actor = req.header('x-fixture-actor');
      if (actor) {
        req.authMethod = actor === 'cli' || actor === 'forward-auth' ? actor : 'session';
        req.user = { id: 7, operator: actor !== 'member' } as Request['user'];
      }
      next();
    });
    await server.init();
    try {
      const api = request(server.getHttpServer());
      const reviewUrl = `/app-lifecycle/${encodeURIComponent(urn)}/install-recovery`;
      await api.get(reviewUrl).expect(401);
      await api.get(reviewUrl).set('x-fixture-actor', 'forward-auth').expect(401);
      await api.get(reviewUrl).set('x-fixture-actor', 'cli').expect(403);
      await api.get(reviewUrl).set('x-fixture-actor', 'member').expect(403);
      await api.get('/app-lifecycle/demo:not-valid!/install-recovery').set('x-fixture-actor', 'operator').expect(400);
      const record = receipt();
      await reserveInstallRequest(directory, urn, record, async () => app);
      const response = await api.get(reviewUrl).set('x-fixture-actor', 'operator').expect(200).expect('Cache-Control', 'private, no-store');
      expect(installRecoveryReviewSchema.assert(response.body)).toMatchObject({ state: 'held', hold: { requestId: record.requestId } });
      await api.post(reviewUrl).set('x-fixture-actor', 'operator').send({ confirmation: 'release' }).expect(404);
    } finally {
      await server.close();
    }
  });
});
