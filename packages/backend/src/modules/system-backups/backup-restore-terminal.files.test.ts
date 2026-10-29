import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal, restoreControllerRetired } from './backup-restore-journal';
import { BackupDirectorySwap } from './backup-directory-swap';
import { restoreTreeNames } from './backup-restore-materialize';
import { restoreAuxiliaryContainerPlans } from './backup-restore-containers';
import { snapshotRestoreContainer, writeRestoreOperation, type RestoreOperation } from './backup-restore-runtime';
import { finalizeTerminalRestoreBeforeStartup, cleanupSettledRestoreAuxiliaries } from './backup-restore-terminal-cleanup';
import { readLatestTerminalPointer, readTerminalOwnership, writeTerminalJson, readTerminalJson } from './backup-restore-terminal-record';
import { retainRestoreControllerOwnership } from './backup-restore-terminal-ownership';
import { waitForRestoreStartup } from './backup-restore-startup';
import { writeRestoreBootstrap } from './backup-restore-bootstrap';
import { discardRestorePayload } from './backup-restore-preparation';
import { withRestoreLease } from './backup-restore-lease';

const coreId = 'a'.repeat(64);
const workerId = 'c'.repeat(64);
const verifierId = 'd'.repeat(64);
const networkId = 'e'.repeat(64);
const image = `sha256:${'1'.repeat(64)}`;
const imageLabels = { 'io.orbis.installation-protocol': 'orbis.installation-state.v1', 'io.orbis.network-prune-scope': 'orbis.managed' };
let root: string;
let data: string;
let store: string;
let journal: BackupRestoreJournal;
let original: Dockerode.ContainerInspectInfo;
let operation: RestoreOperation;
let values: Map<string, Dockerode.ContainerInspectInfo>;
let docker: Dockerode;
let removals: string[];
let removeHook: ((id: string) => void) | undefined;
let signal: AbortSignal;
const nativeFilesystem = {
  open: fs.open.bind(fs),
  lstat: fs.lstat.bind(fs),
  realpath: fs.realpath.bind(fs),
  mkdir: fs.mkdir.bind(fs),
  rm: fs.rm.bind(fs),
  readdir: fs.readdir.bind(fs),
};
const containerRoot = (name: string) => (name === 'app-data' ? '/app-data' : `/data/${name}`);
function containerFilesystemBoundary() {
  const bindings = () =>
    restoreTreeNames.map((name) => ({
      target: containerRoot(name),
      source: name === 'app-data' ? path.join(root, 'application', 'app-data') : path.join(data, name),
    }));
  const translate = (file: unknown) => {
    if (typeof file !== 'string') return file;
    const binding = bindings().find((item) => file === item.target || file.startsWith(`${item.target}/`));
    return binding ? binding.source + file.slice(binding.target.length) : file;
  };
  for (const method of ['open', 'lstat', 'mkdir', 'rm', 'readdir'] as const) {
    vi.spyOn(fs, method).mockImplementation((...args: unknown[]) =>
      Reflect.apply(nativeFilesystem[method], fs, [translate(args[0]), ...args.slice(1)]),
    );
  }
  vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    const result = await Reflect.apply(nativeFilesystem.realpath, fs, [translate(args[0]), ...args.slice(1)]);
    if (typeof args[0] !== 'string' || translate(args[0]) === args[0] || typeof result !== 'string') return result;
    const binding = bindings().find((item) => result === item.source || result.startsWith(`${item.source}/`));
    return binding ? binding.target + result.slice(binding.source.length) : result;
  });
}
const token = (id: string) => id.slice(0, 12);
function current(id = coreId) {
  const value = values.get(id);
  if (!value) throw Error('Missing fixture container');
  return value;
}
function args(id = coreId) {
  return { docker, store, controller: token(id), data, signal };
}
async function env(database = 'original') {
  await fs.writeFile(
    path.join(data, '.env'),
    `ROOT_FOLDER_HOST=${data}\nRUNTIPI_APP_DATA_PATH=${path.join(root, 'application')}\nPOSTGRES_HOST=fixture-db\nPOSTGRES_PORT=5432\nPOSTGRES_USERNAME=fixture\nPOSTGRES_DBNAME=${database}\nTHEME_COLOR=blue\n`,
    { mode: 0o600 },
  );
}
async function setup(phase: 'completed' | 'rolled-back' | 'discarded' = 'rolled-back', preserved = false, beforeRuntimeFailure = false) {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-terminal-lifecycle-')));
  data = path.join(root, 'data');
  store = path.join(data, 'backups', 'restores');
  for (const name of ['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs'])
    await fs.mkdir(path.join(data, name), { recursive: true, mode: 0o700 });
  for (const name of ['app-data', 'cache']) await fs.mkdir(path.join(root, 'application', name), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(data, 'docker-compose.yml'), 'services: {}\n', { mode: 0o600 });
  await env();
  values = new Map();
  removals = [];
  removeHook = undefined;
  signal = new AbortController().signal;
  original = {
    Id: coreId,
    Name: '/fixture-runtipi-1',
    Image: image,
    Config: {
      Hostname: token(coreId),
      User: '0',
      WorkingDir: '/app',
      Cmd: ['node', './main.mjs'],
      Entrypoint: ['docker-entrypoint.sh'],
      Env: ['NODE_ENV=production'],
      Labels: {
        ...imageLabels,
        'com.docker.compose.project': 'fixture',
        'com.docker.compose.service': 'runtipi',
        'com.docker.compose.oneoff': 'false',
        'com.docker.compose.project.working_dir': data,
        'com.docker.compose.project.config_files': path.join(data, 'docker-compose.yml'),
      },
    },
    HostConfig: {
      NetworkMode: 'main',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      Memory: 1024 ** 3,
      PidsLimit: 256,
      Privileged: false,
      AutoRemove: false,
      CapAdd: null,
      CapDrop: null,
      SecurityOpt: null,
      ReadonlyRootfs: false,
      IpcMode: 'private',
      PidMode: '',
      UsernsMode: '',
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
    },
    State: { Running: true, Restarting: false, Paused: false },
    NetworkSettings: { Networks: { main: { NetworkID: networkId, EndpointID: 'original-endpoint', IPAddress: '172.24.0.3' } } },
    Mounts: [
      ...['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs', '.env'].map((name) => ({
        Type: 'bind',
        Source: path.join(data, name),
        Destination: `/data/${name}`,
        RW: true,
        Propagation: 'rprivate',
      })),
      { Type: 'bind', Source: path.join(root, 'application', 'app-data'), Destination: '/app-data', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: path.join(root, 'application', 'cache'), Destination: '/cache', RW: true, Propagation: 'rprivate' },
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false, Propagation: 'rprivate' },
      { Type: 'bind', Source: path.join(data, 'docker-compose.yml'), Destination: '/data/docker-compose.yml', RW: false, Propagation: 'rprivate' },
    ],
  } as unknown as Dockerode.ContainerInspectInfo;
  values.set(coreId, original);
  const id = randomUUID();
  const nonce = randomUUID();
  journal = await BackupRestoreJournal.create(store, {
    id,
    nonce,
    originalController: coreId,
    candidateController: coreId,
    worker: workerId,
    verifierController: verifierId,
    roots: [...restoreTreeNames],
  });
  const plans = restoreAuxiliaryContainerPlans(original, id, nonce);
  for (const [role, containerId] of [
    ['worker', workerId],
    ['verifier', verifierId],
  ] as const) {
    const plan = plans[role];
    values.set(containerId, {
      Id: containerId,
      Name: `/${plan.name}`,
      Image: image,
      Config: { ...plan, Hostname: token(containerId), Labels: { ...imageLabels, ...plan.Labels } },
      HostConfig: { ...plan.HostConfig, IpcMode: 'private', PidMode: '', UsernsMode: '', Devices: [], DeviceRequests: [] },
      State: { Running: false, Restarting: false, Paused: false, ExitCode: 0, OOMKilled: false },
      Mounts: (plan.HostConfig?.Mounts ?? []).map((m) => ({
        Type: m.Type,
        Source: m.Source,
        Destination: m.Target,
        RW: !m.ReadOnly,
        Propagation: 'rprivate',
      })),
      NetworkSettings: { Networks: { main: { NetworkID: networkId } } },
    } as unknown as Dockerode.ContainerInspectInfo);
  }
  const snapshot = snapshotRestoreContainer(original);
  operation = {
    version: 1,
    id,
    nonce,
    image,
    original: snapshot,
    candidate: snapshot,
    worker: snapshotRestoreContainer(current(workerId)),
    verifier: snapshotRestoreContainer(current(verifierId)),
    apps: [],
    resumeApps: [],
    queue: { host: 'fixture-queue', username: 'fixture', password: 'fixture' },
    database: {
      connection: { host: 'fixture-db', port: 5432, user: 'fixture', password: 'fixture', database: 'original' },
      owner: { name: `orbis_restore_${id.replaceAll('-', '')}`, oid: 1, marker: `orbis.restore.v1/${id}/${nonce}` },
      counts: { user: 1, app: 0, app_store: 0, link: 0 },
    },
    originalEnvSha256: '1'.repeat(64),
    incomingEnvSha256: '2'.repeat(64),
    files: { bytes: 0, sha256: '3'.repeat(64), files: 0, directories: 0 },
    ...(preserved ? { preservedTraefik: 1 as const, hostIdentity: { bytes: 1, sha256: '5'.repeat(64) } } : {}),
  };
  if (beforeRuntimeFailure) {
    expect(phase).toBe('discarded');
    const {
      version,
      id: identityId,
      nonce: identityNonce,
      image: identityImage,
      original: identityOriginal,
      candidate,
      worker,
      verifier,
      apps,
      queue,
    } = operation;
    const file = { bytes: 1, sha256: '8'.repeat(64) };
    await writeRestoreBootstrap(journal, {
      version: 1,
      ownerId: 1,
      identity: {
        version,
        id: identityId,
        nonce: identityNonce,
        image: identityImage,
        original: identityOriginal,
        candidate,
        worker,
        verifier,
        apps,
        queue,
      },
      connection: operation.database.connection,
      source: { version: 1, manifest: file, recovery: file, database: file, normalized: { ...file, counts: operation.database.counts } },
      environmentSha256: operation.originalEnvSha256,
    });
  } else await writeRestoreOperation(journal, operation);
  await retainRestoreControllerOwnership(journal, original);
  await fs.writeFile(path.join(root, 'application', 'app-data', 'live-marker'), 'original-live-data', { mode: 0o600 });
  const swaps: BackupDirectorySwap[] = [];
  for (const name of restoreTreeNames) {
    const target = name === 'app-data' ? path.join(root, 'application', 'app-data') : path.join(data, name);
    if (preserved && name === 'traefik') await fs.writeFile(path.join(target, 'live-network'), 'retained destination network', { mode: 0o600 });
    const swap = await BackupDirectorySwap.create({
      id,
      root: target,
      journal: journal.rootJournal(name),
      ...(preserved && name === 'traefik' ? { preserve: true } : {}),
    });
    if (phase === 'completed' && name === 'app-data')
      await fs.writeFile(path.join(swap.incomingDirectory, 'live-marker'), 'restored-live-data', { mode: 0o600 });
    if (!beforeRuntimeFailure) await swap.seal(signal);
    swaps.push(swap);
  }
  if (phase === 'discarded') {
    if (beforeRuntimeFailure) {
      const staged = swaps.find((swap) => swap.incomingDirectory === path.join(journal.rootJournal('traefik'), 'incoming'));
      if (!staged) throw Error('Missing preserved stage fixture');
      await expect(fs.writeFile(path.join(staged.incomingDirectory, 'missing-parent', 'incomplete-file'), 'preparation write')).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
      await withRestoreLease(store, () => discardRestorePayload({ journal, connection: operation.database.connection, signal }));
    } else {
      for (const swap of swaps) await swap.discardPrepared();
      await journal.advance('discarded');
    }
  } else {
    await journal.advance('prepared');
    await journal.advance('quiescing');
    if (phase === 'completed') {
      await journal.advance('promoting');
      for (const swap of swaps) await swap.promote(signal);
      await journal.advance('verifying');
      await journal.advance('committing');
      for (const swap of swaps) await swap.commit();
      await journal.advance('completed');
      await env(operation.database.owner.name);
    } else {
      await journal.advance('rolling-back');
      for (const swap of swaps) await swap.rollback();
      await journal.advance('rolled-back');
    }
  }
  await fs.writeFile(
    path.join(journal.directory, 'worker-status.json'),
    JSON.stringify({
      status: phase === 'completed' ? 'succeeded' : 'rolled-back',
      stage: 'restoring',
      message: 'Fixed terminal fixture outcome',
      updatedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  current(workerId).HostConfig.RestartPolicy = { Name: 'no', MaximumRetryCount: 0 };
  // Real filesystem operations are translated at the test boundary to model the controller’s mount namespace.
  for (const name of restoreTreeNames) {
    const file = path.join(journal.rootJournal(name), 'swap.json');
    const plan = JSON.parse(await fs.readFile(file, 'utf8'));
    plan.root = containerRoot(name);
    await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600 });
  }
  containerFilesystemBoundary();

  docker = {
    getContainer: (key: string) => ({
      inspect: async () => {
        const v = [...values.values()].find((value) => value.Id === key || value.Id.startsWith(key));
        if (!v) throw Object.assign(Error('missing'), { statusCode: 404 });
        return structuredClone(v);
      },
      remove: async (options: { force: boolean; v: boolean }) => {
        expect(options).toEqual({ force: false, v: false });
        const v = current(key);
        if (v.State.Running || v.State.Restarting || v.State.Paused) throw Object.assign(Error('running'), { statusCode: 409 });
        removals.push(key);
        values.delete(key);
        removeHook?.(key);
      },
    }),
    listContainers: async () => [...values.values()].map((v) => ({ Id: v.Id, Mounts: v.Mounts })),
    modem: {
      dial: (options: { path: string }, callback: (error: Error | null, value: unknown) => void) => {
        if (options.path.startsWith('/images/')) return callback(null, { Id: options.path.slice(8, -5), Config: { Labels: imageLabels } });
        const containers = Object.fromEntries(
          [...values.values()].map((value) => [
            value.Id,
            { EndpointID: value.NetworkSettings.Networks.main?.EndpointID, IPv4Address: `${value.NetworkSettings.Networks.main?.IPAddress}/16` },
          ]),
        );
        callback(null, {
          Id: networkId,
          Driver: 'bridge',
          Scope: 'local',
          Labels: { 'com.docker.compose.project': 'fixture', 'com.docker.compose.network': 'tipi_main_network' },
          Containers: containers,
        });
      },
    },
  } as unknown as Dockerode;
}
beforeEach(() => setup());
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function replacement(id = 'b'.repeat(64), removeOriginal = true) {
  const old = current();
  old.State.Running = false;
  const next = structuredClone(old);
  next.Id = id;
  next.Config.Hostname = token(id);
  next.State.Running = true;
  next.Image = `sha256:${'2'.repeat(64)}`;
  const endpoint = next.NetworkSettings.Networks.main;
  if (!endpoint) throw Error('Missing fixture network');
  endpoint.EndpointID = `endpoint-${id}`;
  endpoint.IPAddress = '172.24.0.4';
  if (removeOriginal) values.delete(coreId);
  else old.Name = '/fixture-retired-owned';
  values.set(id, next);
  return next;
}
it('removes only exact stopped terminal auxiliaries, keeps data/journal/status and is idempotent', async () => {
  const before = await fs.readFile(path.join(journal.directory, 'restore.json'));
  await cleanupSettledRestoreAuxiliaries(args());
  expect(removals).toEqual([verifierId, workerId]);
  expect(values.has(coreId)).toBe(true);
  expect(await fs.readFile(path.join(journal.directory, 'restore.json'))).toEqual(before);
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await BackupRestoreJournal.latest(store))?.state.phase).toBe('rolled-back');
  expect(await fs.readFile(path.join(root, 'application', 'app-data', 'live-marker'), 'utf8')).toBe('original-live-data');
  await cleanupSettledRestoreAuxiliaries(args());
  expect(removals).toHaveLength(2);
});

