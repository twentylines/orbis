import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const parserProfile = 'orbis.source-configuration.dotenv-17.2.3.v1';
const workerRoots = [
  'core-inspection-worker.mjs',
  'core-source-configuration-worker.mjs',
  'core-clean-target-bootstrap-worker.mjs',
  'core-clean-target-worker.mjs',
] as const;
const supportedWorkerRoots = new Set<string>([...workerRoots, 'core-restoration-worker.mjs', 'core-live-reconciliation-worker.mjs']);
const otherCaptureEntries = new Set([
  'core-capture-publication.js',
  'core-capture-seal.js',
  'core-capture-catalog.js',
  'components-capture-catalog.js',
  'core-capture-image-inventory.js',
  'core-portable-worker.js',
]);
const chunkName = /^core-publication-[a-z0-9-]+\.mjs$/;
const migrationTag = /^\d{4}_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MiB = 1024 * 1024;

type ManifestFile = { name: string; bytes: Uint8Array };
type Inventory = Record<string, { bytes: number; sha256: string }>;
type JournalEntry = { tag: string; when: number };

function inventory(files: readonly ManifestFile[], count: number, perFile: number, total: number): Inventory {
  if (files.length === 0 || files.length > count) throw new Error('Restore runtime inventory file count is invalid');
  const result: Inventory = {};
  let size = 0;
  for (const file of files) {
    if (Object.hasOwn(result, file.name)) throw new Error('Restore runtime inventory contains duplicate files');
    if (file.bytes.byteLength === 0 || file.bytes.byteLength > perFile) throw new Error('Restore runtime inventory file size is invalid');
    size += file.bytes.byteLength;
    if (size > total) throw new Error('Restore runtime inventory total size is invalid');
    result[file.name] = { bytes: file.bytes.byteLength, sha256: createHash('sha256').update(file.bytes).digest('hex') };
  }
  return result;
}

function journalEntries(bytes: Uint8Array): JournalEntry[] {
  let journal: unknown;
  try {
    journal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Restore runtime migration journal is malformed');
  }
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error('Restore runtime migration journal is malformed');
  const value = journal as { version?: unknown; dialect?: unknown; entries?: unknown };
  if (
    Object.keys(value).sort().join(',') !== 'dialect,entries,version' ||
    value.version !== '7' ||
    value.dialect !== 'postgresql' ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > 4096
  )
    throw new Error('Restore runtime migration journal is malformed');
  const tags = new Set<string>();
  let previousWhen = 0;
  return value.entries.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Restore runtime migration entry is malformed');
    const item = entry as { idx?: unknown; version?: unknown; tag?: unknown; when?: unknown; breakpoints?: unknown };
    if (
      Object.keys(item).sort().join(',') !== 'breakpoints,idx,tag,version,when' ||
      item.idx !== index ||
      item.version !== value.version ||
      typeof item.tag !== 'string' ||
      !migrationTag.test(item.tag) ||
      !item.tag.startsWith(`${String(index).padStart(4, '0')}_`) ||
      tags.has(item.tag) ||
      typeof item.when !== 'number' ||
      !Number.isSafeInteger(item.when) ||
      item.when <= previousWhen ||
      typeof item.breakpoints !== 'boolean'
    )
      throw new Error('Restore runtime migration entry is malformed or out of order');
    tags.add(item.tag);
    previousWhen = item.when;
    return { tag: item.tag, when: item.when };
  });
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function generateCoreRestoreRuntimeManifest(input: {
  workers: readonly ManifestFile[];
  migrations: readonly ManifestFile[];
  dotenvVersion: string;
}): string {
  if (input.dotenvVersion !== '17.2.3') throw new Error('Restore runtime parser profile requires dotenv 17.2.3');
  for (const { name } of input.workers) {
    if (!supportedWorkerRoots.has(name) && !chunkName.test(name)) throw new Error('Restore runtime worker closure contains an unknown file');
  }
  const workers = inventory(input.workers, 64, 16 * MiB, 64 * MiB);
  if (workerRoots.some((name) => !Object.hasOwn(workers, name))) throw new Error('Restore runtime worker root is missing');
  const scanner = new Bun.Transpiler({ loader: 'js' });
  for (const worker of input.workers) {
    for (const dependency of scanner.scanImports(new TextDecoder('utf-8', { fatal: true }).decode(worker.bytes))) {
      if (dependency.path.startsWith('.')) {
        if (!dependency.path.startsWith('./') || !chunkName.test(dependency.path.slice(2)) || !Object.hasOwn(workers, dependency.path.slice(2)))
          throw new Error('Restore runtime worker closure has a missing or unknown local dependency');
      } else if (
        !/^(?:node:[a-z][a-z0-9_/-]*|(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*)$/.test(dependency.path) ||
        dependency.path.split('/').some((segment) => segment === '.' || segment === '..')
      ) {
        throw new Error('Restore runtime worker closure contains an unsafe dependency');
      }
    }
  }
  const migrations = inventory(input.migrations, 4097, 4 * MiB, 16 * MiB);
  for (const { name, bytes } of input.migrations) {
    if (name !== 'meta/_journal.json' && !/^\d{4}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.test(name))
      throw new Error('Restore runtime executable migration inventory contains an unknown file');
    if (name !== 'meta/_journal.json' && new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0'))
      throw new Error('Restore runtime migration SQL is invalid');
  }
  const journal = input.migrations.find((file) => file.name === 'meta/_journal.json');
  if (!journal) throw new Error('Restore runtime migration journal is missing');
  const entries = journalEntries(journal.bytes);
  if (entries.length + 1 !== input.migrations.length) throw new Error('Restore runtime executable migration inventory differs from its journal');
  const graph = entries.map((entry) => {
    const file = migrations[`${entry.tag}.sql`];
    if (!file) throw new Error('Restore runtime journal migration is missing');
    return { hash: file.sha256, created_at: String(entry.when) };
  });
  return sortedJson({
    schema: 'orbis.core-restore-release.v1',
    parserProfile,
    workers: { files: workers },
    migrations: { schema: 'orbis.core-executable-migration-inventory.v1', files: migrations },
    graph,
    qualification: {
      schema: 'orbis.core-restore-source-qualification.v1',
      scope: 'same-published-controller-only',
      parserProfile,
      configuration: 'captured-complete-configuration',
      sourceWrites: false,
      activation: false,
    },
  });
}

async function regularDirectory(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Restore runtime inventory directory is not a regular directory');
}

async function readRegularFile(filename: string, maximum: number): Promise<Uint8Array> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maximum)
      throw new Error('Restore runtime inventory file is not regular or exceeds its size bound');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('Restore runtime inventory file changed during reading');
      offset += bytesRead;
    }
    const tail = await file.read(Buffer.alloc(1), 0, 1, offset);
    const final = await file.stat();
    if (tail.bytesRead !== 0 || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs)
      throw new Error('Restore runtime inventory file changed during reading');
    return bytes;
  } finally {
    await file.close();
  }
}

