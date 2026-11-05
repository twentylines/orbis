import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readTarArchive } from '../../core/archive/tar-metadata';
import { backupMetadataBytes } from './backup-crypto';
import { archiveBackup } from './backup-files';
import { fullBackupLimits } from './backup-limits';

type Kind = 'settings' | 'dashboard' | 'wallpapers' | 'themes' | 'time-machine';
type Part = { name: string; kind: Kind; id: string | null; bytes: number; sha256: string };
type Manifest = {
  format: 'orbis-settings-backup';
  version: 1;
  id: string;
  createdAt: string;
  orbisVersion: string;
  indexSha256: string;
  entries: Part[];
};
type IndexPart = { name: string; bytes: number; sha256: string };
type Index = { format: 'orbis-settings-bundle'; version: 1; id: string; manifest: { bytes: number; sha256: string }; parts: IndexPart[] };
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MAX_TOTAL = 2 * 1024 * GIB + GIB;
const MAX_PART = 129 * GIB;
const invalid = () => new Error('Invalid settings bundle');
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const bytes = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const partName = (value: unknown): value is string =>
  typeof value === 'string' && /^parts\/[0-9a-f-]{36}\.orbis$/.test(value) && uuid(value.slice(6, -6));
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const parse = (data: Buffer): unknown => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const value: unknown = JSON.parse(text);
  if (!json(value).equals(data)) throw invalid();
  return value;
};
const validateIndex = (v: unknown): Index => {
  if (
    !exact(v, ['format', 'version', 'id', 'manifest', 'parts']) ||
    v.format !== 'orbis-settings-bundle' ||
    v.version !== 1 ||
    !uuid(v.id) ||
    !exact(v.manifest, ['bytes', 'sha256']) ||
    !bytes(v.manifest.bytes, MIB) ||
    !hash(v.manifest.sha256) ||
    !Array.isArray(v.parts) ||
    !v.parts.length ||
    v.parts.length > 128
  )
    throw invalid();
  const names = new Set<string>();
  let total = 0;
  for (const p of v.parts) {
    if (!exact(p, ['name', 'bytes', 'sha256']) || !partName(p.name) || !bytes(p.bytes, MAX_PART) || !hash(p.sha256) || names.has(p.name))
      throw invalid();
    names.add(p.name);
    total += p.bytes;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw invalid();
  }
  return v as Index;
};
const indexDigest = (index: Index) => digest(json({ format: index.format, version: index.version, id: index.id, parts: index.parts }));
const validateManifest = (v: unknown, index: Index): Manifest => {
  if (
    !exact(v, ['format', 'version', 'id', 'createdAt', 'orbisVersion', 'indexSha256', 'entries']) ||
    v.format !== 'orbis-settings-backup' ||
    v.version !== 1 ||
    v.id !== index.id ||
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    new Date(v.createdAt).toISOString() !== v.createdAt ||
    typeof v.orbisVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(v.orbisVersion) ||
    v.indexSha256 !== indexDigest(index) ||
    !Array.isArray(v.entries) ||
    v.entries.length !== index.parts.length
  )
    throw invalid();
  const ids = new Set<string>();
  for (const [i, p] of v.entries.entries()) {
    const ref = index.parts[i];
    if (
      !exact(p, ['name', 'kind', 'id', 'bytes', 'sha256']) ||
      !ref ||
      p.name !== ref.name ||
      p.bytes !== ref.bytes ||
      p.sha256 !== ref.sha256 ||
      !['settings', 'dashboard', 'wallpapers', 'themes', 'time-machine'].includes(p.kind as string)
    )
      throw invalid();
    if (p.kind === 'time-machine' ? !uuid(p.id) : p.id !== null || !bytes(p.bytes, GIB)) throw invalid();
    const key = p.kind === 'time-machine' ? `tm:${p.id}` : String(p.kind);
    if (ids.has(key)) throw invalid();
    ids.add(key);
  }
  return v as Manifest;
};
const seal = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}:${s.nlink}:${s.uid}`;
const openPrivate = async (file: string) => {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw invalid();
    return { handle, stat: s };
  } catch (e) {
    await handle.close();
    throw e;
  }
};
const capacity = async (directory: string, required: number) => {
  const space = await fsp.statfs(directory, { bigint: true });
  if (!Number.isSafeInteger(required) || required < 0 || space.bavail * space.bsize < BigInt(required) + BigInt(fullBackupLimits.reserveBytes))
    throw invalid();
};
const measureSealed = async (file: string, signal: AbortSignal, limit: number) => {
  const { handle, stat } = await openPrivate(file);
  try {
    if (!bytes(stat.size, limit)) throw invalid();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    let at = 0;
    while (at < stat.size) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - at), at);
      if (!read.bytesRead) throw invalid();
      hash.update(buffer.subarray(0, read.bytesRead));
      at += read.bytesRead;
    }
    if (seal(await handle.stat()) !== seal(stat) || seal(await fsp.lstat(file)) !== seal(stat)) throw invalid();
    return { bytes: at, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
};
const copySealed = async (source: string, destination: string, signal: AbortSignal, limit: number) => {
  const { handle, stat } = await openPrivate(source);
  let output: fs.promises.FileHandle | undefined;
  try {
    if (!bytes(stat.size, limit)) throw invalid();
    await capacity(path.dirname(destination), stat.size);
    output = await fsp.open(destination, 'wx', 0o600);
    const h = createHash('sha256');
    let position = 0;
    const buffer = Buffer.alloc(256 * 1024);
    while (position < stat.size) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) throw invalid();
      h.update(buffer.subarray(0, bytesRead));
      let n = 0;
      while (n < bytesRead) {
        const w = await output.write(buffer, n, bytesRead - n);
        if (!w.bytesWritten) throw invalid();
        n += w.bytesWritten;
      }
      position += bytesRead;
    }
    if (seal(await handle.stat()) !== seal(stat) || seal(await fsp.lstat(source)) !== seal(stat)) throw invalid();
    await output.sync();
    return { bytes: position, sha256: h.digest('hex') };
  } finally {
    await output?.close();
    await handle.close();
  }
};
const fresh = async (dir: string) => {
  const parent = path.dirname(dir);
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || (await fsp.realpath(parent)) !== parent) throw invalid();
  const owner = await fsp.lstat(parent);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.mode & 0o077 || (process.getuid && owner.uid !== process.getuid())) throw invalid();
  await fsp.mkdir(dir, { mode: 0o700 });
  const s = await fsp.lstat(dir);
  if (!s.isDirectory() || s.mode & 0o077 || (process.getuid && s.uid !== process.getuid()) || (await fsp.realpath(dir)) !== path.resolve(dir)) {
    throw invalid();
  }
  return s;
};
const cleanup = async (dir: string, expected: fs.Stats) => {
  const actual = await fsp.lstat(dir);
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.uid !== expected.uid ||
    actual.mode !== expected.mode
  )
    throw invalid();
  await fsp.rm(dir, { recursive: true });
};
const outside = (dir: string, file: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..')) throw invalid();
};
export async function exportSettingsBundle(options: {
  destination: string;
  directory: string;
  id: string;
  createdAt: string;
  orbisVersion: string;
  passphrase: string;
  parts: { kind: Kind; id: string | null; file: string; bytes: number; sha256: string }[];
  signal: AbortSignal;
  progress?: (completedBytes: number) => void;
}) {
  const { directory, destination, signal } = options;
  outside(directory, destination);
  for (const p of options.parts) outside(directory, p.file);
  signal.throwIfAborted();
  const owned = await fresh(directory);
  try {
    const content = path.join(directory, 'content');
    await fsp.mkdir(content, { mode: 0o700 });
    await fsp.mkdir(path.join(content, 'parts'), { mode: 0o700 });
    const entries: Part[] = [];
    let completed = 0;
    if (!options.parts.length || options.parts.length > 128) throw invalid();
    for (const part of options.parts) {
      const name = `parts/${randomUUID()}.orbis`;
      const result = await copySealed(part.file, path.join(content, name), signal, part.kind === 'time-machine' ? MAX_PART : GIB);
      if (result.bytes !== part.bytes || result.sha256 !== part.sha256) throw invalid();
      entries.push({ name, kind: part.kind, id: part.id, ...result });
      completed += result.bytes;
      options.progress?.(completed);
    }
    const parts = entries.map(({ name, bytes: size, sha256 }) => ({ name, bytes: size, sha256 }));
    const partial = { format: 'orbis-settings-bundle' as const, version: 1 as const, id: options.id, parts };
    const manifest: Manifest = {
      format: 'orbis-settings-backup',
      version: 1,
      id: options.id,
      createdAt: options.createdAt,
      orbisVersion: options.orbisVersion,
      indexSha256: digest(json(partial)),
      entries,
    };
    const encrypted = await backupMetadataBytes(json(manifest), options.passphrase, false, MIB - 128);
    if (encrypted.length > MIB) throw invalid();
    const index = validateIndex({ ...partial, manifest: { bytes: encrypted.length, sha256: digest(encrypted) }, parts });
    validateManifest(manifest, index);
    await fsp.writeFile(path.join(content, 'bundle.json'), json(index), { mode: 0o600, flag: 'wx' });
    await fsp.writeFile(path.join(content, 'manifest.orbis'), encrypted, { mode: 0o600, flag: 'wx' });
    const archive = path.join(directory, 'bundle.tar');
    await capacity(directory, completed + 4 * MIB);
    await archiveBackup(content, archive, signal, { gzip: false });
    const result = await measureSealed(archive, signal, MAX_TOTAL + 4 * MIB);
    signal.throwIfAborted();
    await fsp.link(archive, destination);
    const parent = await fsp.open(path.dirname(destination), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { ...result, manifest };
  } finally {
    await cleanup(directory, owned);
  }
}
export async function importSettingsBundle(options: {
  source: string;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
  progress?: (completedBytes: number) => void;
}) {
  const { source, directory, signal } = options;
  outside(directory, source);
  signal.throwIfAborted();
  const owned = await fresh(directory);
  try {
    const sealedSource = path.join(directory, 'source.tar');
    const copied = await copySealed(source, sealedSource, signal, MAX_TOTAL + 4 * MIB);
    await capacity(directory, copied.bytes);
    const seen = new Set<string>();
    const contents = new Map<string, { bytes: number; sha256: string; file: string }>();
    let out: fs.promises.FileHandle | undefined;
    let h = createHash('sha256');
    let current = '';
    let size = 0;
    let done = 0;
    let declared = 0;
    try {
      await readTarArchive(sealedSource, false, signal, {
        strict: true,
        maxEntries: 132,
        maxExpandedBytes: MAX_TOTAL + 4 * MIB,
        collectEntries: false,
        onEntry: async (entry) => {
          const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
          if (name === '.' || name === '') {
            if (entry.type !== 'd' || seen.has('.')) throw invalid();
            seen.add('.');
            return;
          }
          if (name === 'parts') {
            if (entry.type !== 'd' || seen.has(name)) throw invalid();
            seen.add(name);
            return;
          }
          if (
            entry.type !== '-' ||
            seen.has(name) ||
            !(name === 'bundle.json' || name === 'manifest.orbis' || partName(name)) ||
            !bytes(entry.size, name === 'bundle.json' ? 128 * 1024 : name === 'manifest.orbis' ? MIB : MAX_PART)
          )
            throw invalid();
          declared += entry.size;
          if (!Number.isSafeInteger(declared) || declared > MAX_TOTAL + 4 * MIB) throw invalid();
          seen.add(name);
          current = name;
          size = entry.size;
          h = createHash('sha256');
          const target = path.join(directory, `entry-${seen.size}`);
          out = await fsp.open(target, 'wx', 0o600);
          contents.set(name, { bytes: size, sha256: '', file: target });
        },
        onData: async (data) => {
          if (!out) throw invalid();
          h.update(data);
          let offset = 0;
          while (offset < data.length) {
            const w = await out.write(data, offset, data.length - offset);
            if (!w.bytesWritten) throw invalid();
            offset += w.bytesWritten;
          }
          done += data.length;
          options.progress?.(done);
        },
        onEntryEnd: async () => {
          if (out) {
            await out.close();
            out = undefined;
            const item = contents.get(current);
            if (!item) throw invalid();
            item.sha256 = h.digest('hex');
          }
        },
      });
    } finally {
      await out?.close();
    }
    await fsp.unlink(sealedSource);
    const indexFile = contents.get('bundle.json');
    const manifestFile = contents.get('manifest.orbis');
    if (!indexFile || !manifestFile) throw invalid();
    const index = validateIndex(parse(await fsp.readFile(indexFile.file)));
    if (manifestFile.bytes !== index.manifest.bytes || manifestFile.sha256 !== index.manifest.sha256 || contents.size !== index.parts.length + 2)
      throw invalid();
    for (const p of index.parts) {
      const got = contents.get(p.name);
      if (!got || got.bytes !== p.bytes || got.sha256 !== p.sha256) throw invalid();
    }
    const manifest = validateManifest(parse(await backupMetadataBytes(await fsp.readFile(manifestFile.file), options.passphrase, true, MIB)), index);
    signal.throwIfAborted();
    let disposed = false;
    return {
      archiveSha256: copied.sha256,
      bytes: copied.bytes,
      manifest,
      parts: manifest.entries.map((entry) => {
        const item = contents.get(entry.name);
        if (!item) throw invalid();
        return { ...entry, file: item.file };
      }),
      dispose: async () => {
        if (!disposed) {
          await cleanup(directory, owned);
          disposed = true;
        }
      },
    };
  } catch (error) {
    await cleanup(directory, owned);
    throw error;
  }
}