it.each(['completed', 'rolled-back', 'discarded'] as const)(
  'finalizes %s preserved Traefik plans without deleting or changing live files',
  async (phase) => {
    await fs.rm(root, { recursive: true, force: true });
    await setup(phase, true);
    const live = path.join(data, 'traefik', 'live-network');
    const before = await fs.lstat(live, { bigint: true });
    await cleanupSettledRestoreAuxiliaries(args());
    expect(removals).toEqual([verifierId, workerId]);
    const after = await fs.lstat(live, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    expect(await fs.readFile(live, 'utf8')).toBe('retained destination network');
    await expect(fs.lstat(path.join(journal.rootJournal('traefik'), 'incoming'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('refuses a terminal preserved plan without its explicit runtime policy before either auxiliary removal', async () => {
  await fs.rm(root, { recursive: true, force: true });
  await setup('completed', true);
  const file = path.join(journal.directory, 'runtime.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  delete saved.preservedTraefik;
  await fs.writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow();
  expect(removals).toEqual([]);
});

it('finalizes a real pre-runtime staging failure through production discard using only its validated bootstrap', async () => {
  await fs.rm(root, { recursive: true, force: true });
  await setup('discarded', true, true);
  await expect(fs.lstat(path.join(journal.directory, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const live = path.join(data, 'traefik', 'live-network');
  const before = await fs.lstat(live, { bigint: true });
  await cleanupSettledRestoreAuxiliaries(args());
  expect(removals).toEqual([verifierId, workerId]);
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await BackupRestoreJournal.latest(store))?.state.phase).toBe('discarded');
  const after = await fs.lstat(live, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.ctimeNs).toBe(before.ctimeNs);
  expect(await fs.readFile(live, 'utf8')).toBe('retained destination network');
});

it.each(['missing-bootstrap', 'invalid-bootstrap', 'stage-present', 'missing-wal', 'nonempty-wal'] as const)(
  'refuses discarded v2 %s without deleting either auxiliary',
  async (fault) => {
    await fs.rm(root, { recursive: true, force: true });
    await setup('discarded', true, true);
    const bootstrap = path.join(journal.directory, 'bootstrap.json');
    if (fault === 'missing-bootstrap') await fs.unlink(bootstrap);
    if (fault === 'invalid-bootstrap') {
      const value = JSON.parse(await fs.readFile(bootstrap, 'utf8'));
      value.identity.nonce = randomUUID();
      await fs.writeFile(bootstrap, JSON.stringify(value), { mode: 0o600 });
    }
    if (fault === 'stage-present') {
      const stage = path.join(journal.rootJournal('traefik'), 'incoming');
      await fs.mkdir(stage, { mode: 0o700 });
      const stat = await fs.lstat(stage, { bigint: true });
      const file = path.join(journal.rootJournal('traefik'), 'swap.json');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      value.staging = { device: String(stat.dev), inode: String(stat.ino) };
      await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
    }
    const wal = path.join(journal.rootJournal('traefik'), 'moves.ndjson');
    if (fault === 'missing-wal') await fs.unlink(wal);
    if (fault === 'nonempty-wal') await fs.writeFile(wal, 'unreviewed intent\n', { mode: 0o600 });
    await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow();
    expect(removals).toEqual([]);
  },
);
it.each([
  'running',
  'restarting',
  'paused',
  'wrong-nonce',
  'wrong-label',
  'extra-label',
  'wrong-mount',
  'restart-policy',
  'wrong-image',
  'privileged',
] as const)('refuses %s auxiliary proof before deleting either container', async (fault) => {
  const value = current(workerId);
  if (fault === 'running') value.State.Running = true;
  if (fault === 'restarting') value.State.Restarting = true;
  if (fault === 'paused') value.State.Paused = true;
  if (fault === 'wrong-nonce') value.Config.Labels['io.orbis.restore.nonce'] = randomUUID();
  if (fault === 'wrong-label') value.Config.Labels['io.orbis.restore.role'] = 'verifier';
  if (fault === 'extra-label') value.Config.Labels.arbitrary = 'value';
  if (fault === 'wrong-mount') {
    const m = value.Mounts[0];
    if (m) m.Source = '/unrelated';
  }
  if (fault === 'restart-policy') value.HostConfig.RestartPolicy = { Name: 'unless-stopped' };
  if (fault === 'wrong-image') value.Image = `sha256:${'9'.repeat(64)}`;
  if (fault === 'privileged') value.HostConfig.Privileged = true;
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
});
it('rechecks the other auxiliary between removals and resumes safely after a partial removal', async () => {
  removeHook = () => {
    current(workerId).State.Running = true;
  };
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([verifierId]);
  current(workerId).State.Running = false;
  removeHook = undefined;
  await cleanupSettledRestoreAuxiliaries(args());
  expect(removals).toEqual([verifierId, workerId]);
});
it('never cleans unfinished recovery or a falsely terminal per-root plan', async () => {
  const saved = journal.state;
  await fs.writeFile(path.join(journal.directory, 'restore.json'), JSON.stringify({ ...saved, phase: 'verifying', decision: null }), { mode: 0o600 });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow();
  expect(removals).toEqual([]);
  await fs.writeFile(path.join(journal.directory, 'restore.json'), JSON.stringify(saved), { mode: 0o600 });
  const file = path.join(journal.rootJournal('state'), 'swap.json');
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...plan, phase: 'prepared' }), { mode: 0o600 });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow();
  expect(removals).toEqual([]);
});
it('finalizes the terminal restore without claiming new-image health or retiring its legitimate rollback survivor', async () => {
  const next = replacement('b'.repeat(64), false);
  const before = await fs.readFile(path.join(journal.directory, 'restore.json'));
  await finalizeTerminalRestoreBeforeStartup(args(next.Id));
  expect(removals).toEqual([verifierId, workerId]);
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await readLatestTerminalPointer(store))?.phase).toBe('rolled-back');
  expect(await restoreControllerRetired(store, token(coreId))).toBe(false);
  expect(await fs.readFile(path.join(journal.directory, 'restore.json'))).toEqual(before);
  // Simulate a provider failure or SIGKILL after preboot finalization: the old survivor is still a valid rollback target.
  values.delete(next.Id);
  current().State.Running = true;
  current().Name = '/fixture-runtipi-1';
  const hostname = vi.spyOn(os, 'hostname').mockReturnValue(token(coreId));
  expect(
    await waitForRestoreStartup({
      dataDirectory: data,
      controller: token(coreId),
      installation: { phase: 'normal', transactionId: null },
      onHeld: () => undefined,
    }),
  ).toBe('ordinary');
  hostname.mockRestore();
});
it('supports removed-old-controller replacement with retained proof, subsequent recreation and another restore', async () => {
  const next = replacement();
  await finalizeTerminalRestoreBeforeStartup(args(next.Id));
  values.delete(next.Id);
  const newer = structuredClone(next);
  newer.Id = 'f'.repeat(64);
  newer.Config.Hostname = token(newer.Id);
  values.set(newer.Id, newer);
  const hostname = vi.spyOn(os, 'hostname').mockReturnValue(token(newer.Id));
  expect(
    await waitForRestoreStartup({
      dataDirectory: data,
      controller: token(newer.Id),
      installation: { phase: 'normal', transactionId: null },
      onHeld: () => undefined,
    }),
  ).toBe('ordinary');
  hostname.mockRestore();
  const another = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: newer.Id,
    candidateController: newer.Id,
    worker: '7'.repeat(64),
    verifierController: '8'.repeat(64),
    roots: [...restoreTreeNames],
  });
  expect(another.state.phase).toBe('staging');
  expect((await BackupRestoreJournal.latest(store))?.state.id).toBe(another.state.id);
});
it('supports historical-name proof for a stopped renamed predecessor, but refuses missing old ownership', async () => {
  await fs.unlink(path.join(journal.directory, 'controller-ownership.json'));
  const next = replacement('b'.repeat(64), false);
  await finalizeTerminalRestoreBeforeStartup(args(next.Id));
  expect((await readTerminalOwnership(journal.directory, journal.state))?.name).toBe(next.Name);
});
it('refuses an absent predecessor without retained ownership', async () => {
  await fs.unlink(path.join(journal.directory, 'controller-ownership.json'));
  const next = replacement();
  await expect(finalizeTerminalRestoreBeforeStartup(args(next.Id))).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
});
it.each(['name', 'root', 'mount', 'protocol', 'command', 'network', 'other-writer', 'running-original'] as const)(
  'refuses forged replacement %s without approving an arbitrary controller',
  async (fault) => {
    const next = replacement('b'.repeat(64), fault !== 'running-original');
    if (fault === 'name') next.Name = '/arbitrary-new-name';
    if (fault === 'root') next.Config.Labels['com.docker.compose.project.working_dir'] = '/unrelated';
    if (fault === 'mount') {
      const m = next.Mounts[0];
      if (m) m.Source = '/unrelated';
    }
    if (fault === 'protocol') next.Config.Labels['io.orbis.installation-protocol'] = 'unsupported';
    if (fault === 'command') next.Config.Cmd = ['node', '/unrelated.mjs'];
    if (fault === 'network') {
      const ep = next.NetworkSettings.Networks.main;
      if (ep) ep.EndpointID = '';
    }
    if (fault === 'running-original') current().State.Running = true;
    if (fault === 'other-writer') {
      const unknown = structuredClone(next);
      unknown.Id = '9'.repeat(64);
      unknown.Mounts = [{ Type: 'bind', Source: data, Destination: '/unknown', RW: true } as Dockerode.ContainerInspectInfo['Mounts'][number]];
      values.set(unknown.Id, unknown);
    }
    await expect(finalizeTerminalRestoreBeforeStartup(args(next.Id))).rejects.toThrow('ownership review');
    expect(await readLatestTerminalPointer(store)).toBeUndefined();
    expect(removals).toEqual([]);
  },
);

it.each(['completed', 'rolled-back', 'discarded'] as const)('releases only durable %s outcomes and retains terminal status', async (phase) => {
  await fs.rm(root, { recursive: true, force: true });
  await setup(phase);
  const before = await fs.readFile(path.join(journal.directory, 'restore.json'));
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await BackupRestoreJournal.latest(store))?.state.phase).toBe(phase);
  expect(await fs.readFile(path.join(journal.directory, 'restore.json'))).toEqual(before);
});
it('preserves live data and unrelated directories while removing only this generation’s reserved working trees', async () => {
  const unrelated = path.join(root, 'application', 'app-data', '.orbis-restore-unrelated.incoming');
  await fs.mkdir(unrelated, { mode: 0o700 });
  await fs.writeFile(path.join(unrelated, 'keep'), 'unrelated', { mode: 0o600 });
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await fs.readFile(path.join(unrelated, 'keep'), 'utf8')).toBe('unrelated');
  expect(await fs.readFile(path.join(root, 'application', 'app-data', 'live-marker'), 'utf8')).toBe('original-live-data');
});
it('retries partial working-tree cleanup without releasing the barrier early', async () => {
  const cleanup = BackupDirectorySwap.prototype.cleanup;
  let calls = 0;
  const spy = vi.spyOn(BackupDirectorySwap.prototype, 'cleanup').mockImplementation(async function (this: BackupDirectorySwap) {
    if (++calls === 2) throw Error('interrupted cleanup');
    await cleanup.call(this);
  });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(await BackupRestoreJournal.active(store)).toBeDefined();
  expect(await readLatestTerminalPointer(store)).toBeUndefined();
  spy.mockRestore();
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
});
it('writes the latest outcome before releasing the active pointer and retries an interrupted release', async () => {
  const unlink = fs.unlink.bind(fs);
  const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
    if (String(file) === path.join(store, 'active.json')) throw Error('interrupted before unlink');
    return unlink(file);
  });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(await BackupRestoreJournal.active(store)).toBeDefined();
  expect((await readLatestTerminalPointer(store))?.id).toBe(journal.state.id);
  spy.mockRestore();
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect(await restoreControllerRetired(store, token(coreId))).toBe(false);
});
it('retains outcome and old-image rollback safety even if release reports failure after unlink', async () => {
  const unlink = fs.unlink.bind(fs);
  const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
    await unlink(file);
    if (String(file) === path.join(store, 'active.json')) throw Error('interrupted after unlink');
  });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  spy.mockRestore();
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await BackupRestoreJournal.latest(store))?.state.phase).toBe('rolled-back');
  expect(await restoreControllerRetired(store, token(coreId))).toBe(false);
});

