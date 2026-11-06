import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRuntimeService } from './backup-runtime.service';
import { BackupDockerVolumes, type BackupVolumeInventory } from './backup-docker-volumes';

let directory: string;
const config = {
  get: (key: string) =>
    key === 'database'
      ? { host: 'database', username: 'fixture-user', password: 'disposable fixture password', database: 'fixture' }
      : { dataDir: '/data', appDataDir: '/app-data' },
} as ConfigurationService;
const frame = (channel: number, data: Buffer) => {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
};
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-runtime-export-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function databaseStream(chunks: Buffer[], exitCode = 0) {
  const execution = {
    start: vi.fn().mockResolvedValue(Readable.from(chunks)),
    inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: exitCode }),
  };
  const exec = vi.fn().mockResolvedValue(execution);
  const docker = { getContainer: vi.fn().mockReturnValue({ exec }) } as unknown as Dockerode;
  return { runtime: new BackupRuntimeService(config, docker), exec, execution };
}

it('streams fragmented Docker frames into an exact PostgreSQL archive with backpressure and measured bytes', async () => {
  const data = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(256 * 1024, 17)]);
  const wire = Buffer.concat([frame(1, data.subarray(0, 7000)), frame(1, data.subarray(7000))]);
  const chunks: Buffer[] = [];
  for (let start = 0; start < wire.length; start += 317) chunks.push(wire.subarray(start, start + 317));
  const { runtime, exec } = databaseStream(chunks);
  const progress: number[] = [];
  const file = path.join(directory, 'database.dump');
  await runtime.dumpDatabase('db', file, new AbortController().signal, (bytes) => progress.push(bytes));
  expect(await fs.readFile(file)).toEqual(data);
  expect(progress.at(-1)).toBe(data.length);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(exec.mock.calls[0]?.[0].Cmd)).not.toContain('disposable fixture password');
  expect(exec.mock.calls[0]?.[0].Tty).toBe(false);
});

it.each(['stderr', 'exit', 'truncated', 'wrong-format'] as const)('refuses an incomplete database result: %s', async (failure) => {
  const data = failure === 'wrong-format' ? Buffer.from('NOTPGfixture') : Buffer.from('PGDMPfixture');
  const chunks = [frame(1, data), ...(failure === 'stderr' ? [frame(2, Buffer.from('disposable-private-error-detail'))] : [])];
  if (failure === 'truncated') {
    const original = chunks[0];
    if (!original) throw new Error('Missing fixture frame');
    chunks[0] = original.subarray(0, original.length - 2);
  }
  const { runtime } = databaseStream(chunks, failure === 'exit' ? 1 : 0);
  await expect(runtime.dumpDatabase('db', path.join(directory, 'database.dump'), new AbortController().signal, () => undefined)).rejects.toThrow();
  try {
    await runtime.dumpDatabase('db', path.join(directory, 'second.dump'), new AbortController().signal, () => undefined);
  } catch (error) {
    expect(String(error)).not.toContain('disposable-private-error-detail');
  }
});

