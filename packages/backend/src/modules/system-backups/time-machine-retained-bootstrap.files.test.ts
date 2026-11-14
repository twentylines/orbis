import { createHash, randomUUID } from 'node:crypto';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal } from './backup-restore-journal';
import { restoreTreeNames } from './backup-restore-materialize';
import { recordRetainedRestoreAdmission } from './time-machine-restore-admission';
import { bindRetainedJournal } from './time-machine-retained-bootstrap';
import { readRetainedRestoreContext } from './time-machine-retained-context';
import { writeRestoreBootstrap } from './backup-restore-bootstrap';
import { BackupRestoreDockerRuntime, snapshotRestoreContainer } from './backup-restore-runtime';
import type Dockerode from 'dockerode';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(options: { version?: 1 | 2; mediaPolicy?: 'included' | 'preserve-destination'; selectedRoots?: string[] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-binding-')));
  roots.push(root);
  const store = path.join(root, 'store');
  const restoreId = randomUUID();
  const nonce = randomUUID();
  const pointId = randomUUID();
  const importId = randomUUID();
  const original = 'a'.repeat(64);
  const journal = await BackupRestoreJournal.create(store, {
    id: restoreId,
    nonce,
    originalController: original,
    candidateController: original,
    worker: 'b'.repeat(64),
    verifierController: 'c'.repeat(64),
    roots: options.selectedRoots ?? [...restoreTreeNames],
  });
  const manifest = Buffer.from(
    JSON.stringify({
      format: 'orbis-full-backup',
      version: options.version ?? 1,
      ...(options.version === 2 ? { mediaPolicy: options.mediaPolicy ?? 'included' } : {}),
      createdAt: 1,
      orbisVersion: 'v0.8.0-beta.3',
      runtipiVersion: '4.10.1',
      architecture: 'arm64',
      files: [],
      directories: [],
      containers: [],
      images: [],
      exclusions: [],
    }),
  );
  const manifestSeal = { bytes: manifest.length, sha256: createHash('sha256').update(manifest).digest('hex') };
  const manifestPath = path.join(journal.directory, 'source', 'payload', 'content', 'manifest.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(manifestPath, manifest, { mode: 0o600 });
  await recordRetainedRestoreAdmission(
    journal,
    1,
    importId,
    { pointId, reviewId: randomUUID(), archiveSha256: '1'.repeat(64), manifestSha256: manifestSeal.sha256, machineId: '3'.repeat(64) },
    { sha256: '4'.repeat(64), verify: async () => undefined },
  );
  const image = `sha256:${'6'.repeat(64)}`;
  const inspect = (id: string, imageId: string) =>
    ({
      Id: id,
      Name: `/${id.slice(0, 8)}`,
      Image: imageId,
      Config: { Env: [], Labels: {} },
      HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } },
      Mounts: [],
      NetworkSettings: { Networks: {} },
      State: { Running: false, Restarting: false, Paused: false },
    }) as unknown as Dockerode.ContainerInspectInfo;
  const originalContainer = inspect(original, image);
  const snapshot = snapshotRestoreContainer(originalContainer);
  const seal = { bytes: 1, sha256: '2'.repeat(64) };
  const bootstrap = {
    version: 1 as const,
    ownerId: 1,
    identity: {
      version: 1 as const,
      id: restoreId,
      nonce,
      image,
      original: snapshot,
      candidate: snapshot,
      verifier: snapshotRestoreContainer(inspect('c'.repeat(64), image)),
      worker: snapshotRestoreContainer(inspect('b'.repeat(64), image)),
      apps: [],
      queue: { host: 'queue', username: 'fixture', password: 'fixture' },
    },
    connection: { host: 'db', port: 5432, user: 'fixture', password: 'fixture', database: 'db' },
    source: {
      version: 1 as const,
      manifest: manifestSeal,
      recovery: seal,
      database: seal,
      normalized: { ...seal, counts: { user: 0, app: 0, app_store: 0, link: 0 } },
    },
    environmentSha256: 'b'.repeat(64),
  };
  await writeRestoreBootstrap(journal, bootstrap);
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const sourceBinding = {
    originalJournalSha256: sha(canonicalPublicationJson(journal.state)),
    bootstrapSha256: sha(await fs.readFile(path.join(journal.directory, 'bootstrap.json'))),
    admissionSha256: sha(await fs.readFile(path.join(journal.directory, 'time-machine-admission.json'))),
    sourceSealSha256: sha(canonicalPublicationJson(bootstrap.source)),
    legacyManifestSha256: manifestSeal.sha256,
    runtimeManifestSha256: '5'.repeat(64),
  };
  const target = {
    publication: {
      schema: 'orbis.release.v1' as const,
      image: 'ghcr.io/twentylines/orbis' as const,
      tag: 'v0.5.0-beta.3',
      commit: 'f'.repeat(40),
      digest: `sha256:${'1'.repeat(64)}`,
      runtipiCompatibility: '4.10.1' as const,
    },
    creationReference: `sha256:${'2'.repeat(64)}`,
    platform: { os: 'linux' as const, architecture: 'arm64' as const },
    platformManifestDigest: `sha256:${'2'.repeat(64)}`,
    configDigest: `sha256:${'3'.repeat(64)}`,
  };
  let binding = {
    restoreId,
    nonce,
    pointId,
    originalController: original,
    candidateController: 'd'.repeat(64),
    verifierController: 'e'.repeat(64),
    workerId: 'f'.repeat(64),
    target,
    migrationsPath: `/data/backups/restores/${restoreId}/retained/migrations`,
    workerSnapshot: { id: 'root-fixture' } as unknown,
    sourceBinding,
  };
  const rootStatus = vi.fn(async () => ({
    version: 1,
    transactionId: restoreId,
    pointId,
    state: 'allocated',
    decision: null,
    recoverable: true,
    admissionSha256: sourceBinding.admissionSha256,
    binding: structuredClone(binding),
  }));
  const verifyRootWorker = vi.fn(async () => undefined);
  return {
    store,
    image,
    inspect,
    originalContainer,
    manifestPath,
    snapshot,
    sourceBinding,
    restoreId,
    nonce,
    pointId,
    importId,
    journal,
    target,
    rootStatus,
    verifyRootWorker,
    change: (value: Partial<typeof binding>) => {
      binding = { ...binding, ...value };
    },
    run: () =>
      bindRetainedJournal({
        store,
        restoreId,
        nonce,
        pointId,
        ownerId: 1,
        importId,
        expectedTarget: target,
        expectedRuntimeManifestSha256: '5'.repeat(64),
        rootStatus,
        verifyRootWorker,
      }),
  };
}
it('rebinds a staging journal only to a freshly root-verified point and recovers the exact same binding', async () => {
  const test = await fixture();
  const next = await test.run();
  expect(next.state).toMatchObject({
    id: test.restoreId,
    nonce: test.nonce,
    originalController: 'a'.repeat(64),
    candidateController: 'd'.repeat(64),
    verifierController: 'e'.repeat(64),
    worker: 'f'.repeat(64),
    phase: 'staging',
  });
  expect(test.rootStatus).toHaveBeenCalledTimes(3);
  expect(test.verifyRootWorker).toHaveBeenCalledTimes(2);
  const again = await test.run();
  expect(again.state).toEqual(next.state);
  test.change({ workerId: '9'.repeat(64) });
  await expect(test.run()).rejects.toThrow();
  expect((await BackupRestoreJournal.active(test.store))?.state).toEqual(next.state);
});
it.each(['point', 'original', 'target', 'worker', 'status-change'] as const)('rejects a root binding mismatch: %s', async (kind) => {
  const test = await fixture();
  if (kind === 'point') test.change({ pointId: randomUUID() });
  if (kind === 'original') test.change({ originalController: '9'.repeat(64) });
  if (kind === 'target') test.change({ target: { ...test.target, configDigest: `sha256:${'9'.repeat(64)}` } });
  if (kind === 'worker') test.verifyRootWorker.mockRejectedValue(new Error('worker rejected'));
  if (kind === 'status-change')
    test.rootStatus.mockImplementationOnce(async () => ({
      version: 1,
      transactionId: test.restoreId,
      pointId: test.pointId,
      state: 'allocated',
      decision: null,
      recoverable: true,
      admissionSha256: test.sourceBinding.admissionSha256,
      binding: {
        restoreId: test.restoreId,
        nonce: test.nonce,
        pointId: test.pointId,
        originalController: 'a'.repeat(64),
        candidateController: 'd'.repeat(64),
        verifierController: 'e'.repeat(64),
        workerId: '9'.repeat(64),
        target: test.target,
        migrationsPath: `/data/backups/restores/${test.restoreId}/retained/migrations`,
        workerSnapshot: { id: 'root-fixture' },
        sourceBinding: test.sourceBinding,
      },
    }));
  const before = test.journal.state;
  await expect(test.run()).rejects.toThrow();
  expect((await BackupRestoreJournal.active(test.store))?.state).toEqual(before);
});