it.each(['missing', 'running', 'recovery-required', 'succeeded'] as const)(
  'refuses %s worker outcome even when journal and root phases appear terminal',
  async (status) => {
    const file = path.join(journal.directory, 'worker-status.json');
    if (status === 'missing') await fs.unlink(file);
    else
      await fs.writeFile(file, JSON.stringify({ status, stage: 'restoring', message: 'Fixed nonterminal fixture outcome', updatedAt: Date.now() }), {
        mode: 0o600,
      });
    await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
    expect(removals).toEqual([]);
    expect(await BackupRestoreJournal.active(store)).toBeDefined();
  },
);

it('preserves retired nonsurvivors while keeping the survivor available for rollback', async () => {
  const retired = '8'.repeat(64);
  await fs.writeFile(path.join(store, 'retired.json'), JSON.stringify([retired]), { mode: 0o600 });
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await restoreControllerRetired(store, token(coreId))).toBe(false);
  expect(await restoreControllerRetired(store, token(retired))).toBe(true);
  const hostname = vi.spyOn(os, 'hostname').mockReturnValue(token(retired));
  await expect(
    waitForRestoreStartup({
      dataDirectory: data,
      controller: token(retired),
      installation: { phase: 'normal', transactionId: null },
      onHeld: () => undefined,
    }),
  ).rejects.toThrow('ownership review');
  hostname.mockRestore();
});
it('does not overwrite an unsupported latest-terminal pointer or delete auxiliaries', async () => {
  await fs.writeFile(path.join(store, 'latest-terminal.json'), JSON.stringify({ version: 2 }), { mode: 0o600 });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
  expect(await fs.readFile(path.join(store, 'latest-terminal.json'), 'utf8')).toBe(JSON.stringify({ version: 2 }));
});
it('leaves the active pointer intact when latest outcome publication fails', async () => {
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(store, 'latest-terminal.json')) throw Error('publication interrupted');
    return rename(from, to);
  });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(await BackupRestoreJournal.active(store)).toBeDefined();
  expect(await readLatestTerminalPointer(store)).toBeUndefined();
  spy.mockRestore();
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
});
it('refuses active-pointer replacement before release rather than unlinking another generation', async () => {
  const other = { id: randomUUID(), nonce: randomUUID() };
  removeHook = (id) => {
    if (id === workerId) writeFileSync(path.join(store, 'active.json'), JSON.stringify(other), { mode: 0o600 });
  };
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(JSON.parse(await fs.readFile(path.join(store, 'active.json'), 'utf8'))).toEqual(other);
  expect(await readLatestTerminalPointer(store)).toBeUndefined();
});

