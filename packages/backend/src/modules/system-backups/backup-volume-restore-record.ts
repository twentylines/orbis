import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPublicationJson as canonical, parseControllerPublicationResponse } from '../host-updates/host-controller-publication';
import type { VolumeRestoreAttempt, VolumeRestoreIdentity } from './backup-docker-volume-restore';
import { BackupRequirementError } from './backup-files';
import { type FullBackupManifest, parseFullBackupManifest } from './backup-import';

const fail = () => new BackupRequirementError('Prepared app volume restoration could not be verified. No data was changed.');
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const same = (a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'ctimeMs', 'mtimeMs'] as const).every((key) => a[key] === b[key]);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function validIdentity(value: unknown): value is VolumeRestoreIdentity {
  return (
    exact(value, ['restoreId', 'nonce', 'imageId', 'manifestSha256']) &&
    typeof value.restoreId === 'string' &&
    uuid.test(value.restoreId) &&
    typeof value.nonce === 'string' &&
    uuid.test(value.nonce) &&
    typeof value.imageId === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.imageId) &&
    typeof value.manifestSha256 === 'string' &&
    hash.test(value.manifestSha256)
  );
}

type PreparedRecordOptions = {
  directory: string;
  identity: VolumeRestoreIdentity;
  parsedFullBackupManifest: FullBackupManifest;
};

/** Retains the producer's process-shared lease through a code-owned consumer operation.
 * A lease does not prove that an earlier external Docker operation has stopped.
 */
export async function withPreparedVolumeRestoreRecord<T>(
  options: PreparedRecordOptions,
  operation: (receipt: Readonly<VolumeRestoreAttempt>) => Promise<T>,
): Promise<T> {
  const directory = options.directory;
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let lease: FileHandle | undefined;
  let database: DatabaseSync | undefined;
  try {
    const parentSeal = await parent.stat();
    if (!parentSeal.isDirectory() || (parentSeal.mode & 0o7777) !== 0o700 || parentSeal.uid !== process.geteuid?.()) throw fail();
    const anchor = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : directory;
    const file = path.join(anchor, 'lease.sqlite');
    lease = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const leaseHandle = lease;
    const leaseSeal = await leaseHandle.stat();
    if (
      !leaseSeal.isFile() ||
      (leaseSeal.mode & 0o7777) !== 0o600 ||
      leaseSeal.uid !== process.geteuid?.() ||
      leaseSeal.nlink !== 1 ||
      leaseSeal.size > 65536
    )
      throw fail();
    const check = async () => {
      if (
        !same(parentSeal, await parent.stat()) ||
        !same(parentSeal, await fs.lstat(directory)) ||
        (await fs.realpath(directory)) !== directory ||
        !same(leaseSeal, await leaseHandle.stat()) ||
        !same(leaseSeal, await fs.lstat(file))
      )
        throw fail();
    };
    // Read-only SQLite still takes an exclusive process-shared lock, without creating missing storage.
    database = new DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw fail();
    await check();
    const receipt = await readPreparedVolumeRestoreRecord(options);
    const result = await operation(receipt);
    await check();
    if (!equal(receipt, await readPreparedVolumeRestoreRecord(options))) throw fail();
    return result;
  } finally {
    try {
      database?.close();
    } finally {
      try {
        await lease?.close();
      } finally {
        await parent.close();
      }
    }
  }
}
function parse(bytes: Buffer) {
  const result = parseControllerPublicationResponse(bytes);
  if (!bytes.equals(Buffer.from(canonical(result)))) throw fail();
  return result;
}

/** Validates a private worker journal only. This is not root authority, target observation, or activation approval.
 * The caller must independently authenticate the identity and bind the parsed manifest to its approved manifest digest.
 */
