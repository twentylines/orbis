import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assertBackupMaintenanceLease, type BackupMaintenanceLease } from '@/common/backup-maintenance-lease';
import { resetJournalSchema, resetTargetNames, resetTargetPath, type ResetJournal } from '../system-reset/reset-contract';
import { encryptBackupStream } from './backup-crypto';
import { assertResetExportAccess, resetExportPlanSha256, type ResetExportPlan, type SettingsExportAccess } from './settings-export-authorization';

export type ResetSafetyTarget =
  | Readonly<{ name: string; type: 'absent' | 'directory' }>
  | Readonly<{
      name: string;
      type: 'file';
      file: string;
      bytes: number;
      sha256: string;
      plaintextBytes: number;
      plaintextSha256: string;
    }>;
export type ResetSafetyTargets = Readonly<{
  version: 1;
  resetId: string;
  accounts: 'keep' | 'remove';
  users: readonly number[];
  selectionSha256: string;
  inventorySha256: string;
  targets: readonly ResetSafetyTarget[];
}>;
export type ResetSafetyTargetsOptions = {
  dataDir: string;
  journal: ResetJournal;
  plan: ResetExportPlan;
  access: SettingsExportAccess;
  lease: BackupMaintenanceLease;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
};
export class ResetSafetyTargetsError extends Error {
  constructor(readonly code: 'unsupported' | 'unsafe-source' | 'source-changed' | 'limit' | 'staging') {
    super('Reset safety preference files require local review.');
  }
}
const limits = { entries: 12_000, directories: 2048, fileBytes: 32 * 1024 ** 2, totalBytes: 32 * 1024 ** 3, depth: 32, pathBytes: 4096 };
const fail = (code: ResetSafetyTargetsError['code']): never => {
  throw new ResetSafetyTargetsError(code);
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const seal = (s: Stats) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
const safeName = (value: string) =>
  !!value &&
  value !== '.' &&
  value !== '..' &&
  Buffer.byteLength(value) <= 255 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
type Directory = { handle: FileHandle; reference: string; named: string; stat: Stats; mount: string };
type CheckedFile = { named: string; stat: Stats };

async function mountId(handle: FileHandle) {
  const content = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  if (content.length > 4096) return fail('unsafe-source');
  const matches = [...content.matchAll(/^mnt_id:\s+(\d+)$/gm)];
  if (matches.length !== 1) return fail('unsupported');
  return matches[0]?.[1] ?? fail('unsupported');
}

/** Encrypts exact reset targets only. Its inventory is evidence, never permission to erase or restore. */
export async function writeResetSafetyTargets(options: ResetSafetyTargetsOptions): Promise<ResetSafetyTargets> {
  return snapshotResetSafetyTargets(options, async (value) => value, false);
}

/** Retains source directory descriptors until preparation finishes and validates the source and ciphertext again. */
export async function withResetSafetyTargets<T>(options: ResetSafetyTargetsOptions, work: (targets: ResetSafetyTargets) => Promise<T>): Promise<T> {
  return snapshotResetSafetyTargets(options, work, true);
}

async function snapshotResetSafetyTargets<T>(
  options: ResetSafetyTargetsOptions,
  work: (targets: ResetSafetyTargets) => Promise<T>,
  recheckAfter: boolean,
): Promise<T> {
  const journal = resetJournalSchema.assert(structuredClone(options.journal));
  // Durable callers must also prove this is pre-erase state, rather than relabeling interrupted work.
  if (journal.phase !== 'prepared') fail('unsafe-source');
  const plan = structuredClone(options.plan);
  const selectionSha256 = resetExportPlanSha256(plan);
  const users = [...journal.users].sort((a, b) => a - b);
  if (
    journal.id !== plan.resetId ||
    journal.accounts !== plan.accounts ||
    JSON.stringify(users) !== JSON.stringify([...plan.users].sort((a, b) => a - b))
  )
    fail('unsafe-source');
  const recheck = async () => {
    options.signal.throwIfAborted();
    assertBackupMaintenanceLease(options.lease);
    await assertResetExportAccess(options.access, plan);
    for (const ownerId of users) {
      const full = plan.exports.filter(
        (item) =>
          item.ownerId === ownerId && item.selection.settings && item.selection.dashboard && item.selection.wallpapers && item.selection.themes,
      );
      if (full.length !== 1) fail('unsafe-source');
    }
    assertBackupMaintenanceLease(options.lease);
    options.signal.throwIfAborted();
  };
  await recheck();
  if (process.platform !== 'linux' || process.getuid?.() === undefined) fail('unsupported');
  if (typeof options.passphrase !== 'string' || options.passphrase.length < 8 || !options.passphrase.trim() || options.passphrase.length > 1024)
    fail('staging');
  const { dataDir, directory, signal } = options;
  for (const value of [dataDir, directory]) {
    if (!path.isAbsolute(value) || path.resolve(value) !== value || (await fs.realpath(value)) !== value) fail('staging');
  }
  const targetNames = resetTargetNames(journal);
  if (inside(directory, dataDir) || targetNames.some((name) => inside(resetTargetPath(dataDir, name), directory))) fail('staging');
  const directories = new Map<string, Directory>();
  const identities = new Set<string>();
  const absent: string[] = [];
  const files: CheckedFile[] = [];
  const outputs: CheckedFile[] = [];
  const targets: ResetSafetyTarget[] = [];
  let totalBytes = 0;
  let staging: Directory | undefined;
  let complete = false;
  let failure: unknown;
  const validate = (stat: Stats, privateMode: boolean) => {
    if (stat.uid !== process.getuid?.() || stat.isSymbolicLink() || stat.mode & (privateMode ? 0o077 : 0o022)) fail('unsafe-source');
  };
  const current = async (entry: Directory) => {
    const now = await fs.lstat(entry.named).catch(() => null);
    if (!now || seal(now) !== seal(entry.stat) || seal(await entry.handle.stat()) !== seal(entry.stat)) fail('source-changed');
  };
  const openDirectory = async (named: string, privateMode: boolean, parent?: Directory): Promise<Directory> => {
    await recheck();
    const existing = directories.get(named);
    if (existing) return existing;
    if (directories.size >= limits.directories) fail('limit');
    const before = await fs.lstat(named);
    validate(before, privateMode);
    if (!before.isDirectory()) fail('unsafe-source');
    const handle = await fs.open(named, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      validate(stat, privateMode);
      if (seal(before) !== seal(stat)) fail('source-changed');
      const reference = `/proc/self/fd/${handle.fd}`;
      if (seal(await fs.stat(reference)) !== seal(stat)) fail('unsupported');
      const mount = await mountId(handle);
      // State is an explicit independently mounted source root. Deeper binds may alias excluded data.
      const structuralState = parent?.named === dataDir && named === `${parent.reference}/state`;
      if (parent && mount !== parent.mount && !structuralState) fail('unsafe-source');
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) fail('unsafe-source');
      identities.add(identity);
      const result = { handle, reference, named, stat, mount };
      directories.set(named, result);
      return result;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const stageCurrent = async () => {
    if (!staging) return fail('staging');
    const named = await fs.lstat(directory).catch(() => null);
    const opened = await staging.handle.stat();
    if (
      !named ||
      !named.isDirectory() ||
      named.dev !== staging.stat.dev ||
      named.ino !== staging.stat.ino ||
      named.mode !== staging.stat.mode ||
      named.uid !== staging.stat.uid ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      (await fs.realpath(directory)) !== directory
    )
      fail('staging');
  };
  const add = (entry: ResetSafetyTarget) => {
    if (targets.length >= limits.entries || Buffer.byteLength(entry.name) > limits.pathBytes) fail('limit');
    targets.push(Object.freeze(entry));
  };
  const snapshot = async (name: string, parent: Directory, child: string, directoryExpected: boolean, depth = 0): Promise<void> => {
    await recheck();
    await current(parent);
    if (!safeName(child)) fail('unsafe-source');
    if (depth > limits.depth) fail('limit');
    const named = `${parent.reference}/${child}`;
    const before = await fs.lstat(named).catch((error: unknown) => {
      if (!missing(error)) throw error;
      absent.push(named);
      return null;
    });
    if (!before) {
      add({ name, type: 'absent' });
      return;
    }
    validate(before, true);
    if (directoryExpected !== before.isDirectory()) fail('unsafe-source');
    if (before.isDirectory()) {
      const opened = await openDirectory(named, true, parent);
      add({ name, type: 'directory' });
      const children: string[] = [];
      // Bounded iteration avoids materializing an unbounded hostile directory.
      const iterator = await fs.opendir(opened.reference);
      for await (const entry of iterator) {
        if (children.length + targets.length >= limits.entries || !safeName(entry.name)) fail('limit');
        children.push(entry.name);
      }
      for (const value of children.sort()) {
        const info = await fs.lstat(`${opened.reference}/${value}`);
        await snapshot(`${name}/${value}`, opened, value, info.isDirectory(), depth + 1);
      }
      await current(opened);
      return;
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > limits.fileBytes || !Number.isSafeInteger(before.size)) fail('unsafe-source');
    totalBytes += before.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.totalBytes) fail('limit');
    const identity = `${before.dev}:${before.ino}`;
    if (identities.has(identity)) fail('unsafe-source');
    identities.add(identity);
    const handle = await fs.open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (seal(await handle.stat()) !== seal(before) || (await mountId(handle)) !== parent.mount) fail('source-changed');
      await recheck();
      await current(parent);
      await stageCurrent();
      const digest = createHash('sha256');
      const source = Readable.from(
        (async function* () {
          const buffer = Buffer.alloc(256 * 1024);
          try {
            let position = 0;
            while (position < before.size) {
              await recheck();
              await current(parent);
              const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
              if (!read.bytesRead) fail('source-changed');
              const bytes = buffer.subarray(0, read.bytesRead);
              digest.update(bytes);
              position += read.bytesRead;
              // Readable may prefetch another iteration before the cipher consumes this chunk.
              yield Buffer.from(bytes);
            }
          } finally {
            buffer.fill(0);
          }
        })(),
      );
      const file = path.join(directory, `${randomUUID()}.orbis`);
      const encrypted = await encryptBackupStream({ source, plaintextBytes: before.size, destination: file, passphrase: options.passphrase, signal });
      await stageCurrent();
      const output = await fs.lstat(file);
      outputs.push({ named: `${staging?.reference}/${path.basename(file)}`, stat: output });
      if (!output.isFile() || output.nlink !== 1 || output.mode & 0o077 || output.uid !== process.getuid?.() || output.size !== encrypted.bytes)
        fail('staging');
      if (seal(await handle.stat()) !== seal(before) || seal(await fs.lstat(named)) !== seal(before)) fail('source-changed');
      files.push({ named, stat: before });
      add({
        name,
        type: 'file',
        file,
        bytes: encrypted.bytes,
        sha256: encrypted.sha256,
        plaintextBytes: before.size,
        plaintextSha256: digest.digest('hex'),
      });
    } finally {
      await handle.close();
    }
  };
  const cleanup = async () => {
    try {
      if (!staging) return;
      await stageCurrent();
      for (const output of outputs) {
        const now = await fs.lstat(output.named).catch(() => null);
        if (!now || seal(now) !== seal(output.stat)) fail('staging');
        await fs.unlink(output.named);
      }
      await staging.handle.sync();
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'Reset safety snapshot and staging require local review.');
      throw error;
    }
  };
  const verifySnapshot = async () => {
    await recheck();
    for (const opened of directories.values()) await current(opened);
    for (const entry of files) if (seal(await fs.lstat(entry.named)) !== seal(entry.stat)) fail('source-changed');
    for (const named of absent) {
      const found = await fs.lstat(named).then(
        () => true,
        (error: unknown) => {
          if (!missing(error)) throw error;
          return false;
        },
      );
      if (found) fail('source-changed');
    }
    await stageCurrent();
    const stage = staging ?? fail('staging');
    for (const output of outputs) if (seal(await fs.lstat(output.named)) !== seal(output.stat)) fail('staging');
    const expectedOutputs = new Set(outputs.map((entry) => path.basename(entry.named)));
    const staged = await fs.opendir(stage.reference);
    for await (const entry of staged) if (!expectedOutputs.delete(entry.name)) fail('staging');
    if (expectedOutputs.size) fail('staging');
  };
  try {
    staging = await openDirectory(directory, true);
    const iterator = await fs.opendir(staging.reference);
    for await (const _entry of iterator) fail('staging');
    // Staging is mutable; source inventory sealing must not include its directory timestamps.
    directories.delete(directory);
    const root = await openDirectory(dataDir, false);
    for (const name of targetNames) {
      const physical = path.relative(dataDir, resetTargetPath(dataDir, name)).split(path.sep);
      let parent = root;
      let absentParent = false;
      for (const child of physical.slice(0, -1)) {
        await recheck();
        if (!safeName(child)) fail('unsafe-source');
        const named = `${parent.reference}/${child}`;
        const present = await fs.lstat(named).catch((error: unknown) => {
          if (!missing(error)) throw error;
          absent.push(named);
          return null;
        });
        if (!present) {
          absentParent = true;
          break;
        }
        parent = await openDirectory(named, child !== 'state', parent);
      }
      if (absentParent) add({ name, type: 'absent' });
      else await snapshot(name, parent, physical.at(-1) ?? fail('unsafe-source'), name.startsWith('theme-packs/'));
    }
    await verifySnapshot();
    const ordered = targets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const inventory = ordered.map((entry) =>
      entry.type === 'file'
        ? { name: entry.name, type: entry.type, plaintextBytes: entry.plaintextBytes, plaintextSha256: entry.plaintextSha256 }
        : { name: entry.name, type: entry.type },
    );
    const result: ResetSafetyTargets = Object.freeze({
      version: 1,
      resetId: journal.id,
      accounts: journal.accounts,
      users: Object.freeze(users),
      selectionSha256,
      inventorySha256: createHash('sha256').update('orbis-reset-safety-targets-v1\n').update(JSON.stringify(inventory)).digest('hex'),
      targets: Object.freeze(ordered),
    });
    const value = await work(result);
    if (recheckAfter) await verifySnapshot();
    complete = true;
    return value;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (!complete) await cleanup();
    } finally {
      const opened = new Set([...directories.values(), ...(staging ? [staging] : [])]);
      await Promise.all([...opened].map((entry) => entry.handle.close()));
    }
  }
}
