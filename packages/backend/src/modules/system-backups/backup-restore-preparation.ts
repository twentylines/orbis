import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { type } from 'arktype';
import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { rebaseBackupConfiguration } from './backup-restore-configuration';
import { prepareRestoreDatabase, removeRestoreDatabase, type RestoreDatabaseConnection, type RestoreDatabaseOwner } from './backup-restore-database';
import { BackupRestoreJournal } from './backup-restore-journal';
import { materializeBackupSource, restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';
import { writeRestoreOperation, type RestoreOperation } from './backup-restore-runtime';
import { validateBackupSource, type BackupSourceSeal } from './backup-restore-source';

export type RestorePreparationProgress = {
  stage: 'checking' | 'files' | 'database' | 'sealing' | 'prepared';
  completedBytes: number;
  totalBytes: number | null;
  records: number;
  totalRecords: number | null;
};
export type RestorePreparationRuntime = Pick<RestoreOperation, 'image' | 'original' | 'candidate' | 'verifier' | 'worker' | 'apps' | 'queue'> & {
  connection: RestoreDatabaseConnection;
};
const ownerSchema = type({ '+': 'reject', name: 'string', oid: 'number.integer > 0', marker: 'string' });
const failed = () => new BackupRequirementError('Restore preparation needs recovery. Your current data and reviewed backup have been preserved.');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readPrivate(file: string) {
  if (path.resolve(file) !== file || (await fs.realpath(path.dirname(file))) !== path.dirname(file)) throw failed();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function createPrivate(file: string, bytes: Uint8Array) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.preparing`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(temporary, file);
    await fs.rm(temporary);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function checkDatabaseConnection(environment: Uint8Array, database: RestoreDatabaseConnection) {
  const env = dotenv.parse(Buffer.from(environment));
  if (
    env.POSTGRES_HOST !== database.host ||
    Number(env.POSTGRES_PORT ?? 5432) !== database.port ||
    env.POSTGRES_USERNAME !== database.user ||
    env.POSTGRES_PASSWORD !== database.password ||
    env.POSTGRES_DBNAME !== database.database
  )
    throw failed();
}
function checkConnection(environment: Uint8Array, runtime: Pick<RestorePreparationRuntime, 'connection' | 'queue'>) {
  checkDatabaseConnection(environment, runtime.connection);
  const env = dotenv.parse(Buffer.from(environment));
  if (
    env.RABBITMQ_HOST !== runtime.queue.host ||
    env.RABBITMQ_USERNAME !== runtime.queue.username ||
    env.RABBITMQ_PASSWORD !== runtime.queue.password
  )
    throw failed();
}

export async function restoreTargetEnvironmentDigest(file: string, runtime: Pick<RestorePreparationRuntime, 'connection' | 'queue'>) {
  const bytes = await readPrivate(file);
  checkConnection(bytes, runtime);
  return hash(bytes);
}

// The owner holds the restore/disk leases and quiesces writers before entering this operation.
// No live directory or environment pointer is promoted until the independent worker takes over.
export async function prepareRestorePayload(options: {
  journal: BackupRestoreJournal;
  source: { directory: string; seal: BackupSourceSeal };
  roots: Record<RestoreTreeName, string>;
  environment: string;
  trustedMigrationsFolder: string;
  runtime: RestorePreparationRuntime;
  signal: AbortSignal;
  progress: (value: RestorePreparationProgress) => void;
}) {
  const { journal, signal, runtime } = options;
  let check = 'preconditions';
  try {
    signal.throwIfAborted();
    const state = await journal.refresh();
    if (
      !['staging', 'preparing'].includes(state.phase) ||
      state.decision !== null ||
      state.roots.length !== restoreTreeNames.length ||
      state.roots.some((name) => !restoreTreeNames.includes(name as RestoreTreeName)) ||
      options.source.directory !== path.join(journal.directory, 'source', 'payload') ||
      Object.keys(options.roots).length !== restoreTreeNames.length ||
      restoreTreeNames.some((name) => !options.roots[name])
    )
      throw failed();
    const roots = Object.values(options.roots);
    if (
      roots.some(
        (root, index) =>
          path.resolve(root) !== root ||
          inside(root, journal.directory) ||
          inside(journal.directory, root) ||
          inside(root, options.environment) ||
          roots.some((other, position) => index !== position && (inside(root, other) || inside(other, root))),
      )
    )
      throw failed();
    const progress: RestorePreparationProgress = { stage: 'checking', completedBytes: 0, totalBytes: null, records: 0, totalRecords: null };
    options.progress({ ...progress });
    check = 'source';
    const source = await validateBackupSource({ directory: options.source.directory, expected: options.source.seal, signal });
    check = 'environment';
    const original = await readPrivate(options.environment);
    checkConnection(original, runtime);
    check = 'configuration';
    const configuration = rebaseBackupConfiguration({
      targetEnvironment: original.toString('utf8'),
      databaseName: `orbis_restore_${state.id.replaceAll('-', '')}`,
      recovery: source.recovery,
    });
    const settings = source.manifest.files.find((entry) => entry.name === 'data/state/settings.json');
    if (!settings) throw failed();
    const incoming = Buffer.from(configuration.environment);
    check = 'snapshots';
    await privateBackupDirectory(journal.directory);
    await createPrivate(path.join(journal.directory, 'original.env'), original);
    await createPrivate(path.join(journal.directory, 'incoming.env'), incoming);
    const swaps = new Map<RestoreTreeName, BackupDirectorySwap>();
    check = 'directories';
    for (const name of restoreTreeNames) {
      signal.throwIfAborted();
      swaps.set(name, await BackupDirectorySwap.create({ id: state.id, root: options.roots[name], journal: journal.rootJournal(name) }));
    }
    progress.stage = 'files';
    check = 'files';
    const materialized = await materializeBackupSource({
      directory: source.directory,
      expected: options.source.seal,
      roots: Object.fromEntries([...swaps].map(([name, swap]) => [name, swap.incomingDirectory])) as Record<RestoreTreeName, string>,
      ledger: path.join(journal.directory, 'applied-files.ndjson'),
      settingsOverride: { original: { bytes: settings.bytes, sha256: settings.sha256 }, replacement: Buffer.from(configuration.settings) },
      signal,
      progress: (value) => {
        progress.completedBytes = value.completedBytes;
        progress.totalBytes = value.totalBytes;
        options.progress({ ...progress });
      },
    });
    progress.stage = 'database';
    check = 'database';
    progress.totalRecords = Object.values(source.source.expected.counts).reduce((sum, count) => sum + count, 0);
    options.progress({ ...progress });
    const owner = await prepareRestoreDatabase({
      id: state.id,
      nonce: state.nonce,
      connection: runtime.connection,
      trustedMigrationsFolder: options.trustedMigrationsFolder,
      source: source.source,
      signal,
      onCreated: async (value) => {
        await createPrivate(path.join(journal.directory, 'database-owner.json'), Buffer.from(JSON.stringify(value)));
      },
      progress: (records, total) => {
        progress.records = records;
        progress.totalRecords = total;
        options.progress({ ...progress });
      },
    });
    signal.throwIfAborted();
    progress.stage = 'sealing';
    check = 'sealing';
    options.progress({ ...progress });
    for (const swap of swaps.values()) await swap.seal(signal);
    const { connection, ...containers } = runtime;
    check = 'runtime';
    const operation = await writeRestoreOperation(journal, {
      ...containers,
      version: 1,
      id: state.id,
      nonce: state.nonce,
      database: { connection, owner, counts: source.source.expected.counts },
      resumeApps: materialized.resumeApps,
      originalEnvSha256: hash(original),
      incomingEnvSha256: hash(incoming),
      files: materialized.files,
    });
    // A host configuration edit during preparation must not be overwritten at cutover.
    check = 'environment-unchanged';
    if (hash(await readPrivate(options.environment)) !== operation.originalEnvSha256) throw failed();
    signal.throwIfAborted();
    await journal.advance('prepared');
    progress.stage = 'prepared';
    options.progress({ ...progress });
    return { operation, configuration: configuration.review };
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    throw Object.assign(failed(), { preparationCheck: check });
  }
}

export async function discardRestorePayload(options: { journal: BackupRestoreJournal; connection: RestoreDatabaseConnection; signal: AbortSignal }) {
  const { journal, signal } = options;
  const state = await journal.refresh();
  if (!['staging', 'preparing', 'discarded'].includes(state.phase)) throw failed();
  signal.throwIfAborted();
  for (const name of state.roots) {
    try {
      await fs.lstat(path.join(journal.rootJournal(name), 'swap.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw failed();
    }
    await (await BackupDirectorySwap.open(journal.rootJournal(name))).discardPrepared();
  }
  let owner: RestoreDatabaseOwner | undefined;
  try {
    const value = ownerSchema(JSON.parse((await readPrivate(path.join(journal.directory, 'database-owner.json'))).toString('utf8')));
    if (value instanceof type.errors) throw failed();
    owner = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failed();
  }
  if (owner) {
    checkDatabaseConnection(await readPrivate(path.join(journal.directory, 'original.env')), options.connection);
    await removeRestoreDatabase({ id: state.id, nonce: state.nonce, connection: options.connection, owner, signal });
  }
  signal.throwIfAborted();
  await journal.advance('discarded');
}
