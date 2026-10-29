import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { BackupExtractionBudget } from './backup-extraction-budget';
import type { RestoreTreeName } from './backup-restore-materialize';

const scopes = [
  { root: 'traefik', name: '', kind: 'directory' },
  { root: 'state', name: 'cluster.json', kind: 'file' },
  { root: 'state', name: 'secure-access', kind: 'directory' },
  { root: 'state', name: 'cluster-sync', kind: 'directory' },
  { root: 'user-config', name: 'tipi-compose.yml', kind: 'file' },
] as const;
const maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 64 * 1024 * 1024;
const maximumEntries = 250_000;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failed = () =>
  new BackupRequirementError(
    'Network access and cluster settings could not be preserved safely. Keep this server’s settings unchanged and review its settings sync configuration before retrying.',
  );
type Metadata = { uid: number; gid: number; mode: number; mtime: number };
type Entry = Metadata & {
  root: RestoreTreeName;
  relative: string;
  kind: 'file' | 'directory';
  device: string;
  inode: string;
  changed: number;
  bytes?: number;
  sha256?: string;
};
type Inventory = { roots: { name: string; device: string; inode: string }[]; absent: string[]; entries: Entry[] };
type Snapshot = { version: 1; id: string; original: Inventory; files: Entry[]; traefikRoot?: Entry };
export type RestoreHostIdentitySeal = { bytes: number; sha256: string };
export type RestoreHostIdentity = Awaited<ReturnType<typeof readRestoreHostIdentity>>;
const archiveName = (root: string, relative: string) => `data/${root}${relative ? `/${relative}` : ''}`;
const safeName = (name: string) =>
  !!name &&
  name !== '.' &&
  name !== '..' &&
  Buffer.byteLength(name) <= 255 &&
  !/[\\/\uD800-\uDFFF]/u.test(name) &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function preservesRestoreHostPath(name: string) {
  return scopes.some((scope) => {
    const base = archiveName(scope.root, scope.name);
    return name === base || (scope.kind === 'directory' && name.startsWith(`${base}/`));
  });
}