it('allows ordinary appearance and hostname settings changes without binding a mutable whole environment', async () => {
  await fs.appendFile(path.join(data, '.env'), 'THEME_COLOR=red\nDOMAIN=changed.example.test\nLOCAL_DOMAIN=changed.home.arpa\n');
  current().Config.Env?.push('DOMAIN=changed.example.test');
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
});
it('rejects an unexpected protected database pointer before removing containers', async () => {
  await env('unreviewed-database');
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
});
it('uses non-force removal so a restart immediately after final inspection cannot delete a running auxiliary', async () => {
  const get = docker.getContainer.bind(docker);
  vi.spyOn(docker, 'getContainer').mockImplementation((id) => {
    const handle = get(id);
    const remove = handle.remove.bind(handle);
    handle.remove = ((options: unknown) => {
      if (id === verifierId) current(verifierId).State.Running = true;
      return remove(options as Dockerode.ContainerRemoveOptions);
    }) as typeof handle.remove;
    return handle;
  });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
  expect(current(verifierId).State.Running).toBe(true);
  expect(await BackupRestoreJournal.active(store)).toBeDefined();
});
it('does not overwrite an unknown ownership schema', async () => {
  const file = path.join(journal.directory, 'controller-ownership.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...original, version: 2 }), { mode: 0o600 });
  await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
  expect(removals).toEqual([]);
  expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(2);
});

it('finalizes discarded inert preparation using ownership retained before any source claim or runtime file', async () => {
  await fs.rm(root, { recursive: true, force: true });
  await setup('discarded');
  await fs.unlink(path.join(journal.directory, 'runtime.json'));
  await fs.unlink(path.join(journal.directory, 'worker-status.json'));
  for (const id of [workerId, verifierId]) {
    current(id).State.StartedAt = '0001-01-01T00:00:00Z';
    current(id).RestartCount = 0;
  }
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
  expect((await BackupRestoreJournal.latest(store))?.state.phase).toBe('discarded');
});
it('preserves legacy same-original repeat preparation when inert discarded auxiliaries and all root plans are already absent', async () => {
  await fs.rm(root, { recursive: true, force: true });
  await setup('discarded');
  for (const name of ['runtime.json', 'worker-status.json', 'controller-ownership.json']) await fs.unlink(path.join(journal.directory, name));
  for (const name of journal.state.roots) await fs.rm(journal.rootJournal(name), { recursive: true, force: true });
  values.delete(workerId);
  values.delete(verifierId);
  await cleanupSettledRestoreAuxiliaries(args());
  expect((await BackupRestoreJournal.active(store))?.state.phase).toBe('discarded');
  expect(await readLatestTerminalPointer(store)).toBeUndefined();
  const next = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: coreId,
    candidateController: coreId,
    worker: '7'.repeat(64),
    verifierController: '8'.repeat(64),
    roots: [...restoreTreeNames],
  });
  expect(next.state.phase).toBe('staging');
});

