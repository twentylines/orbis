import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ArchiveService } from '@/core/archive/archive.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { AppMigrationJournal, migrationOperationSchema, type MigrationOperation } from '@/modules/backups/app-migration-journal';
import { prepareAppMigrationImage } from '@/modules/docker/app-migration-images';
import { parseAppMigration } from '@/modules/docker/app-migration-plan';
import { AppMigrationRunner } from '@/modules/docker/app-migration-runner';
import type { AppStorageObservation, AppStorageWitness } from '@/modules/host-updates/app-storage-observation';
import Dockerode from 'dockerode';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const image = 'docker.io/library/postgres@sha256:09f23e02d76670d3b346a3c00aa33a27cf57aab8341eedfcdaed41459d14f5c4';
const enabled = process.platform === 'linux' && process.geteuid?.() === 0 && process.env.ORBIS_MIGRATION_ENGINE_TEST === '1';
const scopeLabel = 'io.orbis.runtime-test.scope';
const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
let parent: string;
let baseline: string[];
let root: string;
let data: string;
let scope: string;
let appUrn: string;
let imageId: string;
let original: Dockerode.Container | undefined;
let operation: MigrationOperation | undefined;
let journal: AppMigrationJournal | undefined;
const owned = new Map<string, string>();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoggerService;
const archive = new ArchiveService(logger);

async function execute(container: Dockerode.Container, command: string[]): Promise<string> {
  const process = await container.exec({ Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = (await process.start({ hijack: false, stdin: false })) as Readable;
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) stream.destroy(new Error('Fixture output exceeded its bound'));
    else chunks.push(chunk);
  });
  await finished(stream, { readable: true, writable: false });
  const result = await process.inspect();
  if (result.Running || result.ExitCode !== 0) throw new Error('The isolated database fixture command failed');
  const multiplexed = Buffer.concat(chunks);
  const stdout: Buffer[] = [];
  for (let offset = 0; offset < multiplexed.length; ) {
    if (offset + 8 > multiplexed.length) throw new Error('Truncated fixture output');
    const length = multiplexed.readUInt32BE(offset + 4);
    if (offset + 8 + length > multiplexed.length) throw new Error('Truncated fixture output');
    if (multiplexed[offset] === 1) stdout.push(multiplexed.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(stdout).toString('utf8').trim();
}

async function sql(statement: string) {
  if (!original) throw new Error('Missing original database fixture');
  return execute(original, ['psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-U', 'tipi', '-d', 'fixture', '-Atc', statement]);
}

async function startOriginal() {
  if (!original) throw new Error('Missing original database fixture');
  await original.start();
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await sql('SELECT 1');
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error('The isolated database fixture did not become ready');
      await pause();
    }
  }
}

async function stopOriginal() {
  if (!original) throw new Error('Missing original database fixture');
  await original.stop({ t: 15 });
  const value = await original.inspect();
  expect(value.State.Running).toBe(false);
  expect(value.State.Pid).toBe(0);
}

async function ownedContainer(kind: string) {
  const name = `orbis-runtime-test-${scope.slice(0, 12)}-${kind}`;
  const container = await docker.createContainer({
    name,
    Image: imageId,
    Env: ['POSTGRES_USER=tipi', 'POSTGRES_DB=fixture', `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`],
    Labels: {
      [scopeLabel]: scope,
      'runtipi.managed': 'true',
      'runtipi.appurn': appUrn,
      'com.docker.compose.project': kind === 'original' ? appUrn.replace(':', '_') : `${scope}_foreign`,
      'com.docker.compose.service': 'database',
    },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
      Mounts: [{ Type: 'bind', Source: path.join(data, 'db'), Target: '/var/lib/postgresql/data', ReadOnly: false }],
    },
  });
  owned.set(container.id, name);
  return container;
}