export async function readPreparedVolumeRestoreRecord(options: PreparedRecordOptions): Promise<Readonly<VolumeRestoreAttempt>> {
  const identity = structuredClone(options.identity);
  if (!validIdentity(identity)) throw fail();
  const manifest = parseFullBackupManifest(structuredClone(options.parsedFullBackupManifest));
  if (manifest.version !== 3 || !manifest.volumes?.length) throw fail();
  const directory = options.directory;
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const handles: { handle: FileHandle; name: string; seal: Awaited<ReturnType<FileHandle['stat']>>; bytes: Buffer }[] = [];
  try {
    const parentSeal = await parent.stat();
    const checkParent = async () => {
      const named = await fs.lstat(directory);
      if (
        !parentSeal.isDirectory() ||
        (parentSeal.mode & 0o7777) !== 0o700 ||
        parentSeal.uid !== process.geteuid?.() ||
        !named.isDirectory() ||
        named.isSymbolicLink() ||
        !same(parentSeal, await parent.stat()) ||
        !same(parentSeal, named) ||
        (await fs.realpath(directory)) !== directory
      )
        throw fail();
    };
    await checkParent();
    const anchor = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : directory;
    const read = async (name: string) => {
      const handle = await fs.open(path.join(anchor, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const seal = await handle.stat();
        if (
          !seal.isFile() ||
          (seal.mode & 0o7777) !== 0o600 ||
          seal.uid !== process.geteuid?.() ||
          seal.nlink !== 1 ||
          seal.size < 1 ||
          seal.size > 4 * 1024 * 1024
        )
          throw fail();
        const bytes = await handle.readFile();
        if (bytes.length !== seal.size || !same(seal, await handle.stat())) throw fail();
        handles.push({ handle, name, seal, bytes });
        return bytes;
      } catch (error) {
        await handle.close();
        throw error;
      }
    };
    const origin = parse(await read('origin.json'));
    if (!exact(origin, ['version', 'identity']) || origin.version !== 1 || !equal(origin.identity, identity)) throw fail();
    const current = parse(await read('current.json'));
    if (
      !exact(current, ['version', 'identity', 'generation', 'attemptSha256']) ||
      current.version !== 1 ||
      !equal(current.identity, identity) ||
      typeof current.generation !== 'string' ||
      !uuid.test(current.generation) ||
      typeof current.attemptSha256 !== 'string' ||
      !hash.test(current.attemptSha256)
    )
      throw fail();
    const bytes = await read(`${current.generation}.json`);
    if (sha(bytes) !== current.attemptSha256) throw fail();
    const attempt = parse(bytes);
    if (
      !exact(attempt, ['version', 'schema', 'identity', 'generation', 'createdAt', 'phase', 'targets']) ||
      attempt.version !== 1 ||
      attempt.schema !== 'orbis.backup-volume-restore.v1' ||
      !equal(attempt.identity, identity) ||
      attempt.generation !== current.generation ||
      !Number.isSafeInteger(attempt.createdAt) ||
      (attempt.createdAt as number) < 1 ||
      attempt.phase !== 'verified' ||
      !Array.isArray(attempt.targets) ||
      attempt.targets.length !== manifest.volumes.length
    )
      throw fail();
    const volumes = new Map(manifest.volumes.map((volume) => [volume.key, volume]));
    const seen = new Set<string>();
    const uploaders = new Set<string>();
    const ids = new Set<string>();
    for (const target of attempt.targets) {
      if (
        !exact(target, [
          'key',
          'sourceName',
          'targetName',
          'archiveSha256',
          'inventorySha256',
          'uploaderName',
          'uploaderId',
          'state',
          'volumeIdentity',
          'containerIdentity',
          'verificationSha256',
        ]) ||
        typeof target.key !== 'string' ||
        seen.has(target.key)
      )
        throw fail();
      const volume = volumes.get(target.key);
      if (
        !volume ||
        target.key !== sha(`orbis.backup-volume.v1\n${volume.sourceName}`) ||
        target.sourceName !== volume.sourceName ||
        target.targetName !== `orbis-restore-${current.generation}-${target.key}` ||
        target.archiveSha256 !== volume.archive.sha256 ||
        target.inventorySha256 !== volume.inventory.sha256 ||
        target.state !== 'ready' ||
        typeof target.uploaderName !== 'string' ||
        !target.uploaderName.startsWith('orbis-volume-restore-') ||
        !uuid.test(target.uploaderName.slice('orbis-volume-restore-'.length)) ||
        uploaders.has(target.uploaderName) ||
        typeof target.uploaderId !== 'string' ||
        !hash.test(target.uploaderId) ||
        ids.has(target.uploaderId) ||
        ![target.volumeIdentity, target.containerIdentity, target.verificationSha256].every((value) => typeof value === 'string' && hash.test(value))
      )
        throw fail();
      seen.add(target.key);
      uploaders.add(target.uploaderName);
      ids.add(target.uploaderId);
    }
    await checkParent();
    for (const entry of handles) {
      const named = await fs.lstat(path.join(anchor, entry.name));
      if (!same(entry.seal, named) || !same(entry.seal, await entry.handle.stat())) throw fail();
      const again = Buffer.alloc(entry.bytes.length);
      const { bytesRead } = await entry.handle.read(again, 0, again.length, 0);
      if (bytesRead !== again.length || !again.equals(entry.bytes) || !same(entry.seal, await entry.handle.stat())) throw fail();
    }
    await checkParent();
    return freeze(structuredClone(attempt as VolumeRestoreAttempt));
  } finally {
    await Promise.all(handles.map(({ handle }) => handle.close()));
    await parent.close();
  }
}
