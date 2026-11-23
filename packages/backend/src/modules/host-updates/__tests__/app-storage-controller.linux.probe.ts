import path from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type Dockerode from 'dockerode';
import { ArchiveService } from '@/core/archive/archive.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { AppMigrationJournal, migrationOperationSchema, type MigrationOperation } from '@/modules/backups/app-migration-journal';
import { prepareAppMigrationImage } from '@/modules/docker/app-migration-images';
import { parseAppMigration } from '@/modules/docker/app-migration-plan';
import { AppMigrationRunner } from '@/modules/docker/app-migration-runner';
import { stringify } from 'yaml';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { AppStorageWitness, decodeAppStorageObservation } from '@/modules/host-updates/app-storage-observation';

// Run only inside the freshly owned, healthy candidate Core. The actual image
// supplies Dockerode; the bundled witness is pinned to the reviewed source.
const mode = process.argv[2];
let phase = 'preconditions';
const diagnostic: { hostStatus?: number; metadataVerified?: boolean; directoryMatches?: boolean; engineSocketMatches?: boolean } = {};

// This read-only diagnostic is not a storage grant. The real witness below
// must independently open, verify and reverify its own live connection.
async function observeTransport(appUrn: string, localDirectory: string) {
  const nonce = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ appUrn, nonce });
  const body = await new Promise<Buffer>((resolve, reject) => {
    const request = http.request(
      {
        socketPath: '/run/orbis/host.sock',
        path: '/v1/app-storage/observe',
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        agent: false,
        headers: { Host: 'orbis', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
      },
      (response) => {
        diagnostic.hostStatus = response.statusCode;
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > 16384) {
            response.destroy();
            request.destroy();
            reject(new Error('Diagnostic response limit'));
          } else parts.push(part);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Diagnostic response aborted')));
        response.once('end', () => resolve(Buffer.concat(parts)));
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
  assert.equal(diagnostic.hostStatus, 200);
  const value = decodeAppStorageObservation(JSON.parse(body.toString('utf8')), { appUrn, nonce });
  diagnostic.metadataVerified = true;
  const directory = await fs.stat(localDirectory, { bigint: true });
  diagnostic.directoryMatches =
    value.containerPath === localDirectory &&
    value.directory.device === String(directory.dev) &&
    value.directory.inode === String(directory.ino) &&
    value.directory.uid === Number(directory.uid) &&
    value.directory.gid === Number(directory.gid) &&
    value.directory.mode === Number(directory.mode & 0o7777n);
  const socket = await fs.stat('/var/run/docker.sock', { bigint: true });
  diagnostic.engineSocketMatches = value.dockerSocket.device === String(socket.dev) && value.dockerSocket.inode === String(socket.ino);
}

async function qualify() {
  const Dockerode = createRequire('/app/package.json')('dockerode');
  const custom = mode === 'custom-app-positive';
  const localDirectory = custom ? '/app-data/_user/probe' : '/app-data/fixture/probe';
  const appUrn = custom ? 'probe:_user' : 'probe:fixture';
  assert.equal(process.platform, 'linux');
  assert.equal(process.geteuid?.(), 0);
  assert.equal(mode === 'positive' || mode === 'custom-app-positive' || mode === 'directory-drift', true);
  assert.equal(await fs.realpath(localDirectory), localDirectory);
  assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
  phase = 'host-transport';
  await observeTransport(appUrn, localDirectory);
  phase = 'witness-open';
  const witness = await AppStorageWitness.open({
    socketPath: '/run/orbis/host.sock',
    appUrn,
    localDirectory,
    docker: new Dockerode({ socketPath: '/var/run/docker.sock' }),
  });
  try {
    phase = 'witness-use';
    if (mode !== 'directory-drift') {
      const observation = await witness.use(async (_docker, value) => {
        const actual = await fs.stat(localDirectory);
        assert.equal(value.containerPath, localDirectory);
        assert.equal(value.directory.device, String(actual.dev));
        assert.equal(value.directory.inode, String(actual.ino));
        assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
        return {
          controllerId: value.controller.id,
          imageId: value.controller.imageId,
          directory: value.directory,
          daemonSha256: value.daemonSha256,
          mountTablesSha256: value.mountTablesSha256,
        };
      });
      process.stdout.write(`${JSON.stringify({ case: mode, passed: true, observation })}\n`);
    } else {
      const retained = `${localDirectory}-retained-${randomUUID()}`;
      let moved = false;
      let replacement = false;
      try {
        await assert.rejects(
          witness.use(async () => {
            await fs.rename(localDirectory, retained);
            moved = true;
            await fs.mkdir(localDirectory, { mode: 0o700 });
            replacement = true;
          }),
          /storage binding could not be verified/,
        );
        // A refusal before the intended effect would not qualify this case.
        assert.equal(moved && replacement, true);
      } finally {
        if (replacement) await fs.rmdir(localDirectory);
        if (moved) await fs.rename(retained, localDirectory);
      }
      assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
      process.stdout.write(`${JSON.stringify({ case: mode, passed: true, originalRestored: true })}\n`);
    }
  } finally {
    const previous = phase;
    phase = 'witness-close';
    await witness.close();
    phase = previous;
  }
}

// These cases join the real Host witness and Engine. They do not qualify Main's worker or SQL ledger.
async function qualifyHostEngine() {
  const image = 'docker.io/library/postgres@sha256:09f23e02d76670d3b346a3c00aa33a27cf57aab8341eedfcdaed41459d14f5c4';
  const scopeLabel = 'io.orbis.runtime-test.scope';
  const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
  let appUrn: string;
  let data: string;
  const noop = () => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop } as unknown as LoggerService;
  const archive = new ArchiveService(logger);
  let docker: Dockerode;
  let storage: AppStorageWitness | undefined;
  let root: string;
  let hostData: string;
  let scope: string;
  let imageId: string;
  let original: Dockerode.Container | undefined;
  let operation: MigrationOperation | undefined;
  let journal: AppMigrationJournal | undefined;
  let baseline: string[] | undefined;
  const owned = new Map<string, string>();
  let phase = 'fixture-preconditions';
  const mode = process.argv[2] === 'host-engine-upgrade' ? 'upgrade' : process.argv[2] === 'host-engine-rollback' ? 'rollback' : undefined;
  let failurePhase: string | undefined;
  let cleanupPassed = false;

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
    assert.equal(value.State.Running, false);
    assert.equal(value.State.Pid, 0);
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
        Mounts: [{ Type: 'bind', Source: path.join(hostData, 'db'), Target: '/var/lib/postgresql/data', ReadOnly: false }],
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
            volumes: [`${hostData}/db:/var/lib/postgresql/data`],
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
      { appDataHostPath: hostData, environment: {} },
    );
    const pin = await prepareAppMigrationImage(docker, definition, { architecture: 'amd64' });
    assert.equal(pin.imageId, imageId);
    if (!storage) throw new Error('Missing actual Host witness');
    const fixtureStorage = storage;
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
    assert.equal((await journal.read()).phase, 'ready');
    return {
      runner: new AppMigrationRunner(journal, fixtureStorage),
      plans: [{ definition, image: pin }],
      async reopen() {
        await journal?.close();
        journal = await AppMigrationJournal.open(path.join(root, 'operations'), boundOperation);
        return new AppMigrationRunner(journal, fixtureStorage);
      },
    };
  }

  async function cleanup() {
    if (!baseline) return false;
    const migrations = operation
      ? await docker.listContainers({ all: true, filters: { label: [`io.orbis.app-migration.request=${operation.requestId}`] } })
      : [];
    // Inspect every selected actor before any deletion or stop.
    const removable: Dockerode.Container[] = [];
    for (const row of migrations) {
      const container = docker.getContainer(row.Id);
      const value = await container.inspect();
      assert.equal(value.Image, imageId);
      assert.equal(value.Config.Labels['io.orbis.app-migration.app'], appUrn);
      assert.equal(value.Config.Labels['io.orbis.app-migration.stage'], operation?.stageId);
      assert.match(value.Name, /^\/orbis-migration-[a-f0-9]{32}-[a-f0-9]{12}$/);
      removable.push(container);
    }
    for (const [id, name] of owned) {
      const container = docker.getContainer(id);
      const value = await container.inspect();
      assert.equal(value.Image, imageId);
      assert.equal(value.Name, `/${name}`);
      assert.equal(value.Config.Labels[scopeLabel], scope);
      assert.equal(value.Config.Labels['runtipi.appurn'], appUrn);
      assert.equal(value.Config.Labels['com.docker.compose.service'], 'database');
      assert.equal(value.HostConfig.RestartPolicy?.Name, 'no');
      assert.equal(value.Mounts.length, 1);
      assert.equal(value.Mounts[0]?.Source, path.join(hostData, 'db'));
      assert.equal(value.Mounts[0]?.Destination, '/var/lib/postgresql/data');
      removable.push(container);
    }
    for (const container of removable) {
      const value = await container.inspect();
      if (value.State.Running) await container.stop({ t: 15 });
      assert.equal((await container.inspect()).State.Pid, 0);
      await container.remove();
    }
    await journal?.close();
    await storage?.close();
    assert.deepEqual((await docker.listContainers({ all: true })).map(({ Id }) => Id).sort(), baseline);
    // Retain generated data and checkpoints. The outer Root fixture deletes its
    // own backing only after all actors and protected mounts are proven gone.
    return true;
  }

  async function qualify() {
    const commit = process.argv[3];
    assert.equal(process.argv[4], '--exercise-host-engine');
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.equal(process.geteuid?.(), 0);
    assert.match(commit ?? '', /^[a-f0-9]{40}$/);
    phase = 'fixture-environment';
    assert.equal(process.env.ORBIS_COMMIT, commit);
    assert.equal(process.env.NODE_ENV, 'production');
    assert.equal(process.env.DEMO_MODE, 'false');
    assert.equal(process.argv[2] === 'host-engine-upgrade' || process.argv[2] === 'host-engine-rollback', true);
    appUrn = `engine-${mode}:fixture`;
    data = `/app-data/fixture/engine-${mode}`;
    phase = 'fixture-marker';
    const markerPath = '/opt/orbis-test-probe/host-engine-enabled';
    const markerInfo = await fs.lstat(markerPath);
    assert.equal(markerInfo.isFile() && !markerInfo.isSymbolicLink() && markerInfo.uid === 0 && !(markerInfo.mode & 0o022), true);
    const marker = (await fs.readFile(markerPath, 'utf8')).split('\n');
    assert.deepEqual(marker.slice(0, 2), ['ephemeral-host-engine', commit]);
    assert.equal(marker.length, 4);
    assert.equal(marker[3], '');
    assert.match(marker[2] ?? '', /^[a-f0-9]{64}$/);
    scope = createHash('sha256').update(`${marker[2]}\n${mode}`).digest('hex');
    phase = 'fixture-directory';
    assert.equal(await fs.realpath(data), data);
    assert.deepEqual((await fs.readdir(data)).sort(), ['marker']);
    assert.equal(await fs.readFile(path.join(data, 'marker'), 'utf8'), 'scoped fixture\n');
    const Docker = createRequire('/app/package.json')('dockerode') as typeof import('dockerode');
    docker = new Docker({ socketPath: '/var/run/docker.sock' });
    baseline = (await docker.listContainers({ all: true })).map(({ Id }) => Id).sort();
    assert.equal(
      baseline.every((id) => /^[a-f0-9]{64}$/.test(id)),
      true,
    );
    phase = 'actual-host-witness';
    storage = await AppStorageWitness.open({ socketPath: '/run/orbis/host.sock', appUrn, localDirectory: data, docker });
    const observed = await storage.use(async (_engine, value) => value);
    hostData = observed.hostPath;
    assert.equal(observed.containerPath, data);
    const value = await docker.getImage(image).inspect();
    assert.equal(value.Os, 'linux');
    assert.equal(value.Architecture, 'amd64');
    assert.match(value.Id, /^sha256:[a-f0-9]{64}$/);
    imageId = value.Id;
    phase = 'actual-postgres-fixture';
    root = `/data/backups/.orbis-host-engine-${scope}`;
    await fs.mkdir(root, { mode: 0o700 });
    await fs.mkdir(path.join(data, 'db'), { mode: 0o700 });
    original = await ownedContainer('original');
    await startOriginal();
    await sql("CREATE TABLE upgrade_fixture(value text NOT NULL); INSERT INTO upgrade_fixture VALUES ('before')");
    await stopOriginal();
    phase = 'actual-host-backed-checkpoint';
    const { runner, plans } = await prepare(mode === 'rollback' ? 7 : 0);
    phase = 'actual-isolated-migration';
    if (mode === 'upgrade') {
      await runner.run(plans);
      assert.equal((await journal?.read())?.phase, 'migrations-complete');
      await startOriginal();
      assert.equal(await sql('SELECT value FROM upgrade_fixture'), 'after');
    } else {
      await assert.rejects(runner.run(plans), /requires verified recovery/);
      assert.equal((await journal?.read())?.runners[0]?.exitCode, 7);
      phase = 'actual-checkpoint-rollback';
      await runner.restoreCheckpoint(plans, data, archive);
      assert.equal((await journal?.read())?.phase, 'restored');
      await startOriginal();
      assert.equal(await sql('SELECT value FROM upgrade_fixture'), 'before');
    }
    await stopOriginal();
    await storage.use(async () => assert.equal(await fs.readFile(path.join(data, 'marker'), 'utf8'), 'scoped fixture\n'));
  }

  try {
    await qualify();
  } catch {
    failurePhase = phase;
  } finally {
    try {
      cleanupPassed = await cleanup();
    } catch {
      failurePhase ??= 'owned-actor-cleanup';
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      case: `host-engine-${mode ?? 'invalid'}`,
      passed: !failurePhase && cleanupPassed,
      failurePhase,
      cleanup: cleanupPassed,
      modeledHost: false,
      mainWorkerTested: false,
      productionTouched: false,
    })}\n`,
  );
  if (failurePhase || !cleanupPassed) process.exitCode = 1;
}

if (mode === 'host-engine-upgrade' || mode === 'host-engine-rollback') {
  await qualifyHostEngine();
} else {
  qualify().catch(() => {
    process.stdout.write(`${JSON.stringify({ case: mode, passed: false, failedPhase: phase, diagnostic })}\n`);
    process.exitCode = 1;
  });
}