async function inventory(
  roots: Record<RestoreTreeName, string>,
  id: string,
  signal: AbortSignal,
  copy?: { directory: string; transform: (bytes: Buffer, hostId: string | undefined) => Uint8Array },
  preservedTraefikOnly = false,
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw failed();
  const result: Inventory = { roots: [], absent: [], entries: [] };
  let totalBytes = 0;
  let pathBytes = 0;
  const budget = copy ? new BackupExtractionBudget(copy.directory) : undefined;
  let clusterFile: string | undefined;
  const selected = preservedTraefikOnly ? scopes.filter((scope) => scope.root === 'traefik') : scopes;
  for (const name of [...new Set(selected.map((scope) => scope.root))]) {
    const directory = roots[name];
    if (!directory || !path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory)
      throw failed();
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) throw failed();
    result.roots.push({ name, device: String(stat.dev), inode: String(stat.ino) });
  }
  const visit = async (root: RestoreTreeName, relative: string, expected?: 'file' | 'directory') => {
    signal.throwIfAborted();
    const file = path.join(roots[root], relative);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (expected && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.absent.push(archiveName(root, relative));
        return;
      }
      throw error;
    }
    if (
      (await fs.realpath(file)) !== file ||
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      stat.mode & 0o7000 ||
      !Number.isSafeInteger(stat.dev) ||
      !Number.isSafeInteger(stat.ino)
    )
      throw failed();
    const kind = stat.isFile() ? 'file' : 'directory';
    if (expected && kind !== expected) throw failed();
    if (root === 'state' && relative === 'cluster-sync/settings.json' && kind !== 'file') throw failed();
    const entry: Entry = {
      root,
      relative,
      kind,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o777,
      mtime: stat.mtimeMs,
      device: String(stat.dev),
      inode: String(stat.ino),
      changed: stat.ctimeMs,
    };
    if (relative) {
      pathBytes += Buffer.byteLength(relative);
      if (result.entries.length >= maximumEntries || pathBytes > 32 * 1024 * 1024) throw failed();
      result.entries.push(entry);
    }
    if (kind === 'directory') {
      const names = async () =>
        (await fs.readdir(file)).sort().filter((name) => {
          if (!safeName(name)) throw failed();
          if (
            !preservedTraefikOnly &&
            !relative &&
            root === 'traefik' &&
            [`.orbis-restore-${id}.incoming`, `.orbis-restore-${id}.previous`].includes(name)
          )
            return false;
          if (!relative && root === 'traefik' && name.startsWith('.orbis-restore-')) throw failed();
          return true;
        });
      const beforeNames = await names();
      for (const name of beforeNames) {
        if (root === 'state' && relative === 'cluster-sync' && name !== 'settings.json') throw failed();
        await visit(root, relative ? `${relative}/${name}` : name);
      }
      const after = await fs.lstat(file);
      // Creating this transaction's working trees changes only the Traefik root timestamps.
      if (stat.dev !== after.dev || stat.ino !== after.ino || (relative && (stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs)))
        throw failed();
      if (!same(beforeNames, await names())) throw failed();
      return;
    }
    totalBytes += stat.size;
    if (stat.nlink !== 1 || stat.size > maximumFileBytes || totalBytes > maximumBytes) throw failed();
    const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const opened = await input.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.ctimeMs !== stat.ctimeMs || opened.nlink !== 1) throw failed();
      const index = result.entries.length - 1;
      if (copy) {
        await budget?.reserve(String(index), '-', stat.size);
        output = await fs.open(path.join(copy.directory, String(index)), 'wx', 0o600);
      }
      const digest = createHash('sha256');
      let count = 0;
      const transform = root === 'state' && relative === 'cluster-sync/settings.json';
      const chunks: Buffer[] = [];
      for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal })) {
        count += chunk.length;
        if (count > stat.size || (transform && count > 1024 * 1024)) throw failed();
        digest.update(chunk);
        if (copy && transform) chunks.push(chunk);
        else await output?.writeFile(chunk);
        await budget?.written(chunk.length);
      }
      const after = await input.stat();
      if (count !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs)
        throw failed();
      entry.bytes = count;
      entry.sha256 = digest.digest('hex');
      if (copy && transform) {
        let hostId: string | undefined;
        if (clusterFile) {
          const cluster = await fs.readFile(clusterFile);
          if (cluster.length > 1024 * 1024) throw failed();
          const value: unknown = JSON.parse(cluster.toString('utf8'));
          if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') hostId = value.id;
        }
        await output?.writeFile(copy.transform(Buffer.concat(chunks), hostId));
      }
      await output?.sync();
      if (copy && root === 'state' && relative === 'cluster.json') clusterFile = path.join(copy.directory, String(index));
    } finally {
      await output?.close();
      await input.close();
    }
  };
  for (const scope of selected) await visit(scope.root, scope.name, scope.kind);
  for (const root of result.roots) {
    const current = await fs.lstat(roots[root.name as RestoreTreeName]);
    if (!current.isDirectory() || String(current.dev) !== root.device || String(current.ino) !== root.inode) throw failed();
  }
  for (const name of result.absent) {
    const scope = scopes.find((value) => archiveName(value.root, value.name) === name);
    if (!scope) throw failed();
    try {
      await fs.lstat(path.join(roots[scope.root], scope.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw failed();
  }
  return result;
}

export async function captureRestoreHostIdentity(options: {
  directory: string;
  id: string;
  roots: Record<RestoreTreeName, string>;
  signal: AbortSignal;
  transformClusterSync: (bytes: Buffer, hostId: string | undefined) => Uint8Array;
}) {
  if (!path.isAbsolute(options.directory) || path.resolve(options.directory) !== options.directory) throw failed();
  await privateBackupDirectory(path.dirname(options.directory));
  await fs.mkdir(options.directory, { mode: 0o700 });
  const traefikRoot = await liveTraefikRoot(options.roots.traefik);
  const original = await inventory(options.roots, options.id, options.signal, {
    directory: options.directory,
    transform: options.transformClusterSync,
  });
  if (!same(original, await inventory(options.roots, options.id, options.signal))) throw failed();
  if (!same(traefikRoot, await liveTraefikRoot(options.roots.traefik))) throw failed();
  const files: Entry[] = [];
  for (const [index, entry] of original.entries.entries()) {
    if (entry.kind === 'directory') files.push(entry);
    else {
      const input = await fs.open(path.join(options.directory, String(index)), constants.O_RDONLY | constants.O_NOFOLLOW);
      const digest = createHash('sha256');
      let count = 0;
      try {
        for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal: options.signal })) {
          count += chunk.length;
          if (count > maximumFileBytes) throw failed();
          digest.update(chunk);
        }
      } finally {
        await input.close();
      }
      files.push({ ...entry, bytes: count, sha256: digest.digest('hex') });
    }
  }
  const bytes = Buffer.from(JSON.stringify({ version: 1, id: options.id, original, files, traefikRoot } satisfies Snapshot));
  if (bytes.length > 64 * 1024 * 1024) throw failed();
  const output = await fs.open(path.join(options.directory, 'snapshot.json'), 'wx', 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  const directory = await fs.open(options.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return { bytes: bytes.length, sha256: hash(bytes) };
}

export async function readRestoreHostIdentity(directory: string, id: string, seal: RestoreHostIdentitySeal) {
  await privateBackupDirectory(directory);
  const handle = await fs.open(path.join(directory, 'snapshot.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size !== seal.bytes ||
      stat.size > 64 * 1024 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw failed();
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (hash(bytes) !== seal.sha256) throw failed();
  const snapshot = JSON.parse(bytes.toString('utf8')) as Snapshot;
  if (snapshot.version !== 1 || snapshot.id !== id) throw failed();
  return {
    snapshot,
    directories: snapshot.files
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => ({ ...entry, name: archiveName(entry.root, entry.relative) })),
    files: snapshot.files.flatMap((entry, index) => {
      if (entry.kind !== 'file') return [];
      if (typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string') throw failed();
      return [
        {
          ...entry,
          name: archiveName(entry.root, entry.relative),
          bytes: entry.bytes,
          sha256: entry.sha256,
          inputPath: path.join(directory, String(index)),
        },
      ];
    }),
  };
}

export async function verifyRestoreHostIdentity(options: {
  directory: string;
  id: string;
  seal: RestoreHostIdentitySeal;
  roots: Record<RestoreTreeName, string>;
  signal: AbortSignal;
}) {
  const { snapshot } = await readRestoreHostIdentity(options.directory, options.id, options.seal);
  if (!same(snapshot.original, await inventory(options.roots, options.id, options.signal))) throw failed();
}

async function liveTraefikRoot(root: string): Promise<Entry> {
  if ((await fs.realpath(root)) !== root) throw failed();
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino)) throw failed();
  return {
    root: 'traefik',
    relative: '',
    kind: 'directory',
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
    mtime: stat.mtimeMs,
    changed: stat.ctimeMs,
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

export async function verifyPreservedTraefik(options: {
  directory: string;
  id: string;
  seal: RestoreHostIdentitySeal;
  roots: Record<RestoreTreeName, string>;
  signal: AbortSignal;
}) {
  const { snapshot } = await readRestoreHostIdentity(options.directory, options.id, options.seal);
  if (!snapshot.traefikRoot || !same(snapshot.traefikRoot, await liveTraefikRoot(options.roots.traefik))) throw failed();
  const original = {
    roots: snapshot.original.roots.filter((root) => root.name === 'traefik'),
    absent: snapshot.original.absent.filter((name) => name === 'data/traefik' || name.startsWith('data/traefik/')),
    entries: snapshot.original.entries.filter((entry) => entry.root === 'traefik'),
  };
  if (!same(original, await inventory(options.roots, options.id, options.signal, undefined, true))) throw failed();
}