function planFixture(
  extraMount?: { Type: string; Source: string; Destination: string; RW: boolean },
  dbNetwork = 'private',
  running = true,
  externalMount?: { Type: string; Source: string; Destination: string; RW: boolean },
) {
  const self = {
    Id: 'controller',
    Mounts: [
      { Type: 'bind', Source: '/host/runtime/data', Destination: '/data' },
      { Type: 'bind', Source: '/host/runtime/app-data', Destination: '/app-data' },
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
      { Type: 'bind', Source: '/etc/localtime', Destination: '/etc/localtime', RW: false },
    ],
    NetworkSettings: { Networks: { private: {} } },
  };
  const app = {
    Id: 'app',
    Name: '/app',
    Config: { Labels: { 'com.docker.compose.project': 'fixture_store' }, Image: 'fixture:1' },
    State: { Running: running },
    NetworkSettings: { Networks: { private: {} } },
    Mounts: [extraMount ?? { Type: 'bind', Source: '/host/runtime/app-data/store/fixture', Destination: '/data', RW: true }],
  };
  const db = {
    Id: 'database',
    Name: '/database',
    Config: { Image: 'postgres:14' },
    State: { Running: true },
    NetworkSettings: { Networks: { [dbNetwork]: { Aliases: ['database'] } } },
    Mounts: [],
  };
  const external = { ...app, Id: 'external', Config: { ...app.Config, Labels: { 'com.docker.compose.project': 'other' } }, Mounts: [externalMount] };
  const docker = {
    getContainer: vi.fn((id: string) => ({
      inspect: async () => (id === os.hostname() ? self : id === 'app' ? app : id === 'external' ? external : db),
    })),
    listContainers: vi
      .fn()
      .mockResolvedValue([
        { Id: 'app', Labels: app.Config.Labels },
        { Id: 'database', Labels: {} },
        ...(externalMount ? [{ Id: 'external', Labels: external.Config.Labels }] : []),
      ]),
  } as unknown as Dockerode;
  return new BackupRuntimeService(config, docker);
}
it('maps only data roots that the export actually includes', async () => {
  expect((await planFixture().plan(['fixture_store'])).containers).toEqual([{ id: 'app', project: 'fixture_store', running: true }]);
  await expect(
    planFixture({ Type: 'bind', Source: '/host/runtime/data/backups', Destination: '/data', RW: true }).plan(['fixture_store']),
  ).rejects.toThrow('external storage');
});

it('pins only explicitly preserved media binds while rejecting other uncaptured storage', async () => {
  const mount = { Type: 'bind', Source: '/host/runtime/data/media/movies', Destination: '/movies', RW: true };
  const runtime = planFixture(mount, 'private', false);
  const plan = await runtime.plan(['fixture_store'], false);
  expect(plan.preservedMedia).toEqual({
    roots: ['/host/runtime/data/media'],
    bindings: [{ id: 'app', source: mount.Source, destination: '/movies', rw: true }],
  });
  await expect(runtime.verifyStopped(plan, new AbortController().signal)).resolves.toHaveLength(1);
  mount.Source = '/host/runtime/data/media/another-library';
  await expect(runtime.verifyStopped(plan, new AbortController().signal)).rejects.toThrow('changed');
  await expect(
    planFixture({ Type: 'bind', Source: '/unrelated/media', Destination: '/movies', RW: true }).plan(['fixture_store'], false),
  ).rejects.toThrow('external storage');
  await expect(planFixture({ Type: 'volume', Source: '/volume', Destination: '/movies', RW: true }).plan(['fixture_store'], false)).rejects.toThrow(
    'Docker volume',
  );
});

it('does not classify a media-only writer as captured while retaining the app-data writer guard', async () => {
  const media = { Type: 'bind', Source: '/host/runtime/data/media', Destination: '/library', RW: true };
  await expect(planFixture(undefined, 'private', true, media).plan(['fixture_store'], false)).resolves.toBeDefined();
  await expect(planFixture(undefined, 'private', true, media).plan(['fixture_store'], true)).rejects.toThrow('Another container');
  await expect(
    planFixture(undefined, 'private', true, { ...media, Source: '/host/runtime/app-data' }).plan(['fixture_store'], false),
  ).rejects.toThrow('Another container');
});
it('refuses Docker volumes and a database from a different network', async () => {
  await expect(planFixture({ Type: 'volume', Source: '/volume', Destination: '/data', RW: true }).plan(['fixture_store'])).rejects.toThrow(
    'Docker volume',
  );
  await expect(planFixture(undefined, 'unrelated').plan(['fixture_store'])).rejects.toThrow('identified safely');
});

