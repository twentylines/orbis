import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppUpdateStage, type AppUpdateStageInput, type AppUpdateContext } from '../../docker/app-update-stage';
import { requireAppImagePinUpdate } from '../../docker/app-image-pins';
import { DockerService } from '../../docker/docker.service';
import { AppsRepository } from '../../apps/apps.repository';
import { TasksService } from '../../tasks/tasks.service';
import { AppLifecycleCommandFactory } from '../../app-lifecycle/app-lifecycle-command.factory';
import { requestInputHash } from '../../app-lifecycle/commands/update-app-command';

const urn = 'demo:store' as AppUrn;
const oldId = 'a'.repeat(64);
const newId = 'c'.repeat(64);
const oldImage = `sha256:${'1'.repeat(64)}`;
const newImage = `sha256:${'2'.repeat(64)}`;
let root: string;
let input: AppUpdateStageInput;
let stageId: string;
let active: AppUpdateStage | undefined;
let app: { id: number; createdAt: number; version: number; status: string };
let ledger: { baselined: boolean; migrationIds: string[] };
let values: Record<string, unknown>[];
let activate: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
let current: ReturnType<typeof vi.fn>;
let prepare: ReturnType<typeof vi.fn>;
let factory: AppLifecycleCommandFactory;
const event = () => ({ command: 'update' as const, requestId: input.requestId, appUrn: urn, form: {}, performBackup: false });
function container(target: boolean) {
  return {
    Id: target ? newId : oldId,
    Image: target ? newImage : oldImage,
    Config: {
      Labels: {
        'com.docker.compose.project': 'demo_store',
        'com.docker.compose.service': 'web',
        'runtipi.managed': 'true',
        'runtipi.appurn': urn,
        ...(target ? { 'io.orbis.app-update.stage': stageId } : {}),
      },
    },
    State: {
      Running: target,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: target ? 42 : 0,
      ...(target ? { Health: { Status: 'healthy' } } : {}),
    },
  };
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ur-')));
  const metadata = path.join(root, 'apps/demo');
  const data = path.join(root, 'data');
  await fs.mkdir(metadata, { recursive: true, mode: 0o750 });
  await fs.mkdir(data, { mode: 0o700 });
  await fs.writeFile(path.join(metadata, 'source.json'), 'original', { mode: 0o640 });
  await fs.writeFile(path.join(data, 'app.env'), 'OLD=true', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'accepted-data'), 'original-data');
  input = { directory: path.join(root, 'pins'), appUrn: urn, metadata, env: path.join(data, 'app.env'), requestId: randomUUID() };
  active = await AppUpdateStage.create(input);
  stageId = active.id;
  await fs.mkdir(active.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(active.targetDirectory, 'source.json'), 'target', { mode: 0o640 });
  await active.stageTarget('services: {}', 'NEW=true');
  await active.recordPulledImages({ activationSha256: 'f'.repeat(64), imageIds: { web: newImage } });
  ledger = { baselined: true, migrationIds: [] };
  await active.recordContext({
    appId: 1,
    appCreatedAt: 123,
    fromVersion: 1,
    toVersion: 2,
    requestInputSha256: requestInputHash({}),
    authoritySha256: 'e'.repeat(64),
    previousLedger: ledger,
    targetMigrationIds: [],
    updateStatus: 'running',
    originalContainers: [{ id: oldId, imageId: oldImage, service: 'web', running: true, paused: false, restarting: false }],
  });
  await active.publishTarget();
  await active.close();
  active = undefined;
  app = { id: 1, createdAt: 123, version: 1, status: 'updating' };
  values = [container(false)];
  release = vi.fn(async () => {});
  current = vi.fn(async () => true);
  activate = vi.fn(async () => {
    expect((await active?.read())?.phase).toBe('activation-attempted');
    values = [container(true)];
  });
  prepare = vi.fn(async () => ({ isCurrent: current, release, activate }));
  update = vi.fn(async (_id, patch) => {
    Object.assign(app, patch);
    return app;
  });
  const services = new Map<unknown, unknown>([
    [
      DockerService,
      {
        reopenStagedAppUpdate: async (_urn: string, requestId: string) => {
          active = await AppUpdateStage.open({ ...input, requestId });
          return { transaction: active, retained: false };
        },
        prepareResumedAppUpdate: prepare,
      },
    ],
    [
      AppsRepository,
      {
        getAppByUrn: async () => app,
        getMigrationLedger: async () => ledger,
        updateAppById: update,
        commitOrdinaryAppUpdate: async (
          _stage: AppUpdateStage,
          result: { appId: number; version: number; status: string; pendingRestart: boolean | null },
        ) =>
          Boolean(
            await (update as (id: number, patch: object) => Promise<unknown>)(result.appId, {
              version: result.version,
              status: result.status,
              ...(result.pendingRestart === null ? {} : { pendingRestart: result.pendingRestart }),
            }),
          ),
        readCurrentOrdinaryUpdateCommit: async () => false,
      },
    ],
    [TasksService, { progress: async () => {} }],
  ]);
  const docker = {
    modem: {
      dial: (options: { path: string }, callback: (error: unknown, value: unknown) => void) => {
        if (options.path === '/containers/json?')
          callback(
            null,
            values.map(({ Id }) => ({ Id })),
          );
        else {
          const value = values.find(({ Id }) => options.path === `/containers/${Id}/json`);
          callback(value ? null : { statusCode: 404 }, value);
        }
      },
    },
  } as unknown as Dockerode;
  factory = new AppLifecycleCommandFactory({ get: (token: unknown) => services.get(token) } as ModuleRef, docker);
});
afterEach(async () => {
  await active?.close();
  active = undefined;
  await fs.rm(root, { force: true, recursive: true });
});
async function marker() {
  const value = await AppUpdateStage.open(input);
  await value.activationAttempted();
  await value.close();
}
it('uses the exact saved stage through the real factory and activates only after its durable marker', async () => {
  const result = await factory.resumeUpdate(event());
  expect(result).toMatchObject({ success: true, updateStatus: 'running' });
  expect(activate).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledExactlyOnceWith(1, { version: 2, status: 'running', pendingRestart: false });
  expect(release).toHaveBeenCalledOnce();
  expect(app.version).toBe(2);
  expect(await requireAppImagePinUpdate(input.directory, urn)).toBeNull();
});
it('finishes a positively healthy lost activation reply without issuing another start', async () => {
  await marker();
  values = [container(true)];
  expect((await factory.resumeUpdate(event())).success).toBe(true);
  expect(activate).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledOnce();
});
it.each(['missing', 'old-container', 'wrong-image', 'wrong-stage', 'extra-service', 'unhealthy', 'paused', 'restarting', 'dead', 'pid-zero'])(
  'keeps an uncertain %s target without new writes, restarts or SQL',
  async (change) => {
    await marker();
    const target = container(true);
    if (change === 'missing') values = [];
    else {
      values = [target];
      if (change === 'old-container') values = [container(false)];
      if (change === 'wrong-image') target.Image = oldImage;
      if (change === 'wrong-stage') target.Config.Labels['io.orbis.app-update.stage'] = randomUUID();
      if (change === 'extra-service') target.Config.Labels['com.docker.compose.service'] = 'unknown';
      if (change === 'unhealthy' && target.State.Health) target.State.Health.Status = 'starting';
      if (change === 'paused') target.State.Paused = true;
      if (change === 'restarting') target.State.Restarting = true;
      if (change === 'dead') target.State.Dead = true;
      if (change === 'pid-zero') target.State.Pid = 0;
    }
    expect((await factory.resumeUpdate(event())).success).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const retained = await AppUpdateStage.open(input);
    expect((await retained.read()).phase).toBe('activation-attempted');
    await retained.close();
    expect(await fs.readFile(path.join(path.dirname(input.env), 'accepted-data'), 'utf8')).toBe('original-data');
  },
);
it.each(['request', 'form', 'app', 'created', 'version', 'status', 'ledger'])('refuses changed %s before activating', async (change) => {
  const data = event();
  if (change === 'request') data.requestId = randomUUID();
  if (change === 'form') data.form = { exposed: true };
  if (change === 'app') app.id = 2;
  if (change === 'created') app.createdAt++;
  if (change === 'version') app.version++;
  if (change === 'status') app.status = 'running';
  if (change === 'ledger') ledger = { baselined: true, migrationIds: ['changed'] };
  expect((await factory.resumeUpdate(data)).success).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it('refuses a running original before a first target start', async () => {
  const old = container(false);
  old.State.Running = true;
  old.State.Pid = 41;
  values = [old];
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it('keeps an uncertain SQL outcome and never repeats its write on another redelivery', async () => {
  update.mockImplementationOnce(async (_id, patch) => {
    Object.assign(app, patch);
    throw new Error('Synthetic lost SQL reply');
  });
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(update).toHaveBeenCalledOnce();
  expect(app.version).toBe(2);
  const retained = await AppUpdateStage.open(input);
  expect((await retained.read()).phase).toBe('committing');
  await retained.close();
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(update).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledOnce();
});
it('refuses late authority changes before committing a verified deployment', async () => {
  current.mockResolvedValue(false);
  await marker();
  values = [container(true)];
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(update).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

async function restage(patch: Partial<AppUpdateContext>, published = true, images: Record<string, string> = { web: newImage }) {
  const previous = await AppUpdateStage.open(input);
  const context = (await previous.read()).context;
  if (!context) throw new Error('Missing original context');
  await previous.restoreMetadata();
  active = await AppUpdateStage.create(input);
  stageId = active.id;
  await fs.mkdir(active.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(active.targetDirectory, 'source.json'), 'target', { mode: 0o640 });
  await active.stageTarget('services: {}', 'NEW=true');
  await active.recordPulledImages({ activationSha256: 'f'.repeat(64), imageIds: images });
  await active.recordContext({ ...context, ...patch });
  if (published) await active.publishTarget();
  await active.close();
  active = undefined;
}
it('records a stopped app update without starting any container', async () => {
  await restage({
    updateStatus: 'stopped',
    originalContainers: [{ id: oldId, imageId: oldImage, service: 'web', running: false, paused: false, restarting: false }],
  });
  expect((await factory.resumeUpdate(event())).success).toBe(true);
  expect(activate).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledExactlyOnceWith(1, { version: 2, status: 'stopped' });
});
it('continues the first metadata publication from the exact saved old deployment', async () => {
  await restage({}, false);
  expect((await factory.resumeUpdate(event())).success).toBe(true);
  expect(prepare).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledExactlyOnceWith(1, { version: 2, status: 'running', pendingRestart: false });
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('target');
});
it.each([true, false])('keeps pending migrations held without their complete preparation inputs, baseline=%s', async (baselined) => {
  ledger = { baselined, migrationIds: [] };
  if (!baselined) {
    await expect(restage({ previousLedger: ledger, targetMigrationIds: ['pending'] }, false)).rejects.toThrow();
    return;
  }
  await restage({ previousLedger: ledger, targetMigrationIds: ['pending'] }, false);
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it('requires every saved service to be healthy rather than accepting a surviving subset', async () => {
  await restage({}, true, { web: newImage, worker: newImage });
  await marker();
  values = [container(true)];
  expect((await factory.resumeUpdate(event())).success).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it('does not publish a migration-bearing target before its journal preparation is acknowledged', async () => {
  await restage({ previousLedger: { baselined: true, migrationIds: [] }, targetMigrationIds: ['pending'] }, false);
  active = await AppUpdateStage.open(input);
  expect((await active.read()).migrationPreparation).toEqual({ phase: 'intent', operationSha256: null });
  await expect(active.publishTarget()).rejects.toThrow();
  expect(await fs.readFile(path.join(input.metadata, 'source.json'), 'utf8')).toBe('original');
  expect(activate).not.toHaveBeenCalled();
});
