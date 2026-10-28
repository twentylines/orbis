import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type Dockerode from 'dockerode';
import { BackupRestoreDockerRuntime, type RestoreOperation } from './backup-restore-runtime';
import type { BackupRestoreJournal, RestorePhase } from './backup-restore-journal';
import { writeRestoreEnvironment } from './backup-restore-environment';

let root: string;
let phase: RestorePhase;
let operation: RestoreOperation;
let original: Buffer;
let incoming: Buffer;
let runtime: BackupRestoreDockerRuntime;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-runtime-pointer-')));
  for (const name of ['data', 'journal', 'cache']) await fs.mkdir(path.join(root, name), { mode: 0o700 });
  phase = 'rolling-back';
  const id = randomUUID();
  const nonce = randomUUID();
  const name = `orbis_restore_${id.replaceAll('-', '')}`;
  original = Buffer.from(
    'POSTGRES_HOST=fixture-db\nPOSTGRES_USERNAME=fixture\nPOSTGRES_PASSWORD=fixture\nPOSTGRES_PORT=5432\nPOSTGRES_DBNAME=original\n',
  );
  incoming = Buffer.from(original.toString().replace('POSTGRES_DBNAME=original', `POSTGRES_DBNAME=${name}`));
  for (const [file, bytes] of [
    ['original.env', original],
    ['incoming.env', incoming],
  ] as const)
    await fs.writeFile(path.join(root, 'journal', file), bytes, { mode: 0o600 });
  await fs.writeFile(path.join(root, 'data', '.env'), incoming, { mode: 0o600 });
  const snapshot = (digit: string) => ({
    id: digit.repeat(64),
    fingerprint: digit.repeat(64),
    running: false,
    restart: { Name: 'no' as const, MaximumRetryCount: 0 },
  });
  operation = {
    version: 1,
    id,
    nonce,
    image: `sha256:${'a'.repeat(64)}`,
    original: snapshot('1'),
    candidate: snapshot('2'),
    verifier: snapshot('3'),
    resumeApps: [],
    apps: [],
    queue: { host: 'fixture-queue', username: 'fixture', password: 'fixture' },
    database: {
      connection: { host: 'fixture-db', port: 5432, user: 'fixture', password: 'fixture', database: 'original' },
      owner: { name, oid: 1, marker: `orbis.restore.v1/${id}/${nonce}` },
      counts: { user: 1, app: 0, app_store: 0, link: 0 },
    },
    originalEnvSha256: hash(original),
    incomingEnvSha256: hash(incoming),
    files: { bytes: 0, sha256: 'a'.repeat(64), files: 0, directories: 0 },
  };
  // This test keeps the journal/Docker boundary explicit and exercises real private files through the public rollback operation.
  const journal = { directory: path.join(root, 'journal'), refresh: async () => ({ id, nonce, phase }) } as unknown as BackupRestoreJournal;
  runtime = new BackupRestoreDockerRuntime({} as Dockerode, journal, operation, {
    data: path.join(root, 'data'),
    appData: path.join(root, 'app-data'),
    cache: path.join(root, 'cache'),
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('recovers the original pointer through the runtime without replacing a file-bind inode', async () => {
  const file = path.join(root, 'data', '.env');
  const inode = (await fs.stat(file)).ino;
  await runtime.restoreDatabasePointer();
  expect(await fs.readFile(file)).toEqual(original);
  expect((await fs.stat(file)).ino).toBe(inode);
});

it('recovers partial incoming contents before the original controller is resumed', async () => {
  const file = path.join(root, 'data', '.env');
  const journal = path.join(root, 'journal', 'environment-pointer.json');
  await writeRestoreEnvironment({ file, journal, id: operation.id, nonce: operation.nonce, original, incoming, target: 'incoming' });
  const intent = JSON.parse(await fs.readFile(journal, 'utf8'));
  await fs.writeFile(journal, JSON.stringify({ ...intent, phase: 'writing' }));
  await fs.writeFile(file, incoming.subarray(0, 9));
  await runtime.restoreDatabasePointer();
  expect(await fs.readFile(file)).toEqual(original);
});

it.each(['staging', 'prepared', 'completed'] as const)('does not change configuration in %s', async (value) => {
  phase = value;
  await expect(runtime.restoreDatabasePointer()).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'data', '.env'))).toEqual(incoming);
  await expect(fs.lstat(path.join(root, 'journal', 'environment-pointer.json'))).rejects.toHaveProperty('code', 'ENOENT');
});

it.each(['original', 'incoming'] as const)('refuses a changed %s configuration snapshot before writing', async (kind) => {
  await fs.appendFile(path.join(root, 'journal', `${kind}.env`), 'UNREVIEWED=true\n');
  await expect(runtime.restoreDatabasePointer()).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'data', '.env'))).toEqual(incoming);
});
