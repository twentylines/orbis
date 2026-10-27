import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { appInfoSchema } from '@runtipi/common/schemas';
import { createAppUrn, validateAppUrn } from '@/common/helpers/app-helpers';
import { BackupRequirementError } from './backup-files';
import { fullBackupLimits } from './backup-limits';
import { type BackupContentIntegrity, parseFullBackupManifest } from './backup-import';
import { readNormalizedBackupDatabase } from './backup-normalized-database';
import type { BackupDatabaseReview } from './backup-database.service';

const sha256 = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const digest = type({ bytes: 'number.integer > 0 & number <= 9007199254740991', sha256 }).onUndeclaredKey('reject');
const counts = type({
  user: 'number.integer >= 0',
  app_store: 'number.integer >= 0',
  app: 'number.integer >= 0',
  link: 'number.integer >= 0',
}).onUndeclaredKey('reject');
const sealSchema = type({
  version: '1',
  manifest: digest,
  recovery: digest,
  database: digest,
  normalized: type({ bytes: 'number.integer > 0 & number <= 268435456', sha256, counts }).onUndeclaredKey('reject'),
}).onUndeclaredKey('reject');
export type BackupSourceSeal = typeof sealSchema.infer;
const failed = () => new BackupRequirementError('The reviewed backup changed or is incomplete. Review its encrypted file again before restoring.');
export class BackupSourcePinnedError extends BackupRequirementError {
  constructor() {
    super('Restore preparation needs recovery. The reviewed backup has been preserved in its restore journal.');
  }
}

export function createBackupSourceSeal(integrity: BackupContentIntegrity, normalized: BackupDatabaseReview): BackupSourceSeal {
  const result = sealSchema({ version: 1, ...integrity, normalized });
  if (result instanceof type.errors) throw failed();
  return structuredClone(result);
}

async function privateDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== directory
  )
    throw failed();
}
async function privateFile(file: string, signal: AbortSignal, expected?: { bytes: number; sha256: string }, maximum?: number) {
  signal.throwIfAborted();
  if ((await fs.realpath(file)) !== file) throw failed();
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid()) ||
      (expected && before.size !== expected.bytes) ||
      (maximum !== undefined && before.size > maximum)
    )
      throw failed();
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of input.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if ((expected && bytes > expected.bytes) || (maximum !== undefined && bytes > maximum)) throw failed();
      digest.update(chunk);
      if (maximum !== undefined) chunks.push(chunk);
    }
    const after = await input.stat();
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      bytes !== before.size ||
      (expected && digest.digest('hex') !== expected.sha256)
    )
      throw failed();
    return maximum === undefined ? undefined : Buffer.concat(chunks);
  } finally {
    await input.close();
  }
}
async function json(file: string, signal: AbortSignal, maximum: number, expected?: { bytes: number; sha256: string }) {
  const bytes = await privateFile(file, signal, expected, maximum);
  if (!bytes) throw failed();
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw failed();
  }
}