export async function writeCoreRestoreRuntimeManifest(options: {
  dist: string;
  migrations: string;
  captureOutputs: readonly string[];
}): Promise<string> {
  const dotenvPackage = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readRegularFile(createRequire(import.meta.url).resolve('dotenv/package.json'), MiB)),
  );
  const dist = path.resolve(options.dist);
  const migrations = path.resolve(options.migrations);
  await regularDirectory(dist);
  await regularDirectory(migrations);
  await regularDirectory(path.join(migrations, 'meta'));
  const workers: ManifestFile[] = [];
  const seen = new Set<string>();
  let workerBytes = 0;
  for (const output of options.captureOutputs) {
    const filename = path.basename(output);
    if (path.resolve(output) !== path.join(dist, filename) || seen.has(filename)) throw new Error('Restore runtime capture output path is invalid');
    seen.add(filename);
    const name = filename.replace(/\.js$/, '.mjs');
    if ((filename.endsWith('.js') && supportedWorkerRoots.has(name)) || chunkName.test(filename)) {
      if (workers.length >= 64) throw new Error('Restore runtime inventory file count is invalid');
      const bytes = await readRegularFile(path.join(dist, filename), 16 * MiB);
      workerBytes += bytes.length;
      if (workerBytes > 64 * MiB) throw new Error('Restore runtime inventory total size is invalid');
      workers.push({ name, bytes });
    } else if (!otherCaptureEntries.has(filename)) {
      throw new Error('Restore runtime capture output contains an unknown file');
    }
  }
  const journal = await readRegularFile(path.join(migrations, 'meta/_journal.json'), 4 * MiB);
  const entries = journalEntries(journal);
  const expected = new Set(entries.map((entry) => `${entry.tag}.sql`));
  const rootFiles = await readdir(migrations);
  if (rootFiles.some((name) => name.endsWith('.sql') && !expected.has(name)))
    throw new Error('Restore runtime migration directory contains unjournaled SQL');
  const migrationFiles: ManifestFile[] = [{ name: 'meta/_journal.json', bytes: journal }];
  let migrationBytes = journal.length;
  for (const name of expected) {
    const bytes = await readRegularFile(path.join(migrations, name), 4 * MiB);
    migrationBytes += bytes.length;
    if (migrationBytes > 16 * MiB) throw new Error('Restore runtime inventory total size is invalid');
    migrationFiles.push({ name, bytes });
  }
  const manifest = generateCoreRestoreRuntimeManifest({ workers, migrations: migrationFiles, dotenvVersion: dotenvPackage.version });
  const destination = path.join(dist, 'core-restore-runtime.json');
  await writeFile(destination, manifest, { flag: 'wx', mode: 0o644 });
  return destination;
}
