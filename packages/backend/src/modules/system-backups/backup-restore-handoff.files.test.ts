import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareRestoreHandoff, discardUnstartedRestoreHandoff, type RestoreHandoffOptions } from './backup-restore-handoff';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreBootstrap } from './backup-restore-bootstrap';
import { readTerminalOwnership } from './backup-restore-terminal-record';
import { pinBackupSource } from './backup-restore-source';
import { makeReviewedBackupFixture } from './backup-restore-source.fixture';
import { withRestoreLease } from './backup-restore-lease';

const checks = vi.hoisted(() => ({ verify: vi.fn(), writers: vi.fn(), order: [] as string[] }));
vi.mock('./backup-restore-runtime', async (original) => ({
  ...(await original<typeof import('./backup-restore-runtime')>()),
  BackupRestoreDockerRuntime: class {
    verifyWorker(id: string) {
      checks.order.push('verify');
      return checks.verify(id);
    }
    preflightWriters() {
      checks.order.push('writers');
      return checks.writers();
    }
  },
}));
let root: string;
let options: RestoreHandoffOptions;
let snapshots: Map<string, Dockerode.ContainerInspectInfo>;
let handles: Map<
  string,
  {
    id: string;
    inspect: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  }
>;
let create: ReturnType<typeof vi.fn>;
const controller = '1'.repeat(64);
const app = '4'.repeat(64);
const image = `sha256:${'a'.repeat(64)}`;
const connection = { host: 'database', port: 5432, user: 'fixture', password: 'fixture-password', database: 'original' };
const queue = { host: 'queue', username: 'fixture', password: 'fixture-queue-password' };
const targetEnvironment = () =>
  Object.entries({
    POSTGRES_HOST: connection.host,
    POSTGRES_PORT: String(connection.port),
    POSTGRES_USERNAME: connection.user,
    POSTGRES_PASSWORD: connection.password,
    POSTGRES_DBNAME: connection.database,
    RABBITMQ_HOST: queue.host,
    RABBITMQ_USERNAME: queue.username,
    RABBITMQ_PASSWORD: queue.password,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
function add(value: Dockerode.ContainerInspectInfo) {
  snapshots.set(value.Id, value);
  const handle = {
    id: value.Id,
    inspect: vi.fn(async () => {
      const current = snapshots.get(value.Id);
      if (!current) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(current);
    }),
    update: vi.fn(async (v: { RestartPolicy: unknown }) => {
      Object.assign(value.HostConfig, { RestartPolicy: v.RestartPolicy });
    }),
    remove: vi.fn(async () => {
      snapshots.delete(value.Id);
    }),
    start: vi.fn(),
  };
  handles.set(value.Id, handle);
  return handle;
}
beforeEach(async () => {
  vi.clearAllMocks();
  checks.order = [];
  checks.verify.mockResolvedValue('verified');
  checks.writers.mockResolvedValue(undefined);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-handoff-')));
  const data = path.join(root, 'data');
  await fs.mkdir(data, { mode: 0o700 });
  await fs.writeFile(path.join(data, '.env'), targetEnvironment(), { mode: 0o600 });
  snapshots = new Map();
  handles = new Map();
  add({
    Id: controller,
    Name: '/controller',
    Image: image,
    Config: {
      User: '0',
      Env: ['NODE_ENV=production'],
      Labels: {
        'io.orbis.installation-protocol': 'orbis.installation-state.v1',
        'com.docker.compose.project': 'fixture',
        'com.docker.compose.service': 'runtipi',
        'com.docker.compose.oneoff': 'false',
        'com.docker.compose.project.working_dir': '/srv/orbis',
        'com.docker.compose.project.config_files': '/srv/orbis/docker-compose.yml',
      },
    },
    HostConfig: { NetworkMode: 'fixture', RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    State: { Running: true, Paused: false, Restarting: false, StartedAt: '2026-01-01T00:00:00Z' },
    RestartCount: 0,
    NetworkSettings: { Networks: { fixture: {} } },
    Mounts: [
      ...['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs', '.env'].map((name) => ({
        Type: 'bind',
        Source: `/srv/orbis/${name}`,
        Destination: `/data/${name}`,
        RW: true,
        Propagation: 'rprivate',
      })),
      { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
      { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
    ],
  } as unknown as Dockerode.ContainerInspectInfo);
  add({
    Id: app,
    Name: '/fixture-app',
    Image: image,
    Config: { Labels: { 'com.docker.compose.project': 'fixture-app_catalogue' } },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    State: { Running: true, Paused: false, Restarting: false, StartedAt: '2026-01-01T00:00:00Z' },
    RestartCount: 0,
    NetworkSettings: { Networks: {} },
    Mounts: [],
  } as unknown as Dockerode.ContainerInspectInfo);
  create = vi.fn(async (plan: Dockerode.ContainerCreateOptions) => {
    const id = plan.Labels?.['io.orbis.restore.role'] === 'worker' ? '3'.repeat(64) : '2'.repeat(64);
    return add({
      Id: id,
      Name: `/${plan.name}`,
      Image: plan.Image,
      Config: plan,
      HostConfig: plan.HostConfig,
      State: { Running: false, Paused: false, Restarting: false, StartedAt: '0001-01-01T00:00:00Z' },
      RestartCount: 0,
      Mounts: (plan.HostConfig?.Mounts ?? []).map((m) => ({ Type: m.Type, Source: m.Source, Destination: m.Target, RW: !m.ReadOnly })),
      NetworkSettings: { Networks: { fixture: {} } },
    } as unknown as Dockerode.ContainerInspectInfo);
  });
  const docker = {
    getContainer: (id: string) => {
      const resolved = snapshots.has(id) ? id : [...snapshots.values()].find((value) => value.Name === `/${id}`)?.Id;
      const handle = resolved ? handles.get(resolved) : undefined;
      if (!handle)
        return {
          inspect: async () => {
            throw Object.assign(new Error('missing'), { statusCode: 404 });
          },
        };
      return handle;
    },
    createContainer: create,
  } as unknown as Dockerode;
  options = {
    docker,
    controller,
    ownerId: 7,
    connection,
    queue,
    apps: [{ id: app, project: 'fixture-app_catalogue' }],
    directories: { data, appData: path.join(root, 'app-data'), cache: path.join(root, 'cache') },
    signal: new AbortController().signal,
    claimReviewedSource: async (journal, accept) => {
      checks.order.push('claim');
      const source = await makeReviewedBackupFixture(root);
      await withRestoreLease(path.dirname(journal.directory), async () => {
        await pinBackupSource({
          directory: source.directory,
          destination: path.join(journal.directory, 'source'),
          expected: source.seal,
          signal: options.signal,
        });
        await accept({ seal: source.seal }, options.signal);
      });
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const currentJournal = () => BackupRestoreJournal.active(path.join(options.directories.data, 'backups', 'restores'));
const assertOriginalUntouched = () => {
  for (const id of [controller, app]) {
    expect(handles.get(id)?.update).not.toHaveBeenCalled();
    expect(handles.get(id)?.remove).not.toHaveBeenCalled();
    expect(handles.get(id)?.start).not.toHaveBeenCalled();
  }
};

it('creates a durable reviewed-source handoff without starting or stopping containers or nesting restore leases', async () => {
  const before = await fs.readFile(path.join(options.directories.data, '.env'));
  const result = await prepareRestoreHandoff(options);
  const bootstrap = await readRestoreBootstrap(result.journal);
  expect(result.journal.state.phase).toBe('staging');
  expect(bootstrap.ownerId).toBe(7);
  expect(bootstrap.identity.original.id).toBe(controller);
  expect(bootstrap.identity.candidate).toEqual(bootstrap.identity.original);
  expect(bootstrap.identity.apps[0]?.project).toBe('fixture-app_catalogue');
  expect(bootstrap.environmentSha256).toBe(createHash('sha256').update(before).digest('hex'));
  expect(checks.order).toEqual(['verify', 'writers', 'claim', 'verify', 'writers']);
  expect(create).toHaveBeenCalledTimes(2);
  for (const h of handles.values()) expect(h.start).not.toHaveBeenCalled();
  assertOriginalUntouched();
  expect(await fs.readFile(path.join(options.directories.data, '.env'))).toEqual(before);
});
it.each([0, -1, Number.NaN, 1.5])('rejects invalid owner identity before creating Docker resources (%s)', async (ownerId) => {
  options.ownerId = ownerId;
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  assertOriginalUntouched();
});
it('rejects an app project that does not match its actual Docker label', async () => {
  const selected = options.apps[0];
  assert.ok(selected);
  selected.project = 'another-project';
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  assertOriginalUntouched();
});
it('rejects duplicate app snapshots and controller aliases', async () => {
  options.apps.push({ id: app, project: 'fixture-app_catalogue' });
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  options.apps = [{ id: controller, project: 'controller' }];
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('rejects a target environment that differs from the configured database or queue', async () => {
  await fs.writeFile(path.join(options.directories.data, '.env'), targetEnvironment().replace('POSTGRES_HOST=database', 'POSTGRES_HOST=other'));
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  assertOriginalUntouched();
});
it('removes only its inert verifier when worker creation fails', async () => {
  const implementation = create.getMockImplementation();
  assert.ok(implementation);
  create.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('fixture create failure'));
  await expect(prepareRestoreHandoff(options)).rejects.toThrow('fixture create failure');
  expect(handles.get('2'.repeat(64))?.remove).toHaveBeenCalledWith();
  expect(await currentJournal()).toBeUndefined();
  assertOriginalUntouched();
});
it('checks writers before claiming the backup and discards only inert auxiliaries on rejection', async () => {
  checks.writers.mockRejectedValueOnce(new Error('other-writer'));
  const claim = vi.fn();
  options.claimReviewedSource = claim;
  await expect(prepareRestoreHandoff(options)).rejects.toThrow('other-writer');
  expect(claim).not.toHaveBeenCalled();
  expect((await currentJournal())?.state.phase).toBe('discarded');
  expect(handles.get('3'.repeat(64))?.remove).toHaveBeenCalledWith();
  assertOriginalUntouched();
});
it('preserves a pinned source when preparation fails after ownership has moved', async () => {
  const claim = options.claimReviewedSource;
  options.claimReviewedSource = async (journal, accept) => {
    await claim(journal, accept);
    throw new Error('fixture handoff failure');
  };
  await expect(prepareRestoreHandoff(options)).rejects.toThrow('fixture handoff failure');
  const journal = await currentJournal();
  assert.ok(journal);
  expect(journal.state.phase).toBe('discarded');
  expect((await fs.stat(path.join(journal.directory, 'source', 'payload', 'content', 'manifest.json'))).isFile()).toBe(true);
  expect((await readRestoreBootstrap(journal)).ownerId).toBe(7);
  assertOriginalUntouched();
});
it('rejects a claim that did not durably accept its reviewed source', async () => {
  options.claimReviewedSource = async () => undefined;
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect((await currentJournal())?.state.phase).toBe('discarded');
  assertOriginalUntouched();
});
it('preserves a host configuration edit made during the source claim', async () => {
  const claim = options.claimReviewedSource;
  options.claimReviewedSource = async (journal, accept) => {
    await claim(journal, accept);
    await fs.appendFile(path.join(options.directories.data, '.env'), '\nHOST_EDIT=preserved\n');
  };
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(await fs.readFile(path.join(options.directories.data, '.env'), 'utf8')).toContain('HOST_EDIT=preserved');
  expect((await currentJournal())?.state.phase).toBe('discarded');
  assertOriginalUntouched();
});
it('refuses to delete an auxiliary that has started unexpectedly', async () => {
  const claim = options.claimReviewedSource;
  options.claimReviewedSource = async (journal, accept) => {
    await claim(journal, accept);
    const worker = snapshots.get(journal.state.worker);
    assert.ok(worker);
    worker.State.Running = true;
  };
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect((await currentJournal())?.state.phase).toBe('staging');
  expect(handles.get('3'.repeat(64))?.remove).not.toHaveBeenCalled();
  expect(handles.get('2'.repeat(64))?.remove).not.toHaveBeenCalled();
  assertOriginalUntouched();
});
it('retries inert cleanup without deleting the source after a partial removal failure', async () => {
  const { journal } = await prepareRestoreHandoff(options);
  const worker = handles.get('3'.repeat(64));
  assert.ok(worker);
  worker.remove.mockRejectedValueOnce(new Error('fixture remove failure'));
  await expect(discardUnstartedRestoreHandoff(options.docker, journal)).rejects.toThrow('fixture remove failure');
  expect(journal.state.phase).toBe('discarded');
  await discardUnstartedRestoreHandoff(options.docker, journal);
  expect((await fs.stat(path.join(journal.directory, 'source', 'payload'))).isDirectory()).toBe(true);
  expect(snapshots.has('2'.repeat(64))).toBe(false);
  expect(snapshots.has('3'.repeat(64))).toBe(false);
  assertOriginalUntouched();
});

it('cleans up an owned worker created despite a lost Docker creation reply', async () => {
  const implementation = create.getMockImplementation();
  assert.ok(implementation);
  create.mockImplementationOnce(implementation).mockImplementationOnce(async (plan: Dockerode.ContainerCreateOptions) => {
    await (implementation as (plan: Dockerode.ContainerCreateOptions) => Promise<unknown>)(plan);
    throw new Error('fixture lost creation reply');
  });
  await expect(prepareRestoreHandoff(options)).rejects.toThrow('fixture lost creation reply');
  expect(snapshots.has('2'.repeat(64))).toBe(false);
  expect(snapshots.has('3'.repeat(64))).toBe(false);
  assertOriginalUntouched();
});
it.each(['POSTGRES_HOST=database', 'RABBITMQ_HOST=queue', 'RABBITMQ_USERNAME=fixture'])(
  'rejects a changed connection field before Docker creation: %s',
  async (field) => {
    await fs.writeFile(path.join(options.directories.data, '.env'), targetEnvironment().replace(field, `${field}-changed`));
    await expect(prepareRestoreHandoff(options)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    assertOriginalUntouched();
  },
);
it.each(['permissions', 'hardlink', 'symlink'])('refuses unsafe private environment storage (%s)', async (mode) => {
  const file = path.join(options.directories.data, '.env');
  if (mode === 'permissions') await fs.chmod(file, 0o644);
  if (mode === 'hardlink') await fs.link(file, path.join(root, 'other-environment'));
  if (mode === 'symlink') {
    await fs.rename(file, path.join(root, 'other-environment'));
    await fs.symlink(path.join(root, 'other-environment'), file);
  }
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  assertOriginalUntouched();
});

it('retains nonsecret ownership before a failed reviewed-source claim so discarded generations can be finalized later', async () => {
  options.claimReviewedSource = async () => {
    throw Error('source claim refused');
  };
  await expect(prepareRestoreHandoff(options)).rejects.toThrow();
  const active = await currentJournal();
  expect(active?.state.phase).toBe('discarded');
  if (!active) throw Error('Missing discarded fixture');
  const ownership = await readTerminalOwnership(active.directory, active.state);
  expect(ownership?.original).toBe(controller);
  expect(ownership?.worker.id).toBe('3'.repeat(64));
  expect(JSON.stringify(ownership)).not.toContain(connection.password);
  expect(snapshots.has('2'.repeat(64))).toBe(false);
  expect(snapshots.has('3'.repeat(64))).toBe(false);
  assertOriginalUntouched();
});
