import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { readTarArchive, type TarEntry } from '@/core/archive/tar-metadata';
import { gt, valid } from 'semver';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { fullBackupLimits } from './backup-limits';
import { BackupExtractionBudget } from './backup-extraction-budget';

const maxEntries = fullBackupLimits.entries + 10;
const manifestLimit = fullBackupLimits.manifestBytes;
const dataRoots = new Set(['state', 'apps', 'repos', 'media', 'user-config', 'traefik']);
const specialFiles = new Set(['manifest.json', 'recovery.json', 'database.dump']);
const invalid = () => new BackupRequirementError('This file is not a complete, supported Orbis backup. No server data has been changed.');
const controls = (value: string) => Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function backupMemberName(value: string): string {
  if (value === '.' || value === './') return '.';
  const name = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !name ||
    name.length > 4096 ||
    controls(name) ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw invalid();
  return name;
}

type FileMetadata = { name: string; bytes: number; sha256: string; mode: number; uid: number; gid: number; mtime: number };
type DirectoryMetadata = Omit<FileMetadata, 'bytes' | 'sha256'>;
export type FullBackupManifest = {
  format: 'orbis-full-backup';
  version: 1;
  createdAt: number;
  orbisVersion: string;
  runtipiVersion: string;
  architecture: 'arm64' | 'amd64';
  files: FileMetadata[];
  directories: DirectoryMetadata[];
  containers: { id: string; project: string; running: boolean }[];
  images: { project: string; image: string }[];
  exclusions: string[];
};
export type FullBackupReview = {
  hostIdentityPolicy: 'preserve-destination';
  formatVersion: 1;
  createdAt: number;
  orbisVersion: string;
  runtipiVersion: string;
  architecture: 'arm64' | 'amd64';
  fileCount: number;
  appCount: number;
  expandedBytes: number;
  manifestSha256: string;
  databaseValidation: 'pending' | 'validated';
  databaseRecords?: number;
  compatibility: { compatible: boolean; blockers: ('runtipi-version' | 'newer-orbis' | 'unknown-orbis-version')[]; architectureChanged: boolean };
};
export type BackupContentIntegrity = Record<'manifest' | 'recovery' | 'database', { bytes: number; sha256: string }>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const boundedString = (value: unknown, maximum = 200) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !controls(value);
function metadata(value: unknown, file: boolean): FileMetadata | DirectoryMetadata {
  const item = record(value);
  const keys = ['name', 'mode', 'uid', 'gid', 'mtime', ...(file ? ['bytes', 'sha256'] : [])];
  if (
    Object.keys(item).some((key) => !keys.includes(key)) ||
    typeof item.name !== 'string' ||
    backupMemberName(item.name) !== item.name ||
    !integer(item.mode, 0o777) ||
    !integer(item.uid, 0xffffffff) ||
    !integer(item.gid, 0xffffffff) ||
    typeof item.mtime !== 'number' ||
    !Number.isFinite(item.mtime) ||
    Math.abs(item.mtime) > 8.64e15
  )
    throw invalid();
  if (file && (!integer(item.bytes) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw invalid();
  return item as unknown as FileMetadata | DirectoryMetadata;
}

export function parseFullBackupManifest(value: unknown): FullBackupManifest {
  const source = record(value);
  if (
    Object.keys(source).some(
      (key) =>
        ![
          'format',
          'version',
          'createdAt',
          'orbisVersion',
          'runtipiVersion',
          'architecture',
          'files',
          'directories',
          'containers',
          'images',
          'exclusions',
        ].includes(key),
    ) ||
    source.format !== 'orbis-full-backup' ||
    source.version !== 1 ||
    !integer(source.createdAt) ||
    !source.createdAt ||
    source.createdAt > 8.64e15 ||
    !boundedString(source.orbisVersion) ||
    !boundedString(source.runtipiVersion) ||
    !['arm64', 'amd64'].includes(String(source.architecture)) ||
    !Array.isArray(source.files) ||
    !Array.isArray(source.directories) ||
    source.files.length + source.directories.length > maxEntries ||
    !Array.isArray(source.containers) ||
    !Array.isArray(source.images) ||
    source.containers.length > 1024 ||
    source.images.length > 1024 ||
    !Array.isArray(source.exclusions) ||
    source.exclusions.length > 16 ||
    source.exclusions.some((item) => !['logs', 'cache', 'previous-backups', 'container-images', 'restore-recovery-files'].includes(item))
  )
    throw invalid();
  for (const item of source.files) metadata(item, true);
  for (const item of source.directories) metadata(item, false);
  for (const entry of source.containers) {
    const item = record(entry);
    if (
      Object.keys(item).some((key) => !['id', 'project', 'running'].includes(key)) ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      typeof item.project !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,255}$/.test(item.project) ||
      typeof item.running !== 'boolean'
    )
      throw invalid();
  }
  for (const entry of source.images) {
    const item = record(entry);
    if (
      Object.keys(item).some((key) => !['project', 'image'].includes(key)) ||
      typeof item.project !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,255}$/.test(item.project) ||
      !boundedString(item.image, 2048)
    )
      throw invalid();
  }
  const manifest = source as unknown as FullBackupManifest;
  const names = new Set<string>();
  for (const entry of manifest.files) {
    if (names.has(entry.name) || specialFiles.has(entry.name) || !allowedMember(entry.name, '-')) throw invalid();
    names.add(entry.name);
  }
  for (const entry of manifest.directories) {
    if (names.has(entry.name) || ['.', 'data'].includes(entry.name) || !allowedMember(entry.name, 'd')) throw invalid();
    names.add(entry.name);
  }
  return manifest;
}