async function prepare(exitCode = 0) {
  if (!original) throw new Error('Missing original database fixture');
  const bytes = Buffer.from(
    stringify({
      services: {
        migration: {
          image,
          user: 'postgres',
          network_mode: 'none',
          volumes: [`${data}/db:/var/lib/postgresql/data`],
          environment: { PGDATA: '/var/lib/postgresql/data' },
          entrypoint: ['/bin/bash', '-euc'],
          command: [
            `
      umask 077
      mkdir /tmp/fixture-socket
      printf 'local all all trust\\n' > /tmp/fixture-socket/pg_hba.conf
      pg_ctl -D "$$PGDATA" -w start -o "-c listen_addresses='' -c unix_socket_directories=/tmp/fixture-socket -c hba_file=/tmp/fixture-socket/pg_hba.conf"
      trap 'pg_ctl -D "$$PGDATA" -m fast -w stop' EXIT
      psql -X -w -v ON_ERROR_STOP=1 -h /tmp/fixture-socket -U tipi -d fixture -c "UPDATE upgrade_fixture SET value='after'"
      exit ${exitCode}
    `,
          ],
        },
      },
    }),
  );
  const definition = parseAppMigration(
    { id: '001-native-upgrade', sha256: createHash('sha256').update(bytes).digest('hex'), bytes },
    { appDataHostPath: data, environment: {} },
  );
  const pin = await prepareAppMigrationImage(docker, definition, { architecture: 'amd64' });
  expect(pin.imageId).toBe(imageId);
  const info = await fs.stat(data);
  const observed: AppStorageObservation = {
    schema: 'orbis.app-storage-observation.v1',
    appUrn,
    nonce: '1'.repeat(64),
    controller: { id: '2'.repeat(64), imageId, startedAt: 'isolated-engine-fixture', definitionSha256: '3'.repeat(64) },
    daemonSha256: '4'.repeat(64),
    dockerSocket: { device: '1', inode: '2' },
    hostBasePath: root,
    hostPath: data,
    containerPath: data,
    directory: { device: String(info.dev), inode: String(info.ino), uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 },
    mountTablesSha256: '5'.repeat(64),
    controllerNamespace: 'isolated-engine-fixture',
    bindingSha256: '6'.repeat(64),
  };
  // This intentionally models Host admission. Docker, PostgreSQL, the journal,
  // checkpoint and restore are real. It is not native Host enrollment proof.
  const fixtureStorage = {
    async use<T>(effect: (client: Dockerode, value: AppStorageObservation) => Promise<T>) {
      const before = await fs.stat(data);
      expect(String(before.dev)).toBe(observed.directory.device);
      expect(String(before.ino)).toBe(observed.directory.inode);
      const result = await effect(docker, observed);
      const after = await fs.stat(data);
      expect(String(after.dev)).toBe(observed.directory.device);
      expect(String(after.ino)).toBe(observed.directory.inode);
      return result;
    },
  } as unknown as AppStorageWitness;
  const boundOperation = migrationOperationSchema.assert({
    version: 1,
    requestId: randomUUID(),
    stageId: randomUUID(),
    appUrn,
    appId: 1,
    createdAt: 1,
    fromVersion: 1,
    toVersion: 2,
    previousLedger: { baselined: true, migrationIds: [] },
    images: [pin],
    originalContainers: [{ id: original.id, imageId, service: 'database' }],
  });
  operation = boundOperation;
  journal = await AppMigrationJournal.create(path.join(root, 'operations'), boundOperation, fixtureStorage);
  await journal.capture(fixtureStorage, data, archive);
  expect((await journal.read()).phase).toBe('ready');
  return { runner: new AppMigrationRunner(journal, fixtureStorage), plans: [{ definition, image: pin }] };
}