it.each([true, false])('recognizes the controller Docker socket as a runtime dependency with RW=%s', async (RW) => {
  expect(
    (await planFixture({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/run/docker.sock', RW }).plan(['fixture_store'])).containers,
  ).toHaveLength(1);
});

it('never treats arbitrary data at a runtime destination as an excluded runtime endpoint', async () => {
  for (const Destination of ['/var/run/docker.sock', '/etc/localtime']) {
    await expect(planFixture({ Type: 'bind', Source: '/host/private/app-data', Destination, RW: false }).plan(['fixture_store'])).rejects.toThrow(
      'external storage',
    );
  }
  await expect(
    planFixture({ Type: 'volume', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false }).plan(['fixture_store']),
  ).rejects.toThrow('Docker volume');
  expect(
    (await planFixture({ Type: 'bind', Source: '/etc/localtime', Destination: '/etc/localtime', RW: false }).plan(['fixture_store'])).containers,
  ).toHaveLength(1);
});

it('re-inspects actual Docker inventory and refuses a still-running app before certifying quiescence', async () => {
  const runtime = planFixture();
  const plan = await runtime.plan(['fixture_store']);
  await expect(runtime.verifyStopped(plan, new AbortController().signal)).rejects.toThrow('writer state changed');
  await expect(runtime.verifyStopped({ ...plan, databaseId: 'different database' }, new AbortController().signal)).rejects.toThrow(
    'writer state changed',
  );
});

it('certifies the re-inspected stopped container inventory when database and image identities remain unchanged', async () => {
  const runtime = planFixture(undefined, 'private', false);
  const plan = await runtime.plan(['fixture_store']);
  expect(await runtime.verifyStopped(plan, new AbortController().signal)).toEqual([{ id: 'app', project: 'fixture_store', running: false }]);
});

type VolumeFixtureMount = { Type: string; Source: string; Destination: string; RW: boolean; Name?: string; Driver?: string };
function volumePlanningFixture() {
  const appId = 'a'.repeat(64);
  const selfId = 'b'.repeat(64);
  const databaseId = 'c'.repeat(64);
  const project = 'fixture_store';
  const volume = { Name: 'fixture-volume', Driver: 'local', Scope: 'local', CreatedAt: '2026-11-05T00:00:00Z', Options: null, Labels: {} };
  const app = {
    Id: appId,
    Name: '/fixture-app',
    Image: `sha256:${'d'.repeat(64)}`,
    Config: {
      Image: 'fixture:1',
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'app',
        'com.docker.compose.container-number': '1',
        'runtipi.appurn': 'fixture:store',
        'runtipi.managed': 'true',
      } as Record<string, string>,
    },
    HostConfig: { AutoRemove: false, Mounts: [] },
    State: { Running: true, Paused: false, Restarting: false, StartedAt: '2026-11-05T00:00:00Z' },
    NetworkSettings: { Networks: { private: { Aliases: [] as string[] } } },
    Mounts: [
      { Type: 'volume', Name: volume.Name, Driver: 'local', Source: '/never/read/docker/storage', Destination: '/config', RW: true },
    ] as VolumeFixtureMount[],
  };
  const self = {
    ...structuredClone(app),
    Id: selfId,
    Name: '/controller',
    Config: { Image: 'controller:fixture', Labels: {} },
    Mounts: [
      { Type: 'bind', Source: '/host/runtime/data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/host/runtime/app-data', Destination: '/app-data', RW: true },
    ],
  };
  const database = {
    ...structuredClone(app),
    Id: databaseId,
    Name: '/database',
    Config: { Image: 'postgres:14', Labels: {} },
    NetworkSettings: { Networks: { private: { Aliases: ['database'] } } },
    Mounts: [],
  };
  const rows = new Map([
    [appId, app],
    [selfId, self],
    [databaseId, database],
  ]);
  const archive = vi.fn(async (): Promise<Readable> => {
    throw new Error('Planning must not read volume archives');
  });
  const stop = vi.fn();
  const start = vi.fn();
  const docker = {
    listContainers: vi.fn(async () => [...rows.values()].map((raw) => ({ Id: raw.Id, Labels: raw.Config.Labels }))),
    getContainer: vi.fn((id: string) => ({
      inspect: async () => structuredClone(id === os.hostname() ? self : rows.get(id)),
      getArchive: archive,
      stop,
      start,
    })),
    getVolume: vi.fn(() => ({ inspect: async () => structuredClone(volume) })),
  };
  const runtime = new BackupRuntimeService(config, docker as unknown as Dockerode);
  return { runtime, docker, rows, app, appId, databaseId, project, volume, archive, stop, start };
}

it.each([null, false, 'unrecognized-policy', {}])('rejects an invalid runtime volume policy before Docker I/O: %s', async (policy) => {
  const f = volumePlanningFixture();
  await expect(f.runtime.plan([f.project], true, policy as never)).rejects.toThrow('volume backup policy');
  expect(f.docker.getContainer).not.toHaveBeenCalled();
  expect(f.docker.listContainers).not.toHaveBeenCalled();
});

it('retains legacy volume rejection unless volume-aware planning is explicitly selected', async () => {
  const f = volumePlanningFixture();
  await expect(f.runtime.plan([f.project])).rejects.toThrow('Docker volume');
  await expect(f.runtime.plan([f.project], true, undefined)).rejects.toThrow('Docker volume');
  expect(f.docker.getVolume).not.toHaveBeenCalled();
  expect(f.archive).not.toHaveBeenCalled();
});

it('issues a private local-volume plan for exact managed consumers without stopping or reading them', async () => {
  const f = volumePlanningFixture();
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  expect(plan.databaseId).toBe(f.databaseId);
  expect(plan.containers).toEqual([{ id: f.appId, project: f.project, running: true }]);
  expect(plan.volumePlan).toEqual({
    version: 1,
    volumes: [
      {
        key: createHash('sha256').update(`orbis.backup-volume.v1\n${f.volume.Name}`).digest('hex'),
        sourceName: f.volume.Name,
        mounts: [{ containerId: f.appId, project: f.project, service: 'app', ordinal: 1, target: '/config', readOnly: false }],
      },
    ],
  });
  expect(Object.isFrozen(plan.volumePlan)).toBe(true);
  expect(JSON.stringify(plan.volumePlan)).not.toContain('/never/read');
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.archive).not.toHaveBeenCalled();
});

it('includes an issued empty volume plan in explicit mode', async () => {
  const f = volumePlanningFixture();
  f.app.Mounts = [{ Type: 'bind', Source: '/host/runtime/app-data/store/fixture', Destination: '/config', RW: true }];
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  expect(plan.volumePlan).toEqual({ version: 1, volumes: [] });
  f.app.State.Running = false;
  await expect(f.runtime.verifyStopped(plan, new AbortController().signal)).resolves.toHaveLength(1);
});

it.each(['foreign-consumer', 'remote-driver', 'unsupported-bind', 'unsupported-tmpfs', 'wrong-managed-label'])(
  'refuses %s in explicit volume planning before any source action',
  async (change) => {
    const f = volumePlanningFixture();
    if (change === 'foreign-consumer') {
      const foreign = structuredClone(f.app);
      foreign.Id = 'e'.repeat(64);
      foreign.Config.Labels['com.docker.compose.project'] = 'foreign_store';
      foreign.Config.Labels['runtipi.appurn'] = 'foreign:store';
      foreign.State.Running = false;
      f.rows.set(foreign.Id, foreign);
    }
    if (change === 'remote-driver') f.volume.Driver = 'nfs';
    if (change === 'unsupported-bind') f.app.Mounts.push({ Type: 'bind', Source: '/uncaptured/storage', Destination: '/outside', RW: true });
    if (change === 'unsupported-tmpfs') f.app.Mounts.push({ Type: 'tmpfs', Source: '', Destination: '/scratch', RW: true });
    if (change === 'wrong-managed-label') f.app.Config.Labels['runtipi.managed'] = 'false';
    await expect(f.runtime.plan([f.project], true, 'capture-local-volumes.v1')).rejects.toThrow();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.archive).not.toHaveBeenCalled();
  },
);