it.each([
  'originalJournalSha256',
  'bootstrapSha256',
  'admissionSha256',
  'sourceSealSha256',
  'legacyManifestSha256',
  'runtimeManifestSha256',
] as const)('rejects a mismatched root-pinned source binding: %s', async (field) => {
  const test = await fixture();
  test.change({ sourceBinding: { ...test.sourceBinding, [field]: '9'.repeat(64) } });
  const before = test.journal.state;
  await expect(test.run()).rejects.toThrow();
  expect((await BackupRestoreJournal.active(test.store))?.state).toEqual(before);
});
it('rejects altered original bootstrap bytes after root recorded their digest', async () => {
  const test = await fixture();
  const file = path.join(test.journal.directory, 'bootstrap.json');
  await fs.appendFile(file, ' ');
  await expect(test.run()).rejects.toThrow();
  expect((await BackupRestoreJournal.active(test.store))?.state).toEqual(test.journal.state);
});

it.each([
  { version: 1 as const, mediaPolicy: 'included' as const, preserveLiveProxy: false, selectedRoots: [...restoreTreeNames] },
  {
    version: 1 as const,
    mediaPolicy: 'included' as const,
    preserveLiveProxy: true,
    selectedRoots: ['state', 'apps', 'repos', 'media', 'user-config', 'app-data'],
  },
  { version: 2 as const, mediaPolicy: 'included' as const, preserveLiveProxy: false, selectedRoots: [...restoreTreeNames] },
  {
    version: 2 as const,
    mediaPolicy: 'included' as const,
    preserveLiveProxy: true,
    selectedRoots: ['state', 'apps', 'repos', 'media', 'user-config', 'app-data'],
  },
  {
    version: 2 as const,
    mediaPolicy: 'preserve-destination' as const,
    preserveLiveProxy: false,
    selectedRoots: ['state', 'apps', 'repos', 'user-config', 'traefik', 'app-data'],
  },
  {
    version: 2 as const,
    mediaPolicy: 'preserve-destination' as const,
    preserveLiveProxy: true,
    selectedRoots: ['state', 'apps', 'repos', 'user-config', 'app-data'],
  },
])('reconstructs v$version/$mediaPolicy context with preserveLiveProxy=$preserveLiveProxy and immutable original identities', async (options) => {
  const test = await fixture(options);
  const { image, inspect, originalContainer: original, snapshot } = test;
  const candidate = inspect('d'.repeat(64), test.target.creationReference);
  const verifier = inspect('e'.repeat(64), test.target.creationReference);
  const worker = inspect('f'.repeat(64), image);
  worker.Mounts = [
    {
      Type: 'bind',
      Source: '/protected/migrations',
      Destination: `/data/backups/restores/${test.restoreId}/retained`,
      RW: false,
      Mode: '',
      Propagation: 'rprivate',
    },
    {
      Type: 'bind',
      Source: '/protected/source',
      Destination: `/data/backups/restores/${test.restoreId}/source/payload`,
      RW: false,
      Mode: '',
      Propagation: 'rprivate',
    },
  ];
  const rootSnapshot = {
    Id: worker.Id,
    Image: worker.Image,
    Config: worker.Config,
    HostConfig: worker.HostConfig,
    Mounts: worker.Mounts,
    NetworkSettings: { Networks: worker.NetworkSettings.Networks },
  };
  test.change({ workerSnapshot: rootSnapshot });
  const journal = await test.run();
  const status = await test.rootStatus();
  const values = new Map([
    [original.Id, original],
    [candidate.Id, candidate],
    [verifier.Id, verifier],
    [worker.Id, worker],
  ]);
  const docker = {
    getContainer: (id: string) => ({ inspect: async () => values.get(id) }),
    getImage: () => ({ inspect: async () => ({ Id: image, Config: { Env: [] } }) }),
  } as unknown as Dockerode;
  const verify = vi.spyOn(BackupRestoreDockerRuntime.prototype, 'verifyWorker').mockResolvedValue(worker.Id);
  const input = {
    journal,
    rootBinding: status.binding,
    expectedPointId: test.pointId,
    expectedRuntimeManifestSha256: '5'.repeat(64),
    ownerId: 1,
    importId: test.importId,
    docker,
    hostname: worker.Id,
    preserveLiveProxy: options.preserveLiveProxy,
    directories: { data: '/data', appData: '/app-data', cache: '/cache' },
  };
  const context = await readRetainedRestoreContext(input);
  expect(context.bootstrap.identity.original).toEqual(snapshot);
  expect(context.bootstrap.identity.candidate.id).toBe(candidate.Id);
  expect(context.bootstrap.identity.verifier.id).toBe(verifier.Id);
  expect(context.bootstrap.identity.worker?.id).toBe(worker.Id);
  expect(verify).toHaveBeenCalledOnce();
  await expect(readRetainedRestoreContext({ ...input, preserveLiveProxy: !options.preserveLiveProxy })).rejects.toThrow(
    'Retained restore context could not be verified.',
  );
  expect(verify).toHaveBeenCalledOnce();
  await journal.advance('discarded');
  await expect(readRetainedRestoreContext(input)).resolves.toMatchObject({ binding: { restoreId: test.restoreId } });
  expect(verify).toHaveBeenLastCalledWith(worker.Id, { preparing: true });
  await expect(readRetainedRestoreContext({ ...input, rootBinding: { ...status.binding, workerId: '9'.repeat(64) } })).rejects.toThrow();
  await fs.appendFile(path.join(journal.directory, 'bootstrap.json'), ' ');
  await expect(readRetainedRestoreContext(input)).rejects.toThrow();
  verify.mockRestore();
});