export async function validateBackupSource(options: { directory: string; expected: BackupSourceSeal; signal: AbortSignal }) {
  const { directory, signal } = options;
  try {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw failed();
    const seal = sealSchema(options.expected);
    if (seal instanceof type.errors) throw failed();
    await privateDirectory(directory);
    const content = path.join(directory, 'content');
    const database = path.join(directory, 'database');
    await privateDirectory(content);
    await privateDirectory(database);
    if ((await fs.readdir(database)).sort().join(',') !== 'records.json,records.ndjson') throw failed();
    const manifest = parseFullBackupManifest(await json(path.join(content, 'manifest.json'), signal, fullBackupLimits.manifestBytes, seal.manifest));
    const recovery = await json(path.join(content, 'recovery.json'), signal, 1024 * 1024, seal.recovery);
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) throw failed();
    const fields = recovery as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !['jwtSecret', 'userSettings'].includes(key)) ||
      typeof fields.jwtSecret !== 'string' ||
      !fields.jwtSecret ||
      fields.jwtSecret.length > 4096 ||
      !fields.userSettings ||
      typeof fields.userSettings !== 'object' ||
      Array.isArray(fields.userSettings)
    )
      throw failed();
    await privateFile(path.join(content, 'database.dump'), signal, seal.database);
    const normalized = await json(path.join(database, 'records.json'), signal, 16 * 1024);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw failed();
    const normalizedFields = normalized as Record<string, unknown>;
    // records.json adds only its format version to the already reviewed record digest.
    const { version, ...recordReview } = normalizedFields;
    if (
      version !== 1 ||
      Object.keys(recordReview).length !== 3 ||
      normalizedFields.bytes !== seal.normalized.bytes ||
      normalizedFields.sha256 !== seal.normalized.sha256 ||
      counts(normalizedFields.counts) instanceof type.errors ||
      Object.entries(seal.normalized.counts).some(([name, count]) => (normalizedFields.counts as Record<string, unknown>)[name] !== count)
    )
      throw failed();
    const files = new Map(manifest.files.map((entry) => [entry.name, entry]));
    const directories = new Set(['data', ...manifest.directories.map((entry) => entry.name)]);
    const remaining = new Set([
      ...files.keys(),
      ...manifest.directories.map((entry) => entry.name),
      'data',
      'manifest.json',
      'recovery.json',
      'database.dump',
    ]);
    const walk = async (current: string, prefix = '') => {
      for (const name of await fs.readdir(current)) {
        signal.throwIfAborted();
        const relative = prefix ? `${prefix}/${name}` : name;
        if (!remaining.delete(relative)) throw failed();
        const file = path.join(current, name);
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) {
          if (!directories.has(relative)) throw failed();
          await privateDirectory(file);
          await walk(file, relative);
        } else if (
          !stat.isFile() ||
          (!files.has(relative) && !['manifest.json', 'recovery.json', 'database.dump'].includes(relative)) ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.mode & 0o077 ||
          (process.getuid && stat.uid !== process.getuid()) ||
          (files.has(relative) && stat.size !== files.get(relative)?.bytes)
        )
          throw failed();
      }
    };
    await walk(content);
    if (remaining.size) throw failed();
    const passkeysFile = files.get('data/state/auth/passkeys.json');
    const passkeys = passkeysFile ? await json(path.join(content, passkeysFile.name), signal, 512 * 1024, passkeysFile) : undefined;
    const apps = new Map<string, { id: number; appUrn: string; config: string }>();
    const source = {
      file: path.join(database, 'records.ndjson'),
      expected: seal.normalized,
      jwtSecret: fields.jwtSecret,
      ...(passkeysFile ? { passkeys } : {}),
    };
    await readNormalizedBackupDatabase(source, signal, async (table, row) => {
      if (table !== 'app') return;
      const appUrn = validateAppUrn(createAppUrn(String(row.app_name), String(row.app_store_slug)));
      const project = appUrn.replace(':', '_');
      if (apps.has(project)) throw failed();
      apps.set(project, { id: Number(row.id), appUrn, config: `data/apps/${row.app_store_slug}/${row.app_name}/config.json` });
    });
    const ids = new Set<string>();
    const running = new Set<string>();
    for (const container of manifest.containers) {
      if (ids.has(container.id) || !apps.has(container.project)) throw failed();
      ids.add(container.id);
      if (container.running) running.add(container.project);
    }
    for (const image of manifest.images) if (!apps.has(image.project)) throw failed();
    const resumeApps: { id: number; appUrn: string }[] = [];
    for (const project of running) {
      const app = apps.get(project);
      if (!app) throw failed();
      const file = files.get(app.config);
      if (!file) throw failed();
      const config = await json(path.join(content, app.config), signal, 1024 * 1024, file);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw failed();
      const info = appInfoSchema({ ...config, urn: app.appUrn });
      const [name] = app.appUrn.split(':');
      if (
        info instanceof type.errors ||
        info.id !== name ||
        !info.available ||
        !['docker-compose.yml', 'docker-compose.json'].some((name) => files.has(path.posix.join(path.posix.dirname(app.config), name)))
      )
        throw failed();
      resumeApps.push({ id: app.id, appUrn: app.appUrn });
    }
    return {
      directory,
      manifest,
      recovery: { jwtSecret: fields.jwtSecret, userSettings: fields.userSettings as Record<string, unknown> },
      source,
      resumeApps,
    };
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof BackupRequirementError) throw error;
    throw failed();
  }
}

export async function pinBackupSource(options: { directory: string; destination: string; expected: BackupSourceSeal; signal: AbortSignal }) {
  const { directory, destination, signal } = options;
  if (
    !path.isAbsolute(destination) ||
    path.resolve(destination) !== destination ||
    destination === directory ||
    destination.startsWith(`${directory}/`) ||
    directory.startsWith(`${destination}/`)
  )
    throw failed();
  const source = await validateBackupSource(options);
  const parent = path.dirname(destination);
  await privateDirectory(parent);
  const before = await fs.lstat(directory);
  const target = await fs.lstat(parent);
  if (before.dev !== target.dev) throw new BackupRequirementError('Backup review and restore storage must use the same filesystem.');
  signal.throwIfAborted();
  // mkdir is an atomic no-replace claim; rename alone can replace an empty directory.
  await fs.mkdir(destination, { mode: 0o700 });
  const payload = path.join(destination, 'payload');
  signal.throwIfAborted();
  await fs.rename(directory, payload);
  try {
    for (const parent of new Set([path.dirname(directory), destination, path.dirname(destination)])) {
      const handle = await fs.open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch {
    throw new BackupSourcePinnedError();
  }
  return { ...source, directory: payload, source: { ...source.source, file: path.join(payload, 'database', 'records.ndjson') } };
}