it('replans the same media mode while preserving original stopped-volume authority', async () => {
  const f = volumePlanningFixture();
  f.app.Mounts.push({ Type: 'bind', Source: '/host/runtime/data/media/movies', Destination: '/movies', RW: true });
  const plan = await f.runtime.plan([f.project], false, 'capture-local-volumes.v1');
  f.app.State.Running = false;
  await expect(f.runtime.verifyStopped(plan, new AbortController().signal)).resolves.toHaveLength(1);
  const preserved = f.app.Mounts.find((mount) => mount.Destination === '/movies');
  if (!preserved) throw new Error('Missing fixture media binding');
  preserved.Source = '/host/runtime/data/media/replaced';
  await expect(f.runtime.verifyStopped(plan, new AbortController().signal)).rejects.toThrow('changed');
});

it('rejects a container that restarted and stopped between volume planning and verification', async () => {
  const f = volumePlanningFixture();
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  const signal = new AbortController().signal;
  f.app.State.Running = false;
  await expect(f.runtime.verifyStopped(plan, signal)).resolves.toHaveLength(1);
  f.app.State.StartedAt = '2026-11-05T00:05:00Z';
  await expect(f.runtime.verifyStopped(plan, signal)).rejects.toThrow('volume storage changed');
  expect(f.archive).not.toHaveBeenCalled();
});

