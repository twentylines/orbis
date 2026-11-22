import type Dockerode from 'dockerode';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import {
  BackupRestoreDockerRuntime,
  snapshotRestoreContainer,
  snapshotRetainedRole,
  verifyRestoreVerifierMounts,
  restoreRootPlanMatchesPolicy,
  type RestoreOperation,
  type RestoreRuntimeIdentity,
} from './backup-restore-runtime';
import { restoreAuxiliaryContainerPlans } from './backup-restore-containers';
import type { BackupRestoreJournal } from './backup-restore-journal';
import { verifierMarkerPrefix, restoreFailureProgress } from './backup-restore-diagnostics';
import { RestoreRolledBackError } from './backup-restore-coordinator';
import { readRestoreProgress } from './backup-restore-progress';
import { captureRestoreHostIdentity } from './backup-restore-host-identity';
import { restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';
import { resetSafetyTarHeader } from './reset-safety-tar';
import { executeRestoreWorker } from './backup-restore-worker';
import * as bootstrap from './backup-restore-bootstrap';
vi.unmock('node:fs');
vi.mock('./backup-restore-files', () => ({ verifyRestoreFiles: vi.fn(async () => undefined) }));
vi.mock('./backup-restore-database', () => ({ verifyRestoreDatabase: vi.fn(async () => undefined) }));

const markerName = 'restore-install-hold-capability.json';
const declaration = Buffer.from('{"schema":"orbis.restore-install-hold-effect.v1","version":1,"policy":"verified-live-store-before-app-resume.v1"}');
function markerTar(body = declaration, name = markerName) {
  return Buffer.concat([resetSafetyTarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]);
}
function provisionalRuntimeFixture(retainedProvisional = true) {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const original = {
    Id: '1'.repeat(64),
    Name: '/runtipi',
    Image: `sha256:${'a'.repeat(64)}`,
    Config: { User: '0', Env: ['NODE_ENV=production'], Labels: {} },
    HostConfig: { NetworkMode: 'fixture', Privileged: false, PortBindings: {}, RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    State: { Running: true, Restarting: false, Paused: false, StartedAt: '2026-01-01T00:00:00Z' },
    RestartCount: 0,
    NetworkSettings: { Networks: { fixture: {} } },
    Mounts: [
      { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
      { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
      { Type: 'bind', Source: '/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
      {
        Type: 'bind',
        Source: `/var/lib/orbis/reset-authority/${'d'.repeat(64)}/data`,
        Destination: '/data/orbis-reset',
        RW: true,
        Propagation: 'rprivate',
      },
    ],
  } as unknown as Dockerode.ContainerInspectInfo;
  const plans = restoreAuxiliaryContainerPlans(original, id, nonce, false, retainedProvisional);
  const raw = (plan: Dockerode.ContainerCreateOptions, index: string) =>
    ({
      Id: index.repeat(64),
      Name: `/${plan.name}`,
      Image: original.Image,
      Config: plan,
      HostConfig: plan.HostConfig,
      State: { Running: false, Restarting: false, Paused: false, StartedAt: '0001-01-01T00:00:00Z' },
      RestartCount: 0,
      NetworkSettings: { Networks: { fixture: {} } },
      Mounts: plan.HostConfig?.Mounts?.map((mount) => ({
        Type: mount.Type,
        Source: mount.Source,
        Destination: mount.Target,
        RW: !mount.ReadOnly,
        Propagation: mount.BindOptions?.Propagation,
      })),
    }) as unknown as Dockerode.ContainerInspectInfo;
  const worker = raw(plans.worker, '2');
  const verifier = raw(plans.verifier, '3');
  const state = { id, nonce, worker: worker.Id, phase: 'staging', decision: null, roots: [...restoreTreeNames] };
  const advance = vi.fn();
  const journal = { state, refresh: async () => state, advance } as unknown as BackupRestoreJournal;
  const operation = {
    id,
    nonce,
    image: original.Image,
    version: 1,
    apps: [],
    original: snapshotRestoreContainer(original),
    candidate: snapshotRestoreContainer(original),
    worker: snapshotRestoreContainer(worker),
    verifier: snapshotRestoreContainer(verifier),
    queue: { host: 'queue', username: 'fixture', password: 'fixture-password' },
  } as RestoreRuntimeIdentity;
  const containers = new Map([original, worker, verifier].map((value) => [value.Id, value]));
  const archive = vi.fn(async () => {
    const tar = markerTar();
    return Readable.from([tar.subarray(0, 41), tar.subarray(41)]);
  });
  const image = vi.fn(async () => ({ Id: original.Image }));
  const getImage = vi.fn(() => ({ inspect: image }));
  const exec = vi.fn();
  const stop = vi.fn();
  const docker = {
    getContainer: (id: string) => ({ inspect: async () => structuredClone(containers.get(id)), getArchive: archive, exec, stop }),
    getImage,
  } as unknown as Dockerode;
  const runtime = new BackupRestoreDockerRuntime(docker, journal, operation);
  return { worker, verifier, state, operation, runtime, archive, image, getImage, exec, stop, docker, journal, advance };
}

it('verifies retained provisional workers only during inert staging', async () => {
  const fixture = provisionalRuntimeFixture();
  await expect(fixture.runtime.verifyWorker(fixture.worker.Id, { preparing: true, retainedProvisional: true })).resolves.toBe(fixture.worker.Id);
  await expect(fixture.runtime.verifyWorker(fixture.worker.Id, { preparing: true })).rejects.toMatchObject({ runtimeCheck: 'worker-mounts' });
  expect(fixture.archive).not.toHaveBeenCalled();
});

it('checks the exact immutable image and reads the worker declaration without running the worker', async () => {
  const fixture = provisionalRuntimeFixture(false);
  const { runtime, worker } = fixture;
  await expect(runtime.inspectVerifiedWorker(worker.Id, { preparing: true })).resolves.toMatchObject({ Id: worker.Id, Image: worker.Image });
  expect(fixture.getImage).toHaveBeenCalledExactlyOnceWith(worker.Image);
  expect(fixture.archive).toHaveBeenCalledExactlyOnceWith({
    path: '/app/restore-install-hold-capability.json',
    abortSignal: expect.any(AbortSignal),
  });
  expect(fixture.exec).not.toHaveBeenCalled();
});

it.each([
  ['missing', undefined],
  ['wrong member', markerTar(declaration, 'unrelated.json')],
  ['duplicate member', Buffer.concat([markerTar().subarray(0, 1024), markerTar()])],
  ['oversized tar', Buffer.concat([markerTar(), Buffer.alloc(16_384)])],
  ['oversized declaration', markerTar(Buffer.alloc(4097))],
  ['truncated tar', markerTar().subarray(0, 1536)],
  ['duplicate field', markerTar(Buffer.from(declaration.toString().replace('"version":1', '"version":0,"version":1')))],
  ['unsupported declaration', markerTar(Buffer.from(declaration.toString().replace('"version":1', '"version":2')))],
] as const)('holds an otherwise verified worker with a %s capability', async (_label, tar) => {
  const fixture = provisionalRuntimeFixture(false);
  if (tar) fixture.archive.mockResolvedValueOnce(Readable.from([tar]));
  else fixture.archive.mockRejectedValueOnce(Object.assign(new Error('missing'), { statusCode: 404 }));
  await expect(fixture.runtime.verifyWorker(fixture.worker.Id, { preparing: true })).rejects.toMatchObject({
    runtimeCheck: 'worker-install-hold-capability',
  });
  expect(fixture.exec).not.toHaveBeenCalled();
});

it.each(['image', 'auto-restart', 'mounted-app', 'tmpfs-shadow', 'policy-changes-during-copy', 'restarting'] as const)(
  'holds a worker with %s even if it can supply the correct capability bytes',
  async (change) => {
    const fixture = provisionalRuntimeFixture(false);
    const { runtime, worker, operation } = fixture;
    if (change === 'image') fixture.image.mockResolvedValueOnce({ Id: `sha256:${'b'.repeat(64)}` });
    if (change === 'auto-restart') worker.HostConfig.RestartPolicy = { Name: 'unless-stopped', MaximumRetryCount: 0 };
    if (change === 'mounted-app') worker.Mounts.push({ Type: 'bind', Destination: '/app', Source: '/fixture', RW: false, Mode: '', Propagation: '' });
    if (change === 'tmpfs-shadow') worker.HostConfig.Tmpfs = { '/app/restore-worker.mjs': 'rw' };
    if (change === 'restarting') worker.State.Restarting = true;
    if (change === 'policy-changes-during-copy')
      fixture.archive.mockImplementationOnce(async () => {
        worker.HostConfig.RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
        return Readable.from([markerTar()]);
      });
    operation.worker = snapshotRestoreContainer(worker);
    await expect(runtime.verifyWorker(worker.Id, { preparing: true })).rejects.toMatchObject({
      runtimeCheck: change === 'mounted-app' ? 'worker-mounts' : 'worker-install-hold-capability',
    });
    if (change !== 'policy-changes-during-copy') expect(fixture.archive).not.toHaveBeenCalled();
    expect(fixture.exec).not.toHaveBeenCalled();
  },
);

it('aborts a stalled capability copy and closes its stream', async () => {
  const { runtime, worker, archive } = provisionalRuntimeFixture(false);
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  const stream = new PassThrough();
  archive.mockImplementationOnce(async () => {
    setImmediate(() => controller.abort());
    return stream;
  });
  try {
    await expect(runtime.verifyWorker(worker.Id, { preparing: true })).rejects.toMatchObject({ runtimeCheck: 'worker-install-hold-capability' });
    expect(stream.destroyed).toBe(true);
  } finally {
    timeout.mockRestore();
  }
});

it('refuses at the standalone phase entry before advancing the journal or stopping writers', async () => {
  const fixture = provisionalRuntimeFixture(false);
  const read = vi.spyOn(bootstrap, 'readRestoreBootstrap').mockResolvedValueOnce({ identity: fixture.operation } as bootstrap.RestoreBootstrap);
  fixture.archive.mockRejectedValueOnce(Object.assign(new Error('capability absent'), { statusCode: 404 }));
  const progress = vi.fn();
  try {
    await expect(
      executeRestoreWorker({
        docker: fixture.docker,
        journal: fixture.journal,
        hostname: fixture.worker.Id,
        signal: new AbortController().signal,
        progress,
      }),
    ).rejects.toMatchObject({ runtimeCheck: 'worker-install-hold-capability' });
    expect(fixture.advance).not.toHaveBeenCalled();
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it.each(['running', 'started', 'restart', 'control', 'parent', 'verifier-control', 'without-preparing', 'phase'])(
  'rejects a retained provisional runtime whose authority or lifecycle changed (%s)',
  async (change) => {
    const fixture = provisionalRuntimeFixture();
    if (change === 'running') fixture.worker.State.Running = true;
    if (change === 'started') fixture.worker.State.StartedAt = '2026-01-01T00:00:00Z';
    if (change === 'restart') fixture.worker.HostConfig.RestartPolicy = { Name: 'unless-stopped', MaximumRetryCount: 0 };
    if (change === 'control' || change === 'verifier-control') {
      (change === 'control' ? fixture.worker : fixture.verifier).Mounts.push({
        Type: 'bind',
        Source: `/var/lib/orbis/reset-authority/${'d'.repeat(64)}/data`,
        Destination: '/data/orbis-reset',
        RW: true,
        Propagation: 'rprivate',
        Mode: 'rw',
      });
    }
    if (change === 'parent')
      fixture.worker.Mounts.push({ Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true, Mode: 'rw', Propagation: 'rprivate' });
    if (change === 'phase') fixture.state.phase = 'preparing';
    // Even a matching new snapshot cannot authorize added storage or a started provisional worker.
    fixture.operation.worker = snapshotRestoreContainer(fixture.worker);
    fixture.operation.verifier = snapshotRestoreContainer(fixture.verifier);
    await expect(
      fixture.runtime.verifyWorker(fixture.worker.Id, { preparing: change !== 'without-preparing', retainedProvisional: true }),
    ).rejects.toThrow();
  },
);

it.each(['quiescing', 'rolling-back'] as const)('keeps legacy recovery compatible but refuses new unsealed promotion in %s', async (phase) => {
  const journal = { state: { phase } } as unknown as BackupRestoreJournal;
  const operation = { original: {}, candidate: {}, verifier: {}, apps: [] } as unknown as RestoreOperation;
  const runtime = new BackupRestoreDockerRuntime({} as Dockerode, journal, operation);
  const hooks = runtime as unknown as { stop: () => Promise<void>; noOtherWriters: () => Promise<void>; idleQueues: () => Promise<void> };
  vi.spyOn(hooks, 'stop').mockResolvedValue(undefined);
  const writers = vi.spyOn(hooks, 'noOtherWriters').mockResolvedValue(undefined);
  vi.spyOn(hooks, 'idleQueues').mockResolvedValue(undefined);
  if (phase === 'quiescing')
    await expect(runtime.stopWriters(new AbortController().signal)).rejects.toMatchObject({ runtimeCheck: 'host-identity-required' });
  else await runtime.stopWriters(new AbortController().signal);
  expect(writers).toHaveBeenCalledOnce();
});

it.each([false, true])('rechecks destination identity after writers stop before promotion (changed=%s)', async (changed) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cutover-identity-')));
  try {
    const data = path.join(root, 'data');
    const journalDirectory = path.join(root, 'journal');
    await fs.mkdir(data, { mode: 0o700 });
    await fs.mkdir(journalDirectory, { mode: 0o700 });
    const roots = {} as Record<RestoreTreeName, string>;
    const id = '11111111-1111-4111-8111-111111111111';
    for (const name of restoreTreeNames) {
      roots[name] = name === 'app-data' ? path.join(root, name) : path.join(data, name);
      await fs.mkdir(roots[name], { mode: 0o700 });
      await fs.mkdir(path.join(journalDirectory, name), { mode: 0o700 });
      await fs.writeFile(
        path.join(journalDirectory, name, 'swap.json'),
        JSON.stringify({
          id,
          root: roots[name],
          ...(name === 'traefik'
            ? { version: 2, mode: 'preserve', incoming: [], previous: [], staging: { device: '1', inode: '1' } }
            : { version: 1 }),
        }),
        { mode: 0o600 },
      );
    }
    const hostIdentity = await captureRestoreHostIdentity({
      directory: path.join(journalDirectory, 'host-identity'),
      id,
      roots,
      signal: new AbortController().signal,
      transformClusterSync: (bytes) => bytes,
    });
    const journal = {
      directory: journalDirectory,
      state: { phase: 'quiescing', roots: [...restoreTreeNames] },
      rootJournal: (name: string) => path.join(journalDirectory, name),
    } as unknown as BackupRestoreJournal;
    const operation = {
      id,
      hostIdentity,
      preservedTraefik: 1,
      database: {},
      original: {},
      candidate: {},
      verifier: {},
      apps: [],
      resumeApps: [],
    } as unknown as RestoreOperation;
    const docker = { getContainer: () => ({ update: vi.fn(async () => undefined), start: vi.fn(async () => undefined) }) };
    const runtime = new BackupRestoreDockerRuntime(docker as unknown as Dockerode, journal, operation, {
      data,
      appData: roots['app-data'],
      cache: path.join(root, 'cache'),
    });
    const hooks = runtime as unknown as {
      stop: () => Promise<void>;
      noOtherWriters: () => Promise<void>;
      idleQueues: () => Promise<void>;
      role: () => Promise<{ Id: string; State: { Running: boolean } }>;
      workerResumeEffect: (...args: unknown[]) => Promise<void>;
      health: () => Promise<void>;
    };
    const stopped = vi.spyOn(hooks, 'stop').mockResolvedValue(undefined);
    const writers = vi.spyOn(hooks, 'noOtherWriters').mockResolvedValue(undefined);
    vi.spyOn(hooks, 'idleQueues').mockImplementation(async () => {
      expect(stopped).toHaveBeenCalledTimes(3);
      expect(writers).toHaveBeenCalledOnce();
      if (changed) await fs.writeFile(path.join(roots.traefik, 'new-network-config'), 'operator change');
    });
    if (changed) await expect(runtime.stopWriters(new AbortController().signal)).rejects.toMatchObject({ runtimeCheck: 'host-identity-changed' });
    else {
      await runtime.stopWriters(new AbortController().signal);
      vi.spyOn(hooks, 'role').mockResolvedValue({ Id: 'candidate', State: { Running: true } });
      vi.spyOn(hooks, 'workerResumeEffect').mockResolvedValue(undefined);
      const health = vi.spyOn(hooks, 'health').mockImplementation(async () => {
        await fs.writeFile(path.join(roots.state, 'cluster.json'), 'legitimate promoted protected state');
      });
      await runtime.activate();
      health.mockImplementation(async () => {
        await fs.writeFile(path.join(roots.traefik, 'unexpected-activation-write'), 'changed');
      });
      await expect(runtime.activate()).rejects.toMatchObject({ runtimeCheck: 'host-identity-changed' });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('requires explicit new Traefik policy and rejects preserved plans in another namespace', () => {
  const plan = { version: 2, mode: 'preserve', incoming: [], previous: [], staging: { device: '1', inode: '2' } };
  expect(restoreRootPlanMatchesPolicy('traefik', plan, true)).toBe(true);
  expect(restoreRootPlanMatchesPolicy('state', plan, true)).toBe(false);
  expect(restoreRootPlanMatchesPolicy('traefik', plan, false)).toBe(false);
  expect(restoreRootPlanMatchesPolicy('traefik', { version: 1 }, true)).toBe(false);
  expect(restoreRootPlanMatchesPolicy('traefik', { ...plan, version: 3 }, true)).toBe(false);
  expect(restoreRootPlanMatchesPolicy('traefik', { ...plan, mode: 'swap' }, true)).toBe(false);
  expect(restoreRootPlanMatchesPolicy('traefik', { version: 1 }, false)).toBe(true);
});

it('refuses a previously sealed v1 prepared restore before new promotion', async () => {
  const journal = { state: { phase: 'quiescing' } } as unknown as BackupRestoreJournal;
  const operation = {
    hostIdentity: { bytes: 1, sha256: 'a'.repeat(64) },
    original: {},
    candidate: {},
    verifier: {},
    apps: [],
  } as unknown as RestoreOperation;
  const runtime = new BackupRestoreDockerRuntime({} as Dockerode, journal, operation);
  const hooks = runtime as unknown as { stop: () => Promise<void>; noOtherWriters: () => Promise<void>; idleQueues: () => Promise<void> };
  vi.spyOn(hooks, 'stop').mockResolvedValue(undefined);
  vi.spyOn(hooks, 'noOtherWriters').mockResolvedValue(undefined);
  vi.spyOn(hooks, 'idleQueues').mockResolvedValue(undefined);
  await expect(runtime.stopWriters(new AbortController().signal)).rejects.toMatchObject({ runtimeCheck: 'host-identity-required' });
});

type InspectFixture = {
  Id: string;
  Name: string;
  Image: string;
  HostConfig: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    OomKillDisable?: boolean | null;
    Privileged: boolean;
    PortBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    CapAdd: string[] | null;
  };
  Config: { Env: string[]; Labels: Record<string, string>; Image: string };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
  State: { Running: boolean };
};

function fixture(overrides: Partial<InspectFixture> = {}): InspectFixture {
  const value: InspectFixture = {
    Id: 'a'.repeat(64),
    Name: '/orbis-controller',
    Image: `sha256:${'b'.repeat(64)}`,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      OomKillDisable: null,
      Privileged: false,
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
      CapAdd: ['NET_ADMIN'],
    },
    Config: { Env: ['NODE_ENV=production'], Labels: { 'com.orbis.role': 'controller' }, Image: 'orbis:stable' },
    Mounts: [
      { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
    ],
    NetworkSettings: { Networks: { orbis: { NetworkID: 'c'.repeat(64) } } },
    State: { Running: true },
    ...overrides,
  };
  return value;
}

const snapshot = (value: InspectFixture) => snapshotRestoreContainer(value as unknown as Dockerode.ContainerInspectInfo);

type Mount = InspectFixture['Mounts'][number];
const originalStorageMounts: Mount[] = [
  { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
  { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
  { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
];
const verifierMounts = (): Mount[] => [
  { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: false },
  { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: false },
  { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
  { Type: 'bind', Source: '/srv/orbis/data/logs', Destination: '/data/logs', RW: true },
];
function verifyMountSet(mounts: Mount[]) {
  verifyRestoreVerifierMounts(
    fixture({ Mounts: originalStorageMounts }) as unknown as Dockerode.ContainerInspectInfo,
    fixture({ Mounts: mounts }) as unknown as Dockerode.ContainerInspectInfo,
  );
}
function changeMount(mounts: Mount[], index: number, changes: Partial<Mount>) {
  const mount = mounts[index];
  if (!mount) throw new Error('Missing test mount fixture.');
  Object.assign(mount, changes);
}

it('accepts exactly the verifier data, app-data, cache, and logs mounts with required access', () => {
  expect(() => verifyMountSet(verifierMounts())).not.toThrow();
});

it('accepts the production child-bind layout through the runtime verifier boundary', () => {
  const names = ['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs', '.env'];
  const original = [
    ...names.map((name) => ({ Type: 'bind', Source: `/srv/orbis/${name}`, Destination: `/data/${name}`, RW: true })),
    { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
    { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
    { Type: 'bind', Source: '/proc/stat', Destination: '/host/proc/stat', RW: false },
  ];
  const verifier = original
    .filter((mount) => !mount.Destination.startsWith('/host/'))
    .map((mount) => ({ ...mount, RW: ['/data/logs', '/cache'].includes(mount.Destination) }));
  expect(() =>
    verifyRestoreVerifierMounts(
      fixture({ Mounts: original }) as unknown as Dockerode.ContainerInspectInfo,
      fixture({ Mounts: verifier }) as unknown as Dockerode.ContainerInspectInfo,
    ),
  ).not.toThrow();
  const writable = verifier.find((mount) => mount.Destination === '/data/.env');
  if (!writable) throw new Error('Missing fixture environment mount');
  writable.RW = true;
  expect(() =>
    verifyRestoreVerifierMounts(
      fixture({ Mounts: original }) as unknown as Dockerode.ContainerInspectInfo,
      fixture({ Mounts: verifier }) as unknown as Dockerode.ContainerInspectInfo,
    ),
  ).toThrow();
});

it.each([
  [
    'read-only Docker socket',
    (mounts: Mount[]) => mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false }),
  ],
  [
    'unexpected read-only host directory',
    (mounts: Mount[]) => mounts.push({ Type: 'bind', Source: '/srv/secrets', Destination: '/secrets', RW: false }),
  ],
  ['duplicate destination', (mounts: Mount[]) => changeMount(mounts, 3, { Destination: '/data' })],
  ['mismatched source', (mounts: Mount[]) => changeMount(mounts, 0, { Source: '/srv/other/data' })],
  ['mismatched access', (mounts: Mount[]) => changeMount(mounts, 1, { RW: true })],
  [
    'missing mount',
    (mounts: Mount[]) => {
      mounts.pop();
    },
  ],
] as const)('rejects verifier mount configuration with %s', (_name, mutate) => {
  const mounts = verifierMounts();
  mutate(mounts);

  expect(() => verifyMountSet(mounts)).toThrow();
});

it('normalizes mount ordering, running state, and OOM flag nullability without changing identity', () => {
  const original = fixture();
  const reordered = fixture({
    Mounts: [...original.Mounts].reverse(),
    State: { Running: false },
    HostConfig: { ...original.HostConfig, OomKillDisable: false },
  });
  const undefinedFlag = fixture({ HostConfig: { ...original.HostConfig, OomKillDisable: undefined } });

  const originalSnapshot = snapshot(original);
  expect(snapshot(reordered).fingerprint).toBe(originalSnapshot.fingerprint);
  expect(snapshot(undefinedFlag).fingerprint).toBe(originalSnapshot.fingerprint);
  expect(snapshot(reordered).running).toBe(false);
  expect(snapshot(original).running).toBe(true);
});

it('accepts only root-confirmed post-commit controller renames while preserving fingerprint checks', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const originalBefore = fixture({ Name: '/runtipi' });
  const originalAfter = fixture({ Name: `/orbis-retained-${id}-previous`, State: { Running: false } });
  const candidateBefore = fixture({ Name: `/orbis-retained-${id}-candidate` });
  const candidateAfter = fixture({ Name: '/runtipi' });
  const snap = (value: InspectFixture, role: 'original' | 'candidate', committed: boolean) =>
    snapshotRetainedRole(value as unknown as Dockerode.ContainerInspectInfo, id, role, committed);
  expect(snap(originalAfter, 'original', true).fingerprint).toBe(snapshot(originalBefore).fingerprint);
  expect(snap(candidateAfter, 'candidate', true).fingerprint).toBe(snapshot(candidateBefore).fingerprint);
  expect(snap(originalAfter, 'original', false).fingerprint).not.toBe(snapshot(originalBefore).fingerprint);
  expect(() => snap(fixture({ Name: '/unexpected' }), 'original', true)).toThrow();
  expect(() => snap(fixture({ Name: '/unexpected' }), 'candidate', true)).toThrow();
  const changed = fixture({ ...originalAfter, Config: { ...originalAfter.Config, Env: ['changed'] } });
  expect(snap(changed, 'original', true).fingerprint).not.toBe(snapshot(originalBefore).fingerprint);
});

it('rechecks renamed root-owned roles through the actual committed runtime boundary', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const original = fixture({ Id: '1'.repeat(64), Name: '/runtipi' });
  const candidate = fixture({ Id: '2'.repeat(64), Name: `/orbis-retained-${id}-candidate` });
  const renamedOriginal = fixture({ ...original, Name: `/orbis-retained-${id}-previous`, State: { Running: false } });
  const renamedCandidate = fixture({ ...candidate, Name: '/runtipi' });
  const containers = new Map([
    [original.Id, renamedOriginal],
    [candidate.Id, renamedCandidate],
  ]);
  const docker = { getContainer: (key: string) => ({ inspect: async () => containers.get(key) }) };
  const journal = { state: { phase: 'committing', decision: 'commit', worker: '3'.repeat(64) } };
  const operation = { id, original: snapshot(original), candidate: snapshot(candidate) };
  const runtime = new BackupRestoreDockerRuntime(docker as never, journal as never, operation as never, undefined, {
    targetImage: `sha256:${'b'.repeat(64)}`,
    committed: true,
    verifyWorker: async () => undefined,
  });
  const owned = runtime as unknown as { owned: (value: ReturnType<typeof snapshot>) => Promise<unknown> };
  await expect(owned.owned(operation.original)).resolves.toMatchObject({ Name: `/orbis-retained-${id}-previous` });
  await expect(owned.owned(operation.candidate)).resolves.toMatchObject({ Name: '/runtipi' });
  containers.set(candidate.Id, fixture({ ...renamedCandidate, Name: '/wrong' }));
  await expect(owned.owned(operation.candidate)).rejects.toThrow();
});

it('fingerprints explicit OOM kill disable and reports restart policy separately', () => {
  const original = fixture();
  const oomDisabled = fixture({ HostConfig: { ...original.HostConfig, OomKillDisable: true } });
  const alternateRestartPolicy = fixture({
    HostConfig: { ...original.HostConfig, RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 } },
  });

  expect(snapshot(oomDisabled).fingerprint).not.toBe(snapshot(original).fingerprint);
  expect(snapshot(alternateRestartPolicy).fingerprint).toBe(snapshot(original).fingerprint);
  expect(snapshot(alternateRestartPolicy).restart).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 });
});

it('ignores volatile network endpoint IDs but fingerprints network membership', () => {
  const original = fixture();
  const differentEndpoint = fixture({ NetworkSettings: { Networks: { orbis: { NetworkID: 'e'.repeat(64) } } } });
  const additionalNetwork = fixture({
    NetworkSettings: { Networks: { orbis: { NetworkID: 'e'.repeat(64) }, extra: { NetworkID: 'f'.repeat(64) } } },
  });
  const removedNetwork = fixture({ NetworkSettings: { Networks: {} } });

  expect(snapshot(differentEndpoint).fingerprint).toBe(snapshot(original).fingerprint);
  expect(snapshot(additionalNetwork).fingerprint).not.toBe(snapshot(original).fingerprint);
  expect(snapshot(removedNetwork).fingerprint).not.toBe(snapshot(original).fingerprint);
});

it.each([
  [
    'mount source',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { Source: '/srv/other/data' });
    },
  ],
  [
    'mount destination',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { Destination: '/other' });
    },
  ],
  [
    'mount access',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { RW: false });
    },
  ],
  [
    'environment',
    (value: InspectFixture) => {
      value.Config.Env.push('FEATURE_FLAG=1');
    },
  ],
  [
    'labels',
    (value: InspectFixture) => {
      value.Config.Labels.owner = 'fixture';
    },
  ],
  [
    'image ID',
    (value: InspectFixture) => {
      value.Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'privileged mode',
    (value: InspectFixture) => {
      value.HostConfig.Privileged = true;
    },
  ],
  [
    'port binding',
    (value: InspectFixture) => {
      value.HostConfig.PortBindings['80/tcp'] = [{ HostPort: '8081' }];
    },
  ],
  [
    'capabilities',
    (value: InspectFixture) => {
      value.HostConfig.CapAdd = ['NET_ADMIN', 'SYS_ADMIN'];
    },
  ],
] as const)('changes the fingerprint when %s changes', (_name, mutate) => {
  const changed = fixture();
  mutate(changed as unknown as InspectFixture);

  expect(snapshot(changed).fingerprint).not.toBe(snapshot(fixture()).fingerprint);
});

it.each([
  ['fixed startup marker', 'verifier-env-readonly', true, false],
  ['unmarked process exit', 'verifier-exited', false, false],
  ['unavailable attachment', 'verifier-diagnostics', false, true],
] as const)(
  'retains safe diagnostics and fails closed for %s in the actual runtime verification path',
  async (_name, check, includeMarker, attachFails) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-verifier-diagnostics-')));
    try {
      const id = '11111111-1111-4111-8111-111111111111';
      const nonce = '22222222-2222-4222-8222-222222222222';
      const data = path.join(root, 'data');
      const journalDirectory = path.join(root, 'journal');
      await fs.mkdir(data, { mode: 0o700 });
      await fs.mkdir(journalDirectory, { mode: 0o700 });
      await fs.writeFile(path.join(data, '.env'), 'fixture-state', { mode: 0o600 });
      await fs.writeFile(path.join(journalDirectory, 'swap.json'), JSON.stringify({ version: 1, id, root: path.join(data, 'state') }), {
        mode: 0o600,
      });
      const base = fixture();
      const verifier = fixture({
        Id: '3'.repeat(64),
        State: { Running: false },
        HostConfig: { ...base.HostConfig, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } },
        Config: {
          ...base.Config,
          Env: [`ORBIS_INSTALLER_TRANSACTION=${id}`, 'ORBIS_INSTALLER_PHASE=hold'],
          Labels: { 'io.orbis.restore': id, 'io.orbis.restore.nonce': nonce, 'io.orbis.restore.role': 'verifier' },
        },
      });
      const record = snapshot(verifier);
      const operation = {
        id,
        nonce,
        image: verifier.Image,
        verifier: record,
        candidate: { id: '4'.repeat(64) },
        database: {},
        files: {},
      } as unknown as RestoreOperation;
      const journal = {
        directory: journalDirectory,
        state: { phase: 'verifying', roots: ['state'] },
        rootJournal: () => journalDirectory,
      } as unknown as BackupRestoreJournal;
      const order: string[] = [];
      const stream = new PassThrough();
      const container = {
        inspect: async () => structuredClone(verifier),
        update: async () => undefined,
        attach: vi.fn(async () => {
          order.push('attach');
          if (attachFails) throw Error('private socket detail');
          return stream;
        }),
        start: vi.fn(async () => {
          order.push('start');
          const content = includeMarker ? `${verifierMarkerPrefix}{"stage":"env","failure":"readonly"}\n` : 'unretained private startup failure\n';
          const body = Buffer.from(content);
          const header = Buffer.alloc(8);
          header[0] = 2;
          header.writeUInt32BE(body.length, 4);
          stream.end(Buffer.concat([header, body]));
        }),
      };
      const runtime = new BackupRestoreDockerRuntime({ getContainer: () => container } as unknown as Dockerode, journal, operation, {
        data,
        cache: path.join(root, 'cache'),
        appData: path.join(root, 'app-data'),
      });
      const failure = await runtime.verify(new AbortController().signal).catch((error) => error);
      expect(failure).toMatchObject({ runtimeCheck: check });
      const diagnostic = restoreFailureProgress(new RestoreRolledBackError(false, failure), 'restoring');
      await fs.writeFile(
        path.join(journalDirectory, 'worker-status.json'),
        JSON.stringify({
          status: 'rolled-back',
          stage: diagnostic.stage,
          check: diagnostic.check,
          message: 'Fixed rollback status',
          updatedAt: Date.now(),
        }),
        { mode: 0o600 },
      );
      expect(await readRestoreProgress(journal)).toMatchObject({ status: 'rolled-back', stage: 'restoring', check });
      expect(order).toEqual(attachFails ? ['attach'] : ['attach', 'start']);
      expect(container.start).toHaveBeenCalledTimes(attachFails ? 0 : 1);
      if (!attachFails) expect(stream.destroyed).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it('accepts a separately root-bound historical verifier image only for an explicit retained runtime', async () => {
  const restoreId = '11111111-1111-4111-8111-111111111111';
  const nonce = '22222222-2222-4222-8222-222222222222';
  const currentImage = `sha256:${'a'.repeat(64)}`;
  const historicalImage = `sha256:${'b'.repeat(64)}`;
  const operation = { id: restoreId, nonce, image: currentImage, original: { id: '1'.repeat(64) } } as unknown as RestoreOperation;
  const journal = {} as BackupRestoreJournal;
  const record = { id: '2'.repeat(64) };
  const container = {
    Image: historicalImage,
    Config: {
      Labels: { 'io.orbis.restore': restoreId, 'io.orbis.restore.nonce': nonce, 'io.orbis.restore.role': 'verifier' },
      Env: [`ORBIS_INSTALLER_TRANSACTION=${restoreId}`, 'ORBIS_INSTALLER_PHASE=hold'],
    },
  };
  const legacy = new BackupRestoreDockerRuntime({} as Dockerode, journal, operation);
  const retained = new BackupRestoreDockerRuntime({} as Dockerode, journal, operation, undefined, {
    targetImage: historicalImage,
    verifyWorker: async () => undefined,
  });
  const legacyHooks = legacy as unknown as { owned: () => Promise<unknown>; role: (record: unknown, role: string) => Promise<unknown> };
  const retainedHooks = retained as unknown as typeof legacyHooks;
  vi.spyOn(legacyHooks, 'owned').mockResolvedValue(container);
  vi.spyOn(retainedHooks, 'owned').mockResolvedValue(container);
  await expect(legacyHooks.role(record, 'verifier')).rejects.toThrow();
  await expect(retainedHooks.role(record, 'verifier')).resolves.toEqual(container);
  container.Image = `sha256:${'c'.repeat(64)}`;
  await expect(retainedHooks.role(record, 'verifier')).rejects.toThrow();
});