it.each(['unknown-live-data', 'recorded-reserved-data', 'recorded-live-data'] as const)(
  'limits resumed app writers to recorded live app data: %s',
  async (kind) => {
    const app = structuredClone(current());
    app.Id = '8'.repeat(64);
    app.Mounts = [
      {
        Type: 'bind',
        Source: path.join(
          root,
          'application',
          'app-data',
          kind === 'recorded-reserved-data' ? `.orbis-restore-${journal.state.id}.previous` : 'fixture-app',
        ),
        Destination: '/application-data',
        RW: true,
      } as Dockerode.ContainerInspectInfo['Mounts'][number],
    ];
    values.set(app.Id, app);
    if (kind !== 'unknown-live-data') {
      operation.apps = [{ container: snapshotRestoreContainer(app), project: 'fixture-app' }];
      await fs.writeFile(path.join(journal.directory, 'runtime.json'), JSON.stringify(operation), { mode: 0o600 });
    }
    if (kind === 'recorded-live-data') {
      await cleanupSettledRestoreAuxiliaries(args());
      expect(removals).toEqual([verifierId, workerId]);
      expect(current(app.Id).State.Running).toBe(true);
    } else {
      await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
      expect(removals).toEqual([]);
    }
  },
);

it('removes the exclusive temporary link before the successful directory durability sync', async () => {
  const file = path.join(journal.directory, 'durable-order.json');
  const open = nativeFilesystem.open;
  let synced = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === journal.directory) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        expect((await fs.lstat(file)).nlink).toBe(1);
        expect((await fs.readdir(journal.directory)).filter((name) => name.startsWith('.terminal-'))).toEqual([]);
        synced = true;
        return sync();
      });
    }
    return handle;
  });
  await writeTerminalJson(file, { version: 1 }, true);
  expect(synced).toBe(true);
  expect(await readTerminalJson(file)).toEqual({ version: 1 });
});
it('keeps ambiguous hard-link remnants fail closed rather than adopting them as ownership', async () => {
  const file = path.join(journal.directory, 'ambiguous.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await fs.link(file, path.join(journal.directory, '.terminal-interrupted'));
  await expect(readTerminalJson(file)).rejects.toThrow('ownership review');
  await expect(writeTerminalJson(file, { version: 1 }, true)).rejects.toThrow();
  expect((await fs.lstat(file)).nlink).toBe(2);
});

it('rejects success when injected unlink failure leaves an exclusive hard-link alias ambiguous', async () => {
  const file = path.join(journal.directory, 'injected-order.json');
  const rm = fs.rm.bind(fs);
  vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]).includes('/.terminal-')) throw new Error('injected unlink failure');
    return rm(...args);
  });
  await expect(writeTerminalJson(file, { version: 1 }, true)).rejects.toThrow('injected unlink failure');
  expect((await fs.lstat(file)).nlink).toBe(2);
  await expect(readTerminalJson(file)).rejects.toThrow('ownership review');
});

