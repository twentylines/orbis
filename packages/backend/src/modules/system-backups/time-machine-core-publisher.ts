import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { HostCoreCapturePublicationStatus } from '../host-updates/host-core-capture-publication-client';
import type { CoreCapturePreparation } from './time-machine-core-source-hold';
import { privateBackupDirectory } from './backup-files';

type Binding = Pick<CoreCapturePreparation, 'id' | 'preparationSha256' | 'sourceSha256' | 'pointReservationSha256' | 'controller'>;
type Ready = Extract<HostCoreCapturePublicationStatus, { state: 'verified' }>;
type Stat = Awaited<ReturnType<FileHandle['stat']>>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => new Error('The snapshot publisher needs recovery before Orbis can continue.');
const sha = (value: unknown) => createHash('sha256').update(canonicalPublicationJson(value)).digest('hex');
const same = (a: Stat, b: Stat, file = false) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', ...(file ? ['nlink', 'size', 'mtimeMs', 'ctimeMs'] : [])].every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );
function directory(dataDir: string, id: string) {
  if (!uuid.test(id)) throw fail();
  return path.join(dataDir, 'backups/time-machine/core-capture', id);
}
async function checkDirectory(dir: string) {
  const stat = await fs.lstat(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await fs.realpath(dir)) !== dir
  )
    throw fail();
  return stat;
}
async function read(dir: string, name: string) {
  let parent: Stat;
  try {
    parent = await checkDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 8192)
      throw fail();
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || !same(stat, await handle.stat(), true) || !same(stat, await fs.lstat(path.join(dir, name)), true)) throw fail();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (canonicalPublicationJson(value) !== bytes.toString('utf8') || !same(parent, await checkDirectory(dir))) throw fail();
    return value;
  } finally {
    await handle.close();
  }
}
async function persist(dir: string, name: string, value: object, signal: AbortSignal) {
  signal.throwIfAborted();
  await privateBackupDirectory(dir);
  const parent = await checkDirectory(dir);
  const temporary = path.join(dir, `.${name}-${randomUUID()}.partial`);
  const output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const owned = await output.stat();
  try {
    await output.writeFile(canonicalPublicationJson(value));
    await output.sync();
    signal.throwIfAborted();
    if (!same(parent, await checkDirectory(dir)) || !same(owned, await fs.lstat(temporary))) throw fail();
    try {
      await fs.link(temporary, path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await output.close();
    const current = await fs.lstat(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (current && same(owned, current)) await fs.unlink(temporary);
  }
  const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  if (!same(parent, await checkDirectory(dir)) || canonicalPublicationJson(await read(dir, name)) !== canonicalPublicationJson(value)) throw fail();
}
function publisher(binding: Binding) {
  return {
    schema: 'orbis.core-capture-publisher.v1',
    publisher: 'sentinel.v1',
    id: binding.id,
    preparationSha256: binding.preparationSha256,
    sourceSha256: binding.sourceSha256,
    pointReservationSha256: binding.pointReservationSha256,
    controller: binding.controller,
  };
}
export async function rememberCoreCapturePublisher(dataDir: string, binding: Binding, signal: AbortSignal) {
  await persist(directory(dataDir, binding.id), 'publisher.json', publisher(binding), signal);
}
export async function readCoreCapturePublisher(dataDir: string, binding: Binding): Promise<'sentinel.v1' | undefined> {
  const value = await read(directory(dataDir, binding.id), 'publisher.json');
  if (value === undefined) return undefined;
  if (canonicalPublicationJson(value) !== canonicalPublicationJson(publisher(binding))) throw fail();
  return 'sentinel.v1';
}
function transfer(binding: Binding, hold: unknown, ready: Ready, name: string, stat: Stat) {
  if (
    ready.preparationSha256 !== binding.preparationSha256 ||
    ready.pointReservationSha256 !== binding.pointReservationSha256 ||
    ready.sourceHoldSha256 !== sha(hold)
  )
    throw fail();
  return {
    schema: 'orbis.core-capture-transfer.v1',
    id: binding.id,
    sourceHoldSha256: ready.sourceHoldSha256,
    publicationSha256: ready.publicationSha256,
    receiptSha256: ready.receiptSha256,
    directory: name,
    identity: ['dev', 'ino', 'mode', 'uid', 'gid'].map((key) => String(Reflect.get(stat, key))),
  };
}
export async function rememberCoreCaptureTransfer(dataDir: string, binding: Binding, hold: unknown, ready: Ready, dir: string, signal: AbortSignal) {
  const parent = directory(dataDir, binding.id);
  const name = path.basename(dir);
  if (path.dirname(dir) !== parent || !/^sentinel-transfer-[a-f0-9-]{36}$/.test(name)) throw fail();
  const stat = await checkDirectory(dir);
  await persist(parent, 'transfer.json', transfer(binding, hold, ready, name, stat), signal);
}
export async function readCoreCaptureTransfer(dataDir: string, binding: Binding, hold: unknown, ready: Ready) {
  const parent = directory(dataDir, binding.id);
  const value = await read(parent, 'transfer.json');
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('directory' in value) ||
    typeof value.directory !== 'string' ||
    !/^sentinel-transfer-[a-f0-9-]{36}$/.test(value.directory)
  )
    throw fail();
  const dir = path.join(parent, value.directory);
  const stat = await checkDirectory(dir);
  if (canonicalPublicationJson(value) !== canonicalPublicationJson(transfer(binding, hold, ready, value.directory, stat))) throw fail();
  return { directory: dir, device: stat.dev, inode: stat.ino };
}