it.each([
  { mediaPolicy: 'included' as const, selectedRoots: ['state', 'apps', 'repos', 'user-config', 'traefik', 'app-data'] },
  { mediaPolicy: 'preserve-destination' as const, selectedRoots: [...restoreTreeNames] },
  { mediaPolicy: 'preserve-destination' as const, selectedRoots: ['apps', 'repos', 'user-config', 'traefik', 'app-data'] },
  { mediaPolicy: 'preserve-destination' as const, selectedRoots: ['state', 'apps', 'repos', 'user-config', 'traefik'] },
])('rejects root selection $selectedRoots against the authenticated $mediaPolicy manifest', async (options) => {
  const test = await fixture({ version: 2, ...options });
  const journal = await test.run();
  const getContainer = vi.fn();
  await expect(
    readRetainedRestoreContext({
      journal,
      rootBinding: (await test.rootStatus()).binding,
      expectedPointId: test.pointId,
      expectedRuntimeManifestSha256: '5'.repeat(64),
      ownerId: 1,
      importId: test.importId,
      docker: { getContainer } as unknown as Dockerode,
      hostname: 'f'.repeat(64),
      directories: { data: '/data', appData: '/app-data', cache: '/cache' },
    }),
  ).rejects.toThrow('Retained restore context could not be verified.');
  expect(getContainer).not.toHaveBeenCalled();
  expect((await journal.refresh()).phase).toBe('staging');
});

