import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '../apps/apps.repository';
import { TasksService } from '../tasks/tasks.service';
import { DockerAppsService } from './docker-apps.service';
import { dockerContainerDefinition } from './docker-apps.model';

const id = (n: number) => n.toString(16).padStart(64, '0');
const image = `sha256:${'a'.repeat(64)}`;
const inspection = (number: number, name: string, labels: Record<string, string> = {}) =>
  fromPartial<Dockerode.ContainerInspectInfo>({
    Id: id(number),
    Name: `/${name}`,
    Image: image,
    Config: { Image: 'example/app:1', Labels: labels, Env: ['PASSWORD=excluded-private-value'] },
    HostConfig: { AutoRemove: false, RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } },
    Mounts: [{ Type: 'volume', Name: 'keep-app-data', Source: '/docker/volumes/keep-app-data', Destination: '/data' }],
    State: { Status: 'running', Running: true, Paused: false, Restarting: false },
  });
const compose = (project: string, service: string, root = '/srv/apps') => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.project.working_dir': root,
});

describe('detected Docker apps', () => {
  let directory: string;
  let instances: Map<string, Dockerode.ContainerInspectInfo>;
  const apps = mock<AppsRepository>();
  const tasks = mock<TasksService>();
  const configuration = mock<ConfigurationService>();
  let docker: Dockerode;
  let service: DockerAppsService;
  let changes: string[];
  let beforeRemove: (() => void) | undefined;
  let failRemove = false;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-docker-apps-'));
    configuration.get.calledWith('directories').mockReturnValue(fromPartial({ dataDir: directory }));
    apps.getApps.mockResolvedValue([]);
    changes = [];
    beforeRemove = undefined;
    failRemove = false;
    instances = new Map();
    const list = () =>
      [...instances.values()].map((item) =>
        fromPartial<Dockerode.ContainerInfo>({
          Id: item.Id,
          ImageID: item.Image,
          Image: item.Config.Image,
          Names: [item.Name],
          Labels: item.Config.Labels,
          State: item.State.Status,
        }),
      );
    docker = fromPartial<Dockerode>({
      info: vi.fn().mockResolvedValue({ ID: 'isolated-daemon' }),
      listContainers: vi.fn(async () => list()),
      getContainer: vi.fn((identifier: string) =>
        fromPartial<Dockerode.Container>({
          inspect: vi.fn(async () => {
            const item = instances.get(identifier);
            if (!item) throw new Error('Missing synthetic container');
            return structuredClone(item);
          }),
          stop: vi.fn(async () => {
            changes.push(`stop:${identifier}`);
            const item = instances.get(identifier);
            if (item) item.State = { ...item.State, Status: 'exited', Running: false, Restarting: false };
          }),
          unpause: vi.fn(async () => {
            changes.push(`unpause:${identifier}`);
            const item = instances.get(identifier);
            if (item) item.State.Paused = false;
          }),
          remove: vi.fn(async (options) => {
            expect(options).toEqual({ v: false, force: false });
            beforeRemove?.();
            if (failRemove) throw new Error('Docker error contains excluded-private-value');
            changes.push(`remove:${identifier}`);
            instances.delete(identifier);
          }),
        }),
      ),
    });
    service = new DockerAppsService(docker, apps, configuration, tasks);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const getInstance = (number: number) => {
    const value = instances.get(id(number));
    if (!value) throw new Error('Missing synthetic container');
    return value;
  };
  const add = (item: Dockerode.ContainerInspectInfo) => instances.set(item.Id, item);

  it('accepts Docker mount ordering changes while still detecting actual mount changes', () => {
    const original = inspection(1, 'notes');
    original.Mounts.push({
      ...original.Mounts[0],
      Destination: '/second',
      Name: 'keep-second-data',
    } as Dockerode.ContainerInspectInfo['Mounts'][number]);
    const reordered = structuredClone(original);
    reordered.Mounts.reverse();
    expect(dockerContainerDefinition(original)).toBe(dockerContainerDefinition(reordered));
    const mount = reordered.Mounts[0];
    if (!mount) throw new Error('Missing test mount');
    mount.RW = !mount.RW;
    expect(dockerContainerDefinition(original)).not.toBe(dockerContainerDefinition(reordered));
  });

  it('groups Compose services and discovers standalone apps without exposing environment values', async () => {
    add(inspection(1, 'photos-web', compose('photos', 'web')));
    add(inspection(2, 'photos-db', compose('photos', 'db')));
    add(inspection(3, 'notes'));
    const result = await service.read();
    expect(result.apps).toHaveLength(2);
    expect(result.apps.find((item) => item.name === 'photos')?.containers).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('excluded-private-value');
    expect(JSON.stringify(result)).not.toContain('PASSWORD');
    expect(changes).toEqual([]);
    await service.read();
    expect(docker.info).toHaveBeenCalledOnce();
  });

  it('protects infrastructure, registered apps and their whole Compose groups', async () => {
    add(inspection(1, 'runtipi', compose('runtipi', 'runtipi')));
    add(inspection(2, 'runtipi-db', compose('runtipi', 'runtipi-db')));
    add(inspection(3, 'known-web', { ...compose('known_local', 'web'), 'runtipi.appurn': 'known:local' }));
    add(inspection(4, 'known-db', compose('known_local', 'db')));
    add(inspection(5, 'external'));
    apps.getApps.mockResolvedValue([fromPartial({ appName: 'known', appStoreSlug: 'local' })]);
    const result = await service.read();
    expect(result.protectedContainers).toBe(4);
    expect(result.apps.map((item) => item.name)).toEqual(['external']);
  });

  it('keeps distinct Compose roots separate and identifies unregistered Runtipi apps', async () => {
    add(inspection(1, 'old-notes', { ...compose('notes', 'web', '/old'), 'runtipi.managed': 'true', 'runtipi.appurn': 'notes:old' }));
    add(inspection(2, 'new-notes', compose('notes', 'web', '/new')));
    const result = await service.read();
    expect(new Set(result.apps.map((item) => item.id)).size).toBe(2);
    expect(result.apps.filter((item) => item.source === 'runtipi')).toHaveLength(1);
  });

  it.each(['token', 'name', 'state'])('refuses a stale or mismatched %s review before mutation', async (mismatch) => {
    add(inspection(1, 'notes'));
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    if (mismatch === 'state') getInstance(1).State.Status = 'exited';
    await expect(
      service.uninstall(app.id, mismatch === 'token' ? id(99) : review.reviewId, mismatch === 'name' ? 'other' : app.name),
    ).rejects.toThrow('Review the uninstall again');
    expect(changes).toEqual([]);
    expect(tasks.start).not.toHaveBeenCalled();
  });

  it('removes only the reviewed services, retains storage and records completed progress privately', async () => {
    add(inspection(1, 'photos-web', compose('photos', 'web')));
    add(inspection(2, 'photos-db', compose('photos', 'db')));
    add(inspection(3, 'unrelated'));
    const app = (await service.read()).apps.find((item) => item.name === 'photos');
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    expect(review.storage[0]?.name).toBe('keep-app-data');
    const result = await service.uninstall(app.id, review.reviewId, app.name);
    expect(result.removedContainers).toBe(2);
    expect([...instances.keys()]).toEqual([id(3)]);
    const file = path.join(directory, 'state', 'orbis-docker-apps', `${result.requestId}.json`);
    const record = await fs.readFile(file, 'utf8');
    expect(JSON.parse(record).phase).toBe('completed');
    expect(record).not.toContain('PASSWORD');
    expect(record).not.toContain('excluded-private-value');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(tasks.finish).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('refuses new group members appearing during a partial uninstall', async () => {
    add(inspection(1, 'photos-web', compose('photos', 'web')));
    add(inspection(2, 'photos-db', compose('photos', 'db')));
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    beforeRemove = () => add(inspection(3, 'new-worker', compose('photos', 'worker')));
    await expect(service.uninstall(app.id, review.reviewId, app.name)).rejects.toThrow('changed during uninstall');
    expect(instances.has(id(2))).toBe(true);
    expect(instances.has(id(3))).toBe(true);
    expect(changes.filter((item) => item.startsWith('remove:'))).toEqual([`remove:${id(1)}`]);
    expect(tasks.finish).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('redacts Docker errors and records failure while retaining the remaining container', async () => {
    add(inspection(1, 'notes'));
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    failRemove = true;
    await expect(service.uninstall(app.id, review.reviewId, app.name)).rejects.toThrow('Uninstall did not finish');
    expect(instances.has(id(1))).toBe(true);
    expect(tasks.finish).toHaveBeenCalledWith(expect.anything(), false);
    const files = await fs.readdir(path.join(directory, 'state', 'orbis-docker-apps'));
    const record = await fs.readFile(path.join(directory, 'state', 'orbis-docker-apps', files[0] ?? 'missing'), 'utf8');
    expect(JSON.parse(record).phase).toBe('failed');
    expect(record).not.toContain('excluded-private-value');
  });

  it('unpauses before stopping and never force-removes a running container', async () => {
    const paused = inspection(1, 'notes');
    paused.State.Paused = true;
    paused.State.Status = 'paused';
    add(paused);
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    await service.uninstall(app.id, review.reviewId, app.name);
    expect(changes).toEqual([`unpause:${id(1)}`, `stop:${id(1)}`, `remove:${id(1)}`]);
  });

  it('does not risk automatic Docker volume deletion for auto-remove containers', async () => {
    const ephemeral = inspection(1, 'temporary');
    ephemeral.HostConfig.AutoRemove = true;
    add(ephemeral);
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    expect(app.removable).toBe(false);
    const review = await service.removalReview(app.id);
    await expect(service.uninstall(app.id, review.reviewId, app.name)).rejects.toThrow('automatically removes');
    expect(changes).toEqual([]);
  });

  it('fails before Docker mutation if the progress record cannot be written', async () => {
    add(inspection(1, 'notes'));
    const app = (await service.read()).apps[0];
    if (!app) throw new Error('Missing test app');
    const review = await service.removalReview(app.id);
    const file = path.join(directory, 'not-a-directory');
    await fs.writeFile(file, 'sentinel');
    configuration.get.calledWith('directories').mockReturnValue(fromPartial({ dataDir: file }));
    await expect(service.uninstall(app.id, review.reviewId, app.name)).rejects.toThrow('Uninstall did not finish');
    expect(changes).toEqual([]);
  });

  it('blocks direct service access during installer hold and does not replay work on construction', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    await expect(service.read()).rejects.toThrow('Installation is in progress');
    expect(docker.info).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });
});
