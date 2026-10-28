import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal, restoreStartupAllowed } from './backup-restore-journal';
import { writeRestoreBootstrap, requestRestoreCancellation } from './backup-restore-bootstrap';
import { BackupDirectorySwap } from './backup-directory-swap';
import { restoreTreeNames } from './backup-restore-materialize';
import { prepareRestorePayload } from './backup-restore-preparation';
import { writeRestoreOperation, type RestoreOperation } from './backup-restore-runtime';
import { executeRestoreWorker } from './backup-restore-worker';
import { RestoreRolledBackError } from './backup-restore-coordinator';

const fake = vi.hoisted(() => ({
  events: [] as string[],
  pointer: '',
  stop: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
  verify: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
  activate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('./backup-restore-runtime', async (original) => ({
  ...(await original<typeof import('./backup-restore-runtime')>()),
  BackupRestoreDockerRuntime: class {
    constructor(
      _docker: unknown,
      private journal: BackupRestoreJournal,
    ) {}
    async verifyWorker() {
      fake.events.push(`verified:${this.journal.state.phase}`);
      return this.journal.state.worker;
    }
    async stopWriters(signal: AbortSignal) {
      fake.events.push(`stop:${this.journal.state.phase}`);
      signal.throwIfAborted();
      await fake.stop?.(signal);
    }
    async installDatabasePointer() {
      await fs.writeFile(fake.pointer, 'incoming');
    }
    async restoreDatabasePointer() {
      await fs.writeFile(fake.pointer, 'original');
    }
    async verify(signal: AbortSignal) {
      await fake.verify?.(signal);
    }
    async activate() {
      fake.events.push('activate');
      await fake.activate?.();
    }
    async resumeOriginal() {
      expect(restoreStartupAllowed(this.journal.state, this.journal.state.originalController)).toBe(true);
      expect(await fs.readFile(fake.pointer, 'utf8')).toBe('original');
      fake.events.push(`resume:${this.journal.state.phase}`);
    }
  },
}));
vi.mock('./backup-restore-preparation', async (original) => ({
  ...(await original<typeof import('./backup-restore-preparation')>()),
  prepareRestorePayload: vi.fn(),
}));

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-worker-flow-')));
  await fs.chmod(root, 0o700);
  fake.events.length = 0;
  fake.stop = undefined;
  fake.verify = undefined;
  fake.activate = undefined;
  fake.pointer = path.join(root, 'pointer');
  await fs.writeFile(fake.pointer, 'original');
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture() {
  const directories = {
    data: path.join(root, 'data'),
    appData: path.join(root, 'app-data'),
    cache: path.join(root, 'cache'),
    migrations: '/trusted-migrations',
  };
  const journal = await BackupRestoreJournal.create(path.join(directories.data, 'backups', 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    verifierController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: [...restoreTreeNames],
  });
  for (const name of restoreTreeNames) {
    const location = name === 'app-data' ? directories.appData : path.join(directories.data, name);
    await fs.mkdir(location, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(location, 'value'), `original ${name}`);
  }
  const environment = Buffer.from('synthetic target environment');
  await fs.writeFile(path.join(directories.data, '.env'), environment, { mode: 0o600 });
  const digest = createHash('sha256').update(environment).digest('hex');
  const snapshot = (digit: string) => ({
    id: digit.repeat(64),
    fingerprint: digit.repeat(64),
    running: digit === '1',
    restart: { Name: 'no' as const, MaximumRetryCount: 0 },
  });
  const bootstrap = await writeRestoreBootstrap(journal, {
    version: 1,
    ownerId: 1,
    environmentSha256: digest,
    identity: {
      version: 1,
      id: journal.state.id,
      nonce: journal.state.nonce,
      image: `sha256:${digest}`,
      original: snapshot('1'),
      candidate: snapshot('1'),
      verifier: snapshot('2'),
      worker: snapshot('3'),
      apps: [],
      queue: { host: 'fixture-queue', username: 'fixture', password: 'synthetic fixture' },
    },
    connection: { host: 'fixture-db', port: 5432, user: 'fixture', password: 'synthetic fixture', database: 'original' },
    source: {
      version: 1,
      manifest: { bytes: 1, sha256: digest },
      recovery: { bytes: 1, sha256: digest },
      database: { bytes: 1, sha256: digest },
      normalized: { bytes: 1, sha256: digest, counts: { user: 1, app: 0, app_store: 0, link: 0 } },
    },
  });
  vi.mocked(prepareRestorePayload).mockImplementation(async (options) => {
    fake.events.push(`prepare:${journal.state.phase}`);
    expect(restoreStartupAllowed(journal.state, journal.state.originalController)).toBe(false);
    for (const name of restoreTreeNames) {
      const swap = await BackupDirectorySwap.create({ id: journal.state.id, root: options.roots[name], journal: journal.rootJournal(name) });
      await fs.writeFile(path.join(swap.incomingDirectory, 'value'), `restored ${name}`);
      await swap.seal(options.signal);
    }
    const operation: RestoreOperation = {
      ...bootstrap.identity,
      resumeApps: [],
      originalEnvSha256: digest,
      incomingEnvSha256: digest,
      database: {
        connection: bootstrap.connection,
        owner: {
          name: `orbis_restore_${journal.state.id.replaceAll('-', '')}`,
          oid: 1,
          marker: `orbis.restore.v1/${journal.state.id}/${journal.state.nonce}`,
        },
        counts: { user: 1, app: 0, app_store: 0, link: 0 },
      },
      files: { bytes: 0, sha256: digest, files: 7, directories: 0 },
    };
    await writeRestoreOperation(journal, operation);
    await journal.advance('prepared');
    return { operation, configuration: { restored: [], preserved: [], repositoryMigrated: false } };
  });
  return { docker: {} as Dockerode, journal, hostname: journal.state.worker, signal: signal(), progress: vi.fn(), directories };
}

it('closes the startup gate, prepares once, then hands the durable operation to the transaction coordinator', async () => {
  const options = await fixture();
  await expect(executeRestoreWorker(options)).resolves.toBe('completed');
  expect(options.journal.state.phase).toBe('completed');
  expect(fake.events).toEqual(['verified:staging', 'stop:preparing', 'prepare:preparing', 'verified:prepared', 'stop:quiescing', 'activate']);
  expect(prepareRestorePayload).toHaveBeenCalledOnce();
  for (const name of restoreTreeNames)
    expect(
      await fs.readFile(path.join(name === 'app-data' ? options.directories.appData : path.join(options.directories.data, name), 'value'), 'utf8'),
    ).toBe(`restored ${name}`);
});

it('recovers an interrupted preparing phase without allocating files or another database again', async () => {
  const options = await fixture();
  const location = path.join(options.directories.data, 'state');
  const swap = await BackupDirectorySwap.create({ id: options.journal.state.id, root: location, journal: options.journal.rootJournal('state') });
  await fs.writeFile(path.join(swap.incomingDirectory, 'partial'), 'incomplete');
  await options.journal.advance('preparing');
  await expect(executeRestoreWorker(options)).resolves.toBe('rolled-back');
  expect(fake.events).toEqual(['verified:preparing', 'stop:preparing', 'resume:discarded']);
  expect(prepareRestorePayload).not.toHaveBeenCalled();
  expect(await fs.readdir(location)).toEqual(['value']);
});

it.each(['signal', 'saved intent'] as const)('honours an early cancellation from %s and recovers under the durable startup gate', async (kind) => {
  const options = await fixture();
  if (kind === 'signal') {
    const abort = new AbortController();
    abort.abort();
    options.signal = abort.signal;
  } else await requestRestoreCancellation(options.journal);
  await expect(executeRestoreWorker(options)).rejects.toMatchObject({ cancelled: true });
  expect(options.journal.state.phase).toBe('discarded');
  expect(fake.events).toEqual(['verified:staging', 'stop:preparing', 'resume:discarded']);
  expect(prepareRestorePayload).not.toHaveBeenCalled();
});

it('rejects a target configuration edit before touching restore files and restarts the preserved original', async () => {
  const options = await fixture();
  await fs.appendFile(path.join(options.directories.data, '.env'), ' changed');
  await expect(executeRestoreWorker(options)).rejects.toBeInstanceOf(RestoreRolledBackError);
  expect(options.journal.state.phase).toBe('discarded');
  expect(prepareRestorePayload).not.toHaveBeenCalled();
});

it('keeps the preparing gate closed if writers cannot stop, then allows a fresh worker to recover', async () => {
  const options = await fixture();
  fake.stop = async () => {
    throw new Error('fixture writer conflict');
  };
  await expect(executeRestoreWorker(options)).rejects.toThrow('recovery needs attention');
  expect(options.journal.state.phase).toBe('preparing');
  expect(restoreStartupAllowed(options.journal.state, options.journal.state.originalController)).toBe(false);
  fake.stop = undefined;
  await expect(executeRestoreWorker(options)).resolves.toBe('rolled-back');
  expect(options.journal.state.phase).toBe('discarded');
  expect(prepareRestorePayload).not.toHaveBeenCalled();
});

it('rolls promoted files back when verification fails', async () => {
  const options = await fixture();
  fake.verify = async () => {
    throw new Error('fixture verification failure');
  };
  await expect(executeRestoreWorker(options)).rejects.toBeInstanceOf(RestoreRolledBackError);
  expect(options.journal.state.phase).toBe('rolled-back');
  expect(await fs.readFile(path.join(options.directories.data, 'state', 'value'), 'utf8')).toBe('original state');
});

it('finishes a committed transaction after restart without preparing again or rolling data back', async () => {
  const options = await fixture();
  fake.activate = async () => {
    throw new Error('fixture controller startup failure');
  };
  await expect(executeRestoreWorker(options)).rejects.toThrow('fixture controller startup failure');
  expect(options.journal.state.phase).toBe('committing');
  fake.activate = undefined;
  await expect(executeRestoreWorker(options)).resolves.toBe('completed');
  expect(prepareRestorePayload).toHaveBeenCalledOnce();
  expect(await fs.readFile(path.join(options.directories.data, 'state', 'value'), 'utf8')).toBe('restored state');
});

it('observes a durable cancellation during verification without relying on a Docker signal', async () => {
  const options = await fixture();
  fake.verify = async (current) => {
    await requestRestoreCancellation(options.journal);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Cancellation was not observed')), 3000);
      current.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
    current.throwIfAborted();
  };
  await expect(executeRestoreWorker(options)).rejects.toMatchObject({ cancelled: true });
  expect(options.journal.state.phase).toBe('rolled-back');
});