it.each(['bytes', 'public-mode', 'symlink', 'hardlink'] as const)(
  'rejects %s changes to the root-bound media policy before inspecting Docker',
  async (change) => {
    const test = await fixture();
    const journal = await test.run();
    if (change === 'bytes') await fs.appendFile(test.manifestPath, ' ');
    else if (change === 'public-mode') await fs.chmod(test.manifestPath, 0o644);
    else if (change === 'hardlink') await fs.link(test.manifestPath, `${test.manifestPath}.other`);
    else {
      await fs.rename(test.manifestPath, `${test.manifestPath}.original`);
      await fs.symlink(`${test.manifestPath}.original`, test.manifestPath);
    }
    const getContainer = vi.fn();
    await expect(
      readRetainedRestoreContext({
        journal,
        rootBinding: (await test.rootStatus()).binding,
        expectedPointId: test.pointId,
        expectedRuntimeManifestSha256: '5'.repeat(64),
        ownerId: 1,
        importId: test.importId,
        docker: { getContainer } as unknown as Dockerode,
        hostname: 'f'.repeat(64),
        directories: { data: '/data', appData: '/app-data', cache: '/cache' },
      }),
    ).rejects.toThrow();
    expect(getContainer).not.toHaveBeenCalled();
    expect((await journal.refresh()).phase).toBe('staging');
  },
);