it('finalizes container-path journals while preserving distinct physical bind-source ownership', async () => {
  const ownership = await readTerminalOwnership(journal.directory, journal.state);
  const plan = JSON.parse(await fs.readFile(path.join(journal.rootJournal('state'), 'swap.json'), 'utf8'));
  expect(ownership?.layout.roots.state).toBe(path.join(data, 'state'));
  expect(plan.root).toBe('/data/state');
  expect(plan.root).not.toBe(ownership?.layout.roots.state);
  await cleanupSettledRestoreAuxiliaries(args());
  expect(await BackupRestoreJournal.active(store)).toBeUndefined();
});
it.each(['host-source-alias', 'unbound-plan', 'swapped-plan', 'swapped-mount', 'unbound-mount', 'wrong-generation', 'wrong-inode'] as const)(
  'refuses namespace proof mismatch %s before any auxiliary removal',
  async (kind) => {
    const file = path.join(journal.rootJournal('state'), 'swap.json');
    const plan = JSON.parse(await fs.readFile(file, 'utf8'));
    if (kind === 'host-source-alias') plan.root = path.join(data, 'state');
    if (kind === 'unbound-plan') plan.root = '/unbound/state';
    if (kind === 'swapped-plan') plan.root = '/app-data';
    if (kind === 'wrong-generation') plan.id = randomUUID();
    if (kind === 'wrong-inode') plan.inode = String(BigInt(plan.inode) + 1n);
    if (kind === 'swapped-mount') {
      const state = current().Mounts.find((item) => item.Destination === '/data/state');
      const app = current().Mounts.find((item) => item.Destination === '/app-data');
      if (!state || !app) throw Error('Missing fixture binds');
      state.Destination = '/app-data';
      app.Destination = '/data/state';
    }
    if (kind === 'unbound-mount') {
      const mount = current().Mounts.find((item) => item.Destination === '/data/state');
      if (mount) mount.Destination = '/unbound/state';
    }
    await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600 });
    await expect(cleanupSettledRestoreAuxiliaries(args())).rejects.toThrow('ownership review');
    expect(removals).toEqual([]);
  },
);