it('refuses a structurally identical volume plan that was not issued by this service', async () => {
  const f = volumePlanningFixture();
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  f.app.State.Running = false;
  await expect(f.runtime.verifyStopped({ ...plan, volumePlan: structuredClone(plan.volumePlan) }, new AbortController().signal)).rejects.toThrow(
    'volume storage changed',
  );
  const another = new BackupRuntimeService(config, f.docker as unknown as Dockerode);
  await expect(another.verifyStopped(plan, new AbortController().signal)).rejects.toThrow('volume storage changed');
});

it('requires the original issued volume plan before capture and verifies that consumers stopped', async () => {
  const f = volumePlanningFixture();
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  const options = {
    content: directory,
    maximumBytes: 4096,
    baseline: { entries: 0, pathBytes: 0 },
    signal: new AbortController().signal,
    progress: vi.fn(),
  };
  await expect(f.runtime.captureVolumes(plan, [], options)).rejects.toThrow('writer state changed');
  f.app.State.Running = false;
  await expect(f.runtime.captureVolumes({ ...plan, volumePlan: undefined }, [], options)).rejects.toThrow('not issued');
  await expect(f.runtime.captureVolumes({ ...plan, volumePlan: structuredClone(plan.volumePlan) }, [], options)).rejects.toThrow(
    'volume storage changed',
  );
  expect(f.archive).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux')('delegates original plan, inventory and byte budgets to verified volume capture', async () => {
  const f = volumePlanningFixture();
  const source = path.join(directory, 'source');
  const content = path.join(directory, 'content');
  await fs.mkdir(path.join(source, 'config'), { recursive: true, mode: 0o700 });
  await fs.mkdir(content, { mode: 0o700 });
  const data = Buffer.from('disposable application data');
  await fs.writeFile(path.join(source, 'config', 'settings'), data, { mode: 0o600 });
  const tarFile = path.join(directory, 'source.tar');
  execFileSync('tar', ['--format=ustar', '-cf', tarFile, '-C', source, 'config']);
  const bytes = await fs.readFile(tarFile);
  f.archive.mockImplementation(async () => Readable.from([bytes]));
  const plan = await f.runtime.plan([f.project], true, 'capture-local-volumes.v1');
  const volume = plan.volumePlan?.volumes[0];
  if (!volume) throw new Error('Missing issued fixture volume');
  const inventories: BackupVolumeInventory[] = [
    {
      key: volume.key,
      sourceName: volume.sourceName,
      containerId: f.appId,
      entries: [
        { name: '.', kind: 'directory' },
        { name: 'settings', kind: 'file', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') },
      ],
    },
  ];
  const options = {
    content,
    maximumBytes: bytes.length + 4096,
    baseline: { entries: 2, pathBytes: 10 },
    signal: new AbortController().signal,
    progress: vi.fn(),
  };
  const capture = vi.spyOn(BackupDockerVolumes.prototype, 'capture');
  f.app.State.Running = false;
  const records = await f.runtime.captureVolumes(plan, inventories, options);
  expect(capture).toHaveBeenCalledWith({ ...options, plan: plan.volumePlan, inventories });
  expect(capture.mock.calls[0]?.[0].plan).toBe(plan.volumePlan);
  expect(capture.mock.calls[0]?.[0].inventories).toBe(inventories);
  expect(capture.mock.calls[0]?.[0].baseline).toBe(options.baseline);
  expect(records).toHaveLength(1);
  const record = records[0];
  if (!record) throw new Error('Missing captured fixture archive');
  expect(await fs.readFile(path.join(content, record.archive.name))).toEqual(bytes);
  expect(record.archive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(options.progress).toHaveBeenLastCalledWith(bytes.length + record.inventory.bytes);
});