function allowedMember(name: string, type: string) {
  if (!['-', 'd'].includes(type)) return false;
  if (name === '.' || name === 'data' || name === 'app-data') return type === 'd';
  if (specialFiles.has(name) || name === 'data/.env') return type === '-';
  const parts = name.split('/');
  if (
    (parts[0] === 'app-data' ? parts[1] : parts[0] === 'data' && dataRoots.has(parts[1] ?? '') ? parts[2] : undefined)?.startsWith('.orbis-restore-')
  )
    return false;
  if (name.startsWith('app-data/')) return true;
  return parts[0] === 'data' && dataRoots.has(parts[1] ?? '') && (parts.length > 2 || type === 'd');
}

export async function inspectFullBackup(options: {
  archive: string;
  destination: string;
  signal: AbortSignal;
  maxExpandedBytes: number;
  target: { orbisVersion: string; runtipiVersion: string; architecture: string };
  progress?: (completedBytes: number) => void;
}): Promise<{ manifest: FullBackupManifest; review: FullBackupReview; integrity: BackupContentIntegrity }> {
  const { archive, destination, signal, maxExpandedBytes, target, progress } = options;
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1024)
    throw new BackupRequirementError('There is not enough free storage to inspect this backup.');
  await privateBackupDirectory(destination);
  if ((await fs.readdir(destination)).length) throw invalid();
  const members = new Map<string, { type: string; bytes: number; sha256?: string }>();
  const budget = new BackupExtractionBudget(destination);
  let output: FileHandle | undefined;
  let current: { name: string; size: number; bytes: number; hash: ReturnType<typeof createHash> } | undefined;
  let completed = 0;
  try {
    await readTarArchive(archive, true, signal, {
      strict: true,
      maxEntries,
      maxExpandedBytes,
      collectEntries: false,
      onEntry: async (entry: TarEntry) => {
        signal.throwIfAborted();
        const name = backupMemberName(entry.path);
        if (
          members.has(name) ||
          !allowedMember(name, entry.type) ||
          (name === 'manifest.json' && entry.size > manifestLimit) ||
          (['recovery.json', 'data/.env', 'data/state/seed'].includes(name) && entry.size > 1024 * 1024)
        )
          throw invalid();
        members.set(name, { type: entry.type, bytes: entry.size });
        await budget.reserve(name, entry.type, entry.size);
        if (name === '.') return;
        const file = path.join(destination, name);
        if (entry.type === 'd') await fs.mkdir(file, { recursive: true, mode: 0o700 });
        else {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          output = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          current = { name, size: entry.size, bytes: 0, hash: createHash('sha256') };
        }
      },
      onData: async (chunk) => {
        signal.throwIfAborted();
        if (!output || !current) throw invalid();
        await budget.written(chunk.length);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new BackupRequirementError('Backup inspection ran out of writable storage.');
          offset += bytesWritten;
        }
        current.bytes += chunk.length;
        current.hash.update(chunk);
        completed += chunk.length;
        progress?.(completed);
      },
      onEntryEnd: async () => {
        if (!current) return;
        if (current.bytes !== current.size) throw invalid();
        const member = members.get(current.name);
        if (!member) throw invalid();
        member.sha256 = current.hash.digest('hex');
        await output?.close();
        output = undefined;
        current = undefined;
      },
    });
    signal.throwIfAborted();
    for (const name of [...specialFiles, 'data/.env', 'data/state/seed'])
      if (members.get(name)?.type !== '-' || !members.get(name)?.bytes) throw invalid();
    const manifest = parseFullBackupManifest(JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8')));
    const expected = new Set<string>(specialFiles);
    const expectedDirectories = new Set<string>(['.', 'data']);
    for (const file of manifest.files) {
      if (expected.has(file.name) || !allowedMember(file.name, '-') || specialFiles.has(file.name)) throw invalid();
      expected.add(file.name);
      const actual = members.get(file.name);
      if (!actual || actual.type !== '-' || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw invalid();
    }
    const declaredDirectories = new Set<string>();
    for (const directory of manifest.directories) {
      if (['.', 'data'].includes(directory.name) || !allowedMember(directory.name, 'd') || declaredDirectories.has(directory.name)) throw invalid();
      declaredDirectories.add(directory.name);
      expectedDirectories.add(directory.name);
    }
    for (const [name, member] of members) {
      if (member.type === '-' ? !expected.has(name) : !expectedDirectories.has(name)) throw invalid();
    }
    for (const name of expectedDirectories) if (members.get(name)?.type !== 'd') throw invalid();
    const database = await fs.open(path.join(destination, 'database.dump'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const magic = Buffer.alloc(5);
    try {
      await database.read(magic, 0, 5, 0);
    } finally {
      await database.close();
    }
    if (magic.toString() !== 'PGDMP') throw invalid();
    const recovery = record(JSON.parse(await fs.readFile(path.join(destination, 'recovery.json'), 'utf8')));
    if (
      Object.keys(recovery).some((key) => !['jwtSecret', 'userSettings'].includes(key)) ||
      typeof recovery.jwtSecret !== 'string' ||
      !recovery.jwtSecret ||
      recovery.jwtSecret.length > 4096
    )
      throw invalid();
    record(recovery.userSettings);
    const blockers: FullBackupReview['compatibility']['blockers'] = [];
    if ((valid(manifest.runtipiVersion) ?? manifest.runtipiVersion) !== (valid(target.runtipiVersion) ?? target.runtipiVersion))
      blockers.push('runtipi-version');
    if (manifest.orbisVersion !== target.orbisVersion) {
      if (!valid(manifest.orbisVersion) || !valid(target.orbisVersion)) blockers.push('unknown-orbis-version');
      else if (gt(manifest.orbisVersion, target.orbisVersion)) blockers.push('newer-orbis');
    }
    const apps = new Set(manifest.files.map((file) => /^data\/apps\/([^/]+\/[^/]+)\/config\.json$/.exec(file.name)?.[1]).filter(Boolean));
    return {
      manifest,
      integrity: Object.fromEntries(
        (['manifest', 'recovery', 'database'] as const).map((name) => {
          const member = members.get(`${name === 'database' ? 'database.dump' : `${name}.json`}`);
          if (!member?.sha256) throw invalid();
          return [name, { bytes: member.bytes, sha256: member.sha256 }];
        }),
      ) as BackupContentIntegrity,
      review: {
        hostIdentityPolicy: 'preserve-destination',
        formatVersion: 1,
        createdAt: manifest.createdAt,
        orbisVersion: manifest.orbisVersion,
        runtipiVersion: manifest.runtipiVersion,
        architecture: manifest.architecture,
        fileCount: expected.size,
        appCount: apps.size,
        expandedBytes: completed,
        manifestSha256: members.get('manifest.json')?.sha256 ?? '',
        databaseValidation: 'pending',
        compatibility: { compatible: blockers.length === 0, blockers, architectureChanged: manifest.architecture !== target.architecture },
      },
    };
  } catch (error) {
    if (signal.aborted) throw new BackupRequirementError('Backup inspection cancelled. No server data has been changed.');
    if (error instanceof BackupRequirementError) throw error;
    throw invalid();
  } finally {
    await output?.close();
  }
}
