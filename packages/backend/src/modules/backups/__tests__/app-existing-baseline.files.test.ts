import type { ModuleRef } from '@nestjs/core';
import { AppFilesManager } from '../../apps/app-files-manager';
import { DockerService } from '../../docker/docker.service';
import { readAppMigrationIds } from '../../apps/app-migrations';
import { resumeExistingAppBaseline } from '../../app-lifecycle/commands/resume-existing-app-baseline';
import { requestInputHash } from '../../app-lifecycle/commands/update-app-command';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { AppsRepository } from '../../apps/apps.repository';
import { ExistingAppBaseline, verifyExistingAppBaseline } from '../../docker/app-existing-storage';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { AppStorageWitness, type AppStorageObservation } from '../../host-updates/app-storage-observation';
let root: string;
let stage: AppUpdateStage;
let proof: ExistingAppBaseline | undefined;
const urn = createAppUrn('demo', 'store');
const id = 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const configHash = 'c'.repeat(64);
const host = '/fixture/app-data/store/demo';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'eb-'));
});
afterEach(async () => {
  await proof?.close();
  proof = undefined;
  await stage?.close();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(options: { stopped?: boolean; named?: boolean; ids?: string[] } = {}) {
  const data = path.join(root, 'app-data/store/demo');
  const metadata = path.join(root, 'apps/store/demo');
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(metadata, { recursive: true });
  await fs.writeFile(path.join(data, 'database'), 'existing nonempty app data', { mode: 0o600 });
  await fs.writeFile(path.join(data, 'app.env'), `APP_DATA_DIR=${host}`, { mode: 0o600 });
  await fs.writeFile(path.join(metadata, 'config.json'), JSON.stringify({ tipi_version: 1 }), { mode: 0o640 });
  await fs.writeFile(path.join(metadata, 'docker-compose.generated.yml'), 'services: {}', { mode: 0o640 });
  await fs.mkdir(path.join(metadata, 'migrations'), { mode: 0o750 });
  for (const name of options.ids ?? ['001-installed'])
    await fs.writeFile(path.join(metadata, 'migrations', name + '.yml'), 'older script metadata', { mode: 0o640 });
  stage = await AppUpdateStage.create({
    directory: path.join(root, 'pins'),
    appUrn: urn,
    metadata,
    env: path.join(data, 'app.env'),
    requestId: randomUUID(),
  });
  await fs.mkdir(stage.targetDirectory, { mode: 0o750 });
  await fs.writeFile(path.join(stage.targetDirectory, 'config.json'), JSON.stringify({ tipi_version: 2 }), { mode: 0o640 });
  await fs.mkdir(path.join(stage.targetDirectory, 'migrations'), { mode: 0o750 });
  await fs.writeFile(path.join(stage.targetDirectory, 'migrations/002-new.yml'), 'pending script metadata', { mode: 0o640 });
  await stage.stageTarget('services: {}', 'NEW=true');
  await stage.recordPulledImages({ activationSha256: 'd'.repeat(64), imageIds: { web: imageId } });
  const original = {
    Id: id,
    Image: imageId,
    Config: {
      Labels: {
        'runtipi.managed': 'true',
        'runtipi.appurn': urn,
        'com.docker.compose.project': 'demo_store',
        'com.docker.compose.service': 'web',
        'com.docker.compose.config-hash': configHash,
      },
    },
    State: {
      Running: !options.stopped,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: options.stopped ? 0 : 77,
      StartedAt: '2026-11-23T00:00:00Z',
    },
    Mounts: [{ Type: 'bind', Source: host, Destination: '/data', RW: true } as Record<string, unknown>],
  };
  if (options.named)
    original.Mounts.push({ Type: 'volume', Source: '/var/lib/docker/volumes/demo/_data', Name: 'demo_db', Destination: '/database', RW: true });
  const containers = new Map<string, typeof original>([[id, original]]);
  const calls: string[] = [];
  const docker = {
    modem: {
      dial: (request: { path: string; method: string }, callback: (error: unknown, body?: unknown) => void) => {
        calls.push(request.method + ' ' + request.path);
        if (request.path === '/containers/json?')
          return callback(
            null,
            [...containers.keys()].map((Id) => ({ Id })),
          );
        const match = /^\/containers\/([a-f0-9]{64})\/json$/.exec(request.path);
        if (match) return callback(null, structuredClone(containers.get(match[1] ?? '')));
        return callback(new Error('Unexpected Engine mutation'));
      },
    },
  } as unknown as Dockerode;
  const observation = {
    appUrn: urn,
    containerPath: data,
    hostPath: host,
    controller: { id: 'f'.repeat(64), imageId: imageId, startedAt: '2026-11-23T00:00:00Z' },
    directory: { inode: '123' },
  } as unknown as AppStorageObservation;
  vi.spyOn(AppStorageWitness, 'open').mockImplementation(async () => {
    let closed = false;
    return {
      use: async (effect: (docker: Dockerode, observation: AppStorageObservation) => unknown) => {
        if (closed) throw new Error('Closed');
        return effect(docker, observation);
      },
      close: async () => {
        closed = true;
      },
    } as AppStorageWitness;
  });
  const model = { authoritySha256: '1'.repeat(64), configurationSha256: '2'.repeat(64), activeServices: ['web'], serviceHashes: { web: configHash } };
  const service = {
    prepareExistingBaselineConfiguration: vi.fn(async () => structuredClone(model)),
    verifyExistingBaselineInputs: vi.fn(async () => {}),
  };
  const input = {
    stage,
    service,
    docker,
    appUrn: urn,
    localDirectory: data,
    socketPath: '/fixture/host.sock',
    appId: 7,
    appCreatedAt: 123,
    version: 1,
    requestInputSha256: requestInputHash({}),
    originalContainers: [{ id, imageId, service: 'web', running: !options.stopped, paused: false, restarting: false }],
  };
  const sql = freshInstallSql();
  sql.row().status = 'updating';
  const repository = new AppsRepository(sql.database);
  return { data, metadata, original, containers, calls, observation, model, service, input, sql, repository };
}
it.each([{ stopped: false }, { stopped: true }, { named: true }, { ids: [] }])(
  'adopts a used deployment with nonempty preserved data %j',
  async (options) => {
    const f = await fixture(options);
    proof = await ExistingAppBaseline.open(f.input);
    await stage.recordExistingBaseline(proof);
    await f.repository.commitExistingAppBaseline(stage, proof);
    expect(await stage.confirmExistingBaseline(f.repository)).toEqual({ baselined: true, migrationIds: options.ids ?? ['001-installed'] });
    expect(await fs.readFile(path.join(f.data, 'database'), 'utf8')).toBe('existing nonempty app data');
    expect(f.sql.row()).toMatchObject({ version: 1, status: 'updating', migrations_baselined: true });
    expect(f.calls.every((call) => call.startsWith('GET '))).toBe(true);
    expect((await stage.read()).existingBaseline?.phase).toBe('confirmed');
  },
);
it('retains unknown baseline intent and reconciles a positive lost SQL reply', async () => {
  const f = await fixture();
  proof = await ExistingAppBaseline.open(f.input);
  await stage.recordExistingBaseline(proof);
  await expect(stage.restoreMetadata()).rejects.toThrow();
  f.sql.behavior('lost-commit');
  await expect(f.repository.commitExistingAppBaseline(stage, proof)).rejects.toThrow();
  expect(await stage.confirmExistingBaseline(f.repository)).toEqual({ baselined: true, migrationIds: ['001-installed'] });
  expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});
it('does not clear the stage when SQL did not positively commit', async () => {
  const f = await fixture();
  proof = await ExistingAppBaseline.open(f.input);
  await stage.recordExistingBaseline(proof);
  f.sql.behavior('receipt-insert-failed');
  await expect(f.repository.commitExistingAppBaseline(stage, proof)).rejects.toThrow();
  await expect(stage.confirmExistingBaseline(f.repository)).rejects.toThrow();
  await expect(stage.restoreMetadata()).rejects.toThrow();
  expect((await stage.read()).existingBaseline?.phase).toBe('intent');
  expect(f.sql.row().migrations_baselined).toBe(false);
});
it.each(['hash', 'version', 'never-started', 'required-service', 'foreign-bind', 'foreign-volume', 'unmanaged'])(
  'refuses an unproven installed starting point: %s',
  async (fault) => {
    const f = await fixture({ named: true });
    if (fault === 'hash') f.model.serviceHashes.web = '0'.repeat(64);
    if (fault === 'version') f.input.version = 2;
    if (fault === 'never-started') f.original.State.StartedAt = '0001-01-01T00:00:00Z';
    if (fault === 'required-service') f.model.activeServices.push('worker');
    if (fault === 'unmanaged') f.original.Config.Labels['runtipi.managed'] = 'false';
    if (fault === 'foreign-bind' || fault === 'foreign-volume') {
      const foreign = structuredClone(f.original);
      foreign.Id = 'e'.repeat(64);
      foreign.Config.Labels['com.docker.compose.project'] = 'foreign';
      foreign.Mounts = foreign.Mounts.filter((row) => row.Type === (fault === 'foreign-bind' ? 'bind' : 'volume'));
      f.containers.set(foreign.Id, foreign);
    }
    await expect(ExistingAppBaseline.open(f.input)).rejects.toThrow();
    expect(f.sql.receipts()).toEqual([]);
    expect(await fs.readFile(path.join(f.data, 'database'), 'utf8')).toBe('existing nonempty app data');
  },
);
it.each(['runtime', 'mount', 'storage', 'source', 'overrides'])('rechecks %s after qualification and before SQL mutation', async (fault) => {
  const f = await fixture();
  proof = await ExistingAppBaseline.open(f.input);
  await stage.recordExistingBaseline(proof);
  if (fault === 'runtime') f.original.State.StartedAt = '2026-11-23T00:00:01Z';
  if (fault === 'mount') {
    const mount = f.original.Mounts[0];
    if (mount) mount.Source = host + '/changed';
  }
  if (fault === 'storage') f.observation.hostPath += '/changed';
  if (fault === 'source') await fs.writeFile(path.join((await stage.readOriginalBaseline()).metadata, 'config.json'), '{"tipi_version":2}');
  if (fault === 'overrides') f.service.verifyExistingBaselineInputs.mockRejectedValue(new Error('Changed overrides'));
  await expect(f.repository.commitExistingAppBaseline(stage, proof)).rejects.toThrow();
  expect(f.sql.receipts()).toEqual([]);
  expect(f.sql.row().migrations_baselined).toBe(false);
});
it('rejects copied, prototype-only, expired and cross-stage proof values', async () => {
  const f = await fixture();
  proof = await ExistingAppBaseline.open(f.input);
  for (const value of [{}, Object.create(ExistingAppBaseline.prototype)]) await expect(verifyExistingAppBaseline(value, stage)).rejects.toThrow();
  expect(() => JSON.stringify(proof)).toThrow();
  await expect(verifyExistingAppBaseline(proof, Object.create(AppUpdateStage.prototype))).rejects.toThrow();
  await proof.close();
  await expect(verifyExistingAppBaseline(proof, stage)).rejects.toThrow();
});

it.each(['intent', 'confirmed'] as const)(
  'reopens a committed %s baseline with a fresh witness and records the exact target context without SQL replay',
  async (phase) => {
    const f = await fixture();
    proof = await ExistingAppBaseline.open(f.input);
    await stage.recordExistingBaseline(proof);
    await f.repository.commitExistingAppBaseline(stage, proof);
    if (phase === 'confirmed') await stage.confirmExistingBaseline(f.repository);
    await proof.close();
    proof = undefined;
    const savedInput = stage.input;
    await stage.close();
    stage = await AppUpdateStage.open(savedInput);
    f.observation.controller.id = 'e'.repeat(64); // Fresh current-controller transport, unchanged physical storage binding.
    vi.spyOn(f.repository, 'getAppByUrn').mockResolvedValue({ id: 7, createdAt: 123, version: 1, status: 'updating' } as never);
    const files = {
      getAppPaths: () => ({ appDataDir: f.data }),
      getInstalledAppInfo: async (_urn: unknown, directory: string) => JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')),
      getAppMigrationIds: async (_urn: unknown, directory: string) => [...(await readAppMigrationIds(directory))],
    };
    const services = new Map<unknown, unknown>([
      [AppsRepository, f.repository],
      [AppFilesManager, files],
      [DockerService, f.service],
    ]);
    await resumeExistingAppBaseline({
      moduleRef: { get: (token: unknown) => services.get(token) } as ModuleRef,
      docker: f.input.docker,
      appUrn: urn,
      stage,
      form: {},
    });
    expect((await stage.read()).context).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      previousLedger: { baselined: true, migrationIds: ['001-installed'] },
      targetMigrationIds: ['002-new'],
    });
    expect((await stage.read()).migrationPreparation).toEqual({ phase: 'intent', operationSha256: null });
    expect(f.sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
    expect(await fs.readFile(path.join(f.data, 'database'), 'utf8')).toBe('existing nonempty app data');
  },
);
it('keeps an unacknowledged baseline intent held after restart without retrying its SQL', async () => {
  const f = await fixture();
  proof = await ExistingAppBaseline.open(f.input);
  await stage.recordExistingBaseline(proof);
  await proof.close();
  proof = undefined;
  vi.spyOn(f.repository, 'getAppByUrn').mockResolvedValue({ id: 7, createdAt: 123, version: 1, status: 'updating' } as never);
  const services = new Map<unknown, unknown>([
    [AppsRepository, f.repository],
    [AppFilesManager, { getAppPaths: () => ({ appDataDir: f.data }) }],
    [DockerService, f.service],
  ]);
  await expect(
    resumeExistingAppBaseline({
      moduleRef: { get: (token: unknown) => services.get(token) } as ModuleRef,
      docker: f.input.docker,
      appUrn: urn,
      stage,
      form: {},
    }),
  ).rejects.toThrow();
  expect((await stage.read()).context).toBeNull();
  expect(f.sql.queries.some((query) => query.startsWith('update'))).toBe(false);
});