describe.skipIf(!enabled)('isolated Linux Engine migration and checkpoint', () => {
  beforeAll(async () => {
    const configured = process.env.ORBIS_MIGRATION_TEST_ROOT;
    if (!configured || !path.isAbsolute(configured)) throw new Error('Allocate checkout-local Engine fixture storage');
    parent = await fs.realpath(configured);
    expect(parent).toBe(configured);
    expect(path.basename(parent)).toMatch(/^\.orbis-engine-[A-Za-z0-9]{6}$/);
    expect(path.dirname(parent)).toBe(await fs.realpath(path.resolve(import.meta.dirname, '../../../../../..')));
    expect((await fs.stat(parent)).mode & 0o077).toBe(0);
    baseline = (await docker.listContainers({ all: true })).map(({ Id }) => Id).sort();
    const value = await docker.getImage(image).inspect();
    expect(value.Os).toBe('linux');
    expect(value.Architecture).toBe('amd64');
    imageId = value.Id;
  }, 120_000);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(parent, 'case-'));
    data = path.join(root, 'app-data');
    await fs.mkdir(data, { mode: 0o700 });
    await fs.mkdir(path.join(data, 'db'));
    scope = randomUUID();
    appUrn = `native-${scope.slice(0, 8)}:fixture`;
    original = await ownedContainer('original');
    await startOriginal();
    await sql("CREATE TABLE upgrade_fixture(value text NOT NULL); INSERT INTO upgrade_fixture VALUES ('before')");
    await stopOriginal();
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const migrations = operation
      ? await docker.listContainers({ all: true, filters: { label: [`io.orbis.app-migration.request=${operation.requestId}`] } })
      : [];
    for (const row of migrations) {
      const container = docker.getContainer(row.Id);
      const value = await container.inspect();
      expect(value.Image).toBe(imageId);
      expect(value.Config.Labels['io.orbis.app-migration.app']).toBe(appUrn);
      expect(value.Config.Labels['io.orbis.app-migration.stage']).toBe(operation?.stageId);
      expect(value.Name).toMatch(/^\/orbis-migration-[a-f0-9]{32}-[a-f0-9]{12}$/);
      if (value.State.Running) await container.stop({ t: 5 });
      expect((await container.inspect()).State.Pid).toBe(0);
      await container.remove();
    }
    for (const [id, name] of owned) {
      const container = docker.getContainer(id);
      const value = await container.inspect();
      expect(value.Image).toBe(imageId);
      expect(value.Name).toBe(`/${name}`);
      expect(value.Config.Labels[scopeLabel]).toBe(scope);
      if (value.State.Running) await container.stop({ t: 15 });
      expect((await container.inspect()).State.Pid).toBe(0);
      await container.remove();
    }
    owned.clear();
    await journal?.close();
    journal = undefined;
    operation = undefined;
    original = undefined;
    await fs.rm(root, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    if (!baseline) return;
    expect((await docker.listContainers({ all: true })).map(({ Id }) => Id).sort()).toEqual(baseline);
    await fs.writeFile(path.join(parent, 'cleanup-complete'), 'complete', { flag: 'wx', mode: 0o600 });
  });

  it('upgrades actual PostgreSQL data through the production isolated runner', async () => {
    const { runner, plans } = await prepare();
    await runner.run(plans);
    expect((await journal?.read())?.phase).toBe('migrations-complete');
    await startOriginal();
    expect(await sql('SELECT value FROM upgrade_fixture')).toBe('after');
  }, 120_000);

  it('restores the original PostgreSQL data after a script writes and fails', async () => {
    const { runner, plans } = await prepare(7);
    await expect(runner.run(plans)).rejects.toThrow('requires verified recovery');
    expect((await journal?.read())?.runners[0]?.exitCode).toBe(7);
    await runner.restoreCheckpoint(plans, data, archive);
    expect((await journal?.read())?.phase).toBe('restored');
    await startOriginal();
    expect(await sql('SELECT value FROM upgrade_fixture')).toBe('before');
  }, 120_000);

  it('reconciles a real lost start reply without starting the migration twice', async () => {
    const { runner, plans } = await prepare();
    const dial = docker.modem.dial.bind(docker.modem);
    let starts = 0;
    vi.spyOn(docker.modem, 'dial').mockImplementation((options, callback) => {
      if (callback && options.method === 'POST' && /\/containers\/[a-f0-9]{64}\/start\?/.test(options.path)) {
        starts++;
        return dial(options, (error, value) => callback(error ?? new Error('Synthetic lost start reply'), value));
      }
      return dial(options, callback);
    });
    await runner.run(plans);
    expect(starts).toBe(1);
    vi.restoreAllMocks();
    await startOriginal();
    expect(await sql('SELECT value FROM upgrade_fixture')).toBe('after');
  }, 120_000);

  it('refuses checkpoint capture when another container can write the app data', async () => {
    const foreign = await ownedContainer('foreign');
    await expect(prepare()).rejects.toThrow('requires verified recovery');
    expect((await foreign.inspect()).State.Status).toBe('created');
    expect((await journal?.read())?.runners).toEqual([]);
    await startOriginal();
    expect(await sql('SELECT value FROM upgrade_fixture')).toBe('before');
  }, 120_000);
});
