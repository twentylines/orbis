import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import dotenv from 'dotenv';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupDirectorySwap } from './backup-directory-swap';
import { withRestoreLease } from './backup-restore-lease';
import { restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';
import { prepareRestorePayload, discardRestorePayload, type RestorePreparationProgress } from './backup-restore-preparation';
import { prepareRestoreDatabase, removeRestoreDatabase } from './backup-restore-database';
import { makeReviewedBackupFixture, fileMetadata, directoryMetadata } from './backup-restore-source.fixture';
import { pinBackupSource } from './backup-restore-source';
import { readRestoreOperation } from './backup-restore-runtime';

vi.mock('./backup-restore-database', () => ({ prepareRestoreDatabase: vi.fn(), removeRestoreDatabase: vi.fn() }));
let temporary: string;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-prepare-payload-')));
  await fs.chmod(temporary, 0o700);
  vi.mocked(removeRestoreDatabase).mockResolvedValue(true);
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

async function fixture() {
  const store = path.join(temporary, 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    verifierController: '3'.repeat(64),
    worker: '4'.repeat(64),
    roots: [...restoreTreeNames],
  });
  const source = await makeReviewedBackupFixture(temporary, { dbStatus: 'running' });
  for (const name of ['app-data', 'data/repos', 'data/media', 'data/user-config', 'data/traefik']) {
    await fs.mkdir(path.join(source.content, name), { mode: 0o700 });
    source.manifest.directories.push(await directoryMetadata(source.content, name));
  }
  for (const [name, bytes] of [
    ['data/.env', 'SOURCE_HOST=previous\n'],
    ['data/state/settings.json', '{"timeZone":"UTC"}'],
    ['app-data/document.txt', 'restored app document'],
  ]) {
    await fs.writeFile(path.join(source.content, name as string), bytes as string, { mode: 0o600 });
    source.manifest.files.push(await fileMetadata(source.content, name as string));
  }
  const manifest = Buffer.from(JSON.stringify(source.manifest));
  await fs.writeFile(path.join(source.content, 'manifest.json'), manifest);
  source.seal.manifest = { bytes: manifest.length, sha256: hash(manifest) };
  const pinned = await pinBackupSource({
    directory: source.directory,
    destination: path.join(journal.directory, 'source'),
    expected: source.seal,
    signal: signal(),
  });
  const roots = {} as Record<RestoreTreeName, string>;
  for (const name of restoreTreeNames) {
    roots[name] = path.join(temporary, `target-${name}`);
    await fs.mkdir(roots[name], { mode: 0o700 });
    await fs.writeFile(path.join(roots[name], 'original.txt'), `original ${name}`);
  }
  const connection = { host: 'target-db', port: 5432, user: 'fixture', password: 'disposable database fixture', database: 'original' };
  const queue = { host: 'target-queue', username: 'fixture', password: 'disposable queue fixture' };
  const target = {
    POSTGRES_HOST: connection.host,
    POSTGRES_USERNAME: connection.user,
    POSTGRES_PASSWORD: connection.password,
    POSTGRES_DBNAME: connection.database,
    RABBITMQ_HOST: queue.host,
    RABBITMQ_USERNAME: queue.username,
    RABBITMQ_PASSWORD: queue.password,
    ROOT_FOLDER_HOST: '/srv/target',
    RUNTIPI_APP_DATA_PATH: '/srv/target-app-data',
    ARCHITECTURE: 'arm64',
    TIPI_VERSION: '4.10.1',
    APPS_REPO_URL: 'https://example.invalid/target.git',
    TZ: 'UTC',
    INTERNAL_IP: '127.0.0.1',
    DOMAIN: '',
    LOCAL_DOMAIN: '',
    RUNTIPI_FORWARD_AUTH_URL: 'http://target-controller:3000/api/auth/traefik',
  };
  const environment = path.join(temporary, 'target-environment');
  await fs.writeFile(
    environment,
    `${Object.entries(target)
      .map(([key, value]) => `${key}='${value}'`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  const snapshot = (id: string) => ({
    id: id.repeat(64),
    fingerprint: id.repeat(64),
    running: id === '1',
    restart: { Name: 'no' as const, MaximumRetryCount: 0 },
  });
  const options = {
    journal,
    source: { ...pinned, seal: source.seal },
    roots,
    environment,
    trustedMigrationsFolder: '/app/trusted-migrations',
    runtime: {
      image: `sha256:${'a'.repeat(64)}`,
      original: snapshot('1'),
      candidate: snapshot('1'),
      verifier: snapshot('3'),
      apps: [],
      queue,
      connection,
    },
    signal: signal(),
    progress: vi.fn<(value: RestorePreparationProgress) => void>(),
  };
  const owner = {
    name: `orbis_restore_${journal.state.id.replaceAll('-', '')}`,
    oid: 42,
    marker: `orbis.restore.v1/${journal.state.id}/${journal.state.nonce}`,
  };
  vi.mocked(prepareRestoreDatabase).mockImplementation(async (input) => {
    await input.onCreated(owner);
    expect(JSON.parse(await fs.readFile(path.join(journal.directory, 'database-owner.json'), 'utf8'))).toEqual(owner);
    input.progress(3, 3);
    return owner;
  });
  return { options, owner, store };
}
const prepare = (test: Awaited<ReturnType<typeof fixture>>) => withRestoreLease(test.store, () => prepareRestorePayload(test.options));
const discard = (test: Awaited<ReturnType<typeof fixture>>) =>
  withRestoreLease(test.store, () =>
    discardRestorePayload({ journal: test.options.journal, connection: test.options.runtime.connection, signal: signal() }),
  );

it('prepares seven real file trees, rebased settings and a durable worker operation without replacing live data', async () => {
  const test = await fixture();
  const { options, owner } = test;
  const original = await fs.readFile(options.environment);
  const result = await prepare(test);
  expect((await options.journal.refresh()).phase).toBe('prepared');
  expect(await readRestoreOperation(options.journal)).toEqual(result.operation);
  expect(result.operation.preservedTraefik).toBe(1);
  const preserved = await BackupDirectorySwap.open(options.journal.rootJournal('traefik'));
  expect(preserved.incomingDirectory).toBe(path.join(options.journal.rootJournal('traefik'), 'incoming'));
  expect(await fs.readdir(options.roots.traefik)).toEqual(['original.txt']);
  expect(result.operation.database.owner).toEqual(owner);
  expect(result.operation.database.counts).toEqual({ user: 1, app: 1, app_store: 1, link: 0 });
  expect(result.operation.resumeApps).toEqual([{ id: 9, appUrn: 'fixture-app:catalogue' }]);
  expect(await fs.readFile(options.environment)).toEqual(original);
  const incomingName = `.orbis-restore-${options.journal.state.id}.incoming`;
  for (const name of restoreTreeNames) expect(await fs.readFile(path.join(options.roots[name], 'original.txt'), 'utf8')).toBe(`original ${name}`);
  expect(await fs.readFile(path.join(options.roots['app-data'], incomingName, 'document.txt'), 'utf8')).toBe('restored app document');
  const env = dotenv.parse(await fs.readFile(path.join(options.journal.directory, 'incoming.env')));
  expect(env.POSTGRES_DBNAME).toBe(owner.name);
  expect(env.ROOT_FOLDER_HOST).toBe('/srv/target');
  expect(env.JWT_SECRET).toBe('fixture-jwt-secret');
  for (const name of ['original.env', 'incoming.env', 'runtime.json', 'database-owner.json']) {
    const stat = await fs.stat(path.join(options.journal.directory, name));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
  }
  const progress = options.progress.mock.calls.map(([value]) => value);
  expect(progress[0]?.stage).toBe('checking');
  expect(progress.at(-1)?.stage).toBe('prepared');
  expect(progress.some((value) => value.stage === 'files' && value.completedBytes > 0)).toBe(true);
  expect(progress.some((value) => value.stage === 'database' && value.records === 3)).toBe(true);
});

it('preserves destination machine identity while staging paused settings sync without old SQL account grants', async () => {
  const test = await fixture();
  const { options } = test;
  const hostId = randomUUID();
  const cluster = Buffer.from(JSON.stringify({ id: hostId, role: 'admin', privateMembership: 'destination-only fixture' }));
  await fs.writeFile(path.join(options.roots.state, 'cluster.json'), cluster, { mode: 0o600 });
  await fs.mkdir(path.join(options.roots.state, 'cluster-sync'), { mode: 0o700 });
  const sync = Buffer.from(
    JSON.stringify({
      version: 1,
      hostId,
      revision: 2,
      receiving: { revision: 3, userId: 9, categories: ['customisation'], trustRevision: 'a'.repeat(64) },
      plans: [
        {
          hostId: randomUUID(),
          sourceUserId: 9,
          trustRevision: 'a'.repeat(64),
          revision: 4,
          categories: ['orbis-updates'],
          automatic: true,
          expected: {},
          source: {},
          status: 'idle',
          lastAttemptAt: null,
          results: [],
        },
      ],
      receipts: {},
    }),
  );
  await fs.writeFile(path.join(options.roots.state, 'cluster-sync', 'settings.json'), sync, { mode: 0o600 });
  await fs.writeFile(path.join(options.roots['user-config'], 'tipi-compose.yml'), 'destination controller configuration', { mode: 0o600 });
  const result = await prepare(test);
  expect(result.operation.hostIdentity).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const incoming = `.orbis-restore-${options.journal.state.id}.incoming`;
  expect(await fs.readFile(path.join(options.roots.state, incoming, 'cluster.json'))).toEqual(cluster);
  const effective = JSON.parse(await fs.readFile(path.join(options.roots.state, incoming, 'cluster-sync', 'settings.json'), 'utf8'));
  expect(effective.hostId).toBe(hostId);
  expect(effective.receiving).toMatchObject({ userId: null, categories: [], trustRevision: null });
  expect(effective.plans).toEqual([
    expect.objectContaining({ categories: ['orbis-updates'], automatic: false, sourceUserId: null, trustRevision: null, status: 'disabled' }),
  ]);
  expect(await fs.readFile(path.join(options.roots.state, 'cluster-sync', 'settings.json'))).toEqual(sync);
  expect(await fs.readFile(path.join(options.roots['user-config'], incoming, 'tipi-compose.yml'), 'utf8')).toBe(
    'destination controller configuration',
  );
});

it('fails unsupported destination settings-sync state before preparing a database or replacement trees', async () => {
  const test = await fixture();
  await fs.writeFile(path.join(test.options.roots.state, 'cluster.json'), JSON.stringify({ id: randomUUID() }), { mode: 0o600 });
  await fs.mkdir(path.join(test.options.roots.state, 'cluster-sync'), { mode: 0o700 });
  const file = path.join(test.options.roots.state, 'cluster-sync', 'settings.json');
  await fs.writeFile(file, '{"version":2,"future":true}', { mode: 0o600 });
  await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'host-identity', message: expect.stringContaining('local review') });
  expect(prepareRestoreDatabase).not.toHaveBeenCalled();
  expect(await fs.readFile(file, 'utf8')).toBe('{"version":2,"future":true}');
  expect(await fs.readdir(test.options.roots.traefik)).toEqual(['original.txt']);
});

it.each(['content', 'root-attrs'] as const)(
  'refuses a destination network %s change during database staging before any replacement',
  async (change) => {
    const test = await fixture();
    const original = vi.mocked(prepareRestoreDatabase).getMockImplementation();
    if (!original) throw Error('Missing database preparation fixture');
    vi.mocked(prepareRestoreDatabase).mockImplementation(async (input) => {
      const owner = await original(input);
      if (change === 'content') await fs.writeFile(path.join(test.options.roots.traefik, 'operator-change'), 'new network setting');
      else await fs.chmod(test.options.roots.traefik, 0o750);
      return owner;
    });
    await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'host-identity-unchanged' });
    expect((await test.options.journal.refresh()).phase).not.toBe('prepared');
    if (change === 'content') expect(await fs.readFile(path.join(test.options.roots.traefik, 'operator-change'), 'utf8')).toBe('new network setting');
    else expect((await fs.stat(test.options.roots.traefik)).mode & 0o777).toBe(0o750);
    expect(await fs.readFile(path.join(test.options.roots['app-data'], 'original.txt'), 'utf8')).toBe('original app-data');
  },
);

it('does not accept a backup that has not been moved into this restore journal', async () => {
  const test = await fixture();
  test.options.source.directory = path.join(temporary, 'unclaimed-source');
  await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'preconditions' });
  expect(prepareRestoreDatabase).not.toHaveBeenCalled();
  expect(await fs.readdir(test.options.journal.rootJournal('state').replace(/\/state$/, ''))).toEqual([]);
});

it.each(['host', 'port', 'user', 'password', 'database'] as const)('refuses a target database %s mismatch before allocating data', async (key) => {
  const test = await fixture();
  Object.assign(test.options.runtime.connection, { [key]: key === 'port' ? 6543 : 'different target' });
  await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'environment' });
  expect(prepareRestoreDatabase).not.toHaveBeenCalled();
});

it('refuses a changed queue credential before any directory generations are allocated', async () => {
  const test = await fixture();
  test.options.runtime.queue.password = 'changed fixture';
  await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'environment' });
  expect(await fs.readdir(path.join(test.options.journal.directory, 'roots'))).toEqual([]);
});

it('preserves the source and live files when the database preparation fails, then discards only staged generations', async () => {
  const test = await fixture();
  vi.mocked(prepareRestoreDatabase).mockImplementation(async (options) => {
    await options.onCreated(test.owner);
    throw new Error('private fixture database detail');
  });
  await expect(prepare(test)).rejects.toThrow('preserved');
  expect((await test.options.journal.refresh()).phase).toBe('staging');
  await discard(test);
  expect(removeRestoreDatabase).toHaveBeenCalledWith(expect.objectContaining({ id: test.options.journal.state.id, owner: test.owner }));
  expect((await test.options.journal.refresh()).phase).toBe('discarded');
  for (const root of Object.values(test.options.roots)) expect(await fs.readdir(root)).toEqual(['original.txt']);
  expect((await fs.stat(test.options.source.directory)).isDirectory()).toBe(true);
});

it('leaves a recovery record when configuration changes while preparing, without overwriting that edit', async () => {
  const test = await fixture();
  vi.mocked(prepareRestoreDatabase).mockImplementation(async (options) => {
    await options.onCreated(test.owner);
    await fs.appendFile(test.options.environment, 'TARGET_EDIT=true\n');
    return test.owner;
  });
  await expect(prepare(test)).rejects.toThrow();
  expect((await test.options.journal.refresh()).phase).toBe('staging');
  expect(await fs.readFile(test.options.environment, 'utf8')).toContain('TARGET_EDIT=true');
  await discard(test);
  expect(removeRestoreDatabase).toHaveBeenCalledOnce();
});

it('cannot discard a prepared transaction that belongs to the independent recovery worker', async () => {
  const test = await fixture();
  await prepare(test);
  await expect(discard(test)).rejects.toThrow();
  expect(removeRestoreDatabase).not.toHaveBeenCalled();
});

it('rejects conflicting snapshots when the same controller will be restarted', async () => {
  const test = await fixture();
  test.options.runtime.candidate.fingerprint = 'f'.repeat(64);
  await expect(prepare(test)).rejects.toMatchObject({ preparationCheck: 'runtime' });
  expect((await test.options.journal.refresh()).phase).toBe('staging');
  await discard(test);
  expect(removeRestoreDatabase).toHaveBeenCalledOnce();
});

it('does not delete a changed database ownership record or clear the staging recovery state', async () => {
  const test = await fixture();
  vi.mocked(prepareRestoreDatabase).mockImplementation(async (options) => {
    await options.onCreated(test.owner);
    throw new Error('fixture preparation interrupted');
  });
  await expect(prepare(test)).rejects.toThrow();
  await fs.writeFile(path.join(test.options.journal.directory, 'database-owner.json'), '{"name":"unrelated","oid":42,"marker":"changed"}');
  vi.mocked(removeRestoreDatabase).mockRejectedValue(new Error('Ownership mismatch'));
  await expect(discard(test)).rejects.toThrow();
  expect((await test.options.journal.refresh()).phase).toBe('staging');
});

it('supports discarding an interrupted preparation before any per-root files were created', async () => {
  const test = await fixture();
  await discard(test);
  expect((await test.options.journal.refresh()).phase).toBe('discarded');
  expect(removeRestoreDatabase).not.toHaveBeenCalled();
});

it('does not use changed connection details to remove a prepared database during recovery', async () => {
  const test = await fixture();
  vi.mocked(prepareRestoreDatabase).mockImplementation(async (options) => {
    await options.onCreated(test.owner);
    throw new Error('fixture interruption');
  });
  await expect(prepare(test)).rejects.toThrow();
  test.options.runtime.connection.host = 'different-server';
  await expect(discard(test)).rejects.toThrow();
  expect(removeRestoreDatabase).not.toHaveBeenCalled();
  expect((await test.options.journal.refresh()).phase).toBe('staging');
});

it('honours cancellation after materialization and leaves the reviewed source available for recovery', async () => {
  const test = await fixture();
  const abort = new AbortController();
  test.options.signal = abort.signal;
  test.options.progress.mockImplementation((value) => {
    if (value.stage === 'files') abort.abort();
  });
  await expect(prepare(test)).rejects.toThrow();
  expect(prepareRestoreDatabase).not.toHaveBeenCalled();
  expect((await test.options.journal.refresh()).phase).toBe('staging');
  expect((await fs.stat(test.options.source.directory)).isDirectory()).toBe(true);
  await discard(test);
});
