import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { backupMetadataBytes } from './backup-crypto';
import { privateBackupDirectory } from './backup-files';

const maximumFile = 32 * 1024 ** 2;
const id = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const savedFile = type({ bytes: `0 <= number.integer <= ${maximumFile}`, sha256: hash, mode: '0 <= number.integer <= 511' })
  .onUndeclaredKey('reject')
  .or('null');
const capture = type({
  pointId: id,
  createdAt: '0 < number.integer <= 9007199254740991',
  archiveSha256: hash,
  metadataSha256: hash,
  existed: 'boolean',
}).onUndeclaredKey('reject');
const stateSchema = type({
  version: '1',
  id,
  ownerId: '0 < number.integer <= 9007199254740991',
  importId: id,
  reviewId: id,
  archiveSha256: hash,
  createdAt: '0 < number.integer <= 9007199254740991',
  phase: "'preparing' | 'prepared' | 'applying' | 'complete' | 'rolling-back' | 'rolled-back' | 'recovery'",
  files: type({ relative: 'string', before: savedFile, after: savedFile }).onUndeclaredKey('reject').array().atMostLength(40),
  captures: capture.array().atMostLength(16),
  'runtimeBefore?': type({ bytes: '1 <= number.integer <= 1048576', sha256: hash }).onUndeclaredKey('reject'),
}).onDeepUndeclaredKey('reject');
export type SettingsTransactionState = typeof stateSchema.infer;
export type SettingsCaptureIntent = typeof capture.infer;
const fail = () => new Error('The settings restore needs recovery. Saved backups and Docker apps were kept.');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const same = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const terminal = (phase: SettingsTransactionState['phase']) => phase === 'complete' || phase === 'rolled-back';

function targetAllowed(relative: string, ownerId: number) {
  return (
    relative === 'settings.json' ||
    relative === `desktop/${ownerId}.json` ||
    relative === `theme-settings/${ownerId}.json` ||
    relative === `wallpapers/${ownerId}.image` ||
    relative === `wallpapers/${ownerId}.image.saved` ||
    relative === `theme-packs/${ownerId}/registry.json` ||
    new RegExp(`^theme-packs/${ownerId}/[a-z][a-z0-9-]{2,47}/(?:0|[1-9]\\d{0,3})\\.(?:0|[1-9]\\d{0,3})\\.(?:0|[1-9]\\d{0,3})/[a-f0-9]{64}$`).test(
      relative,
    )
  );
}
function validate(value: unknown) {
  const state = stateSchema.assert(value);
  if (
    (!state.files.length && !state.captures.length && !['preparing', 'rolling-back', 'rolled-back', 'recovery'].includes(state.phase)) ||
    new Set(state.files.map((file) => file.relative)).size !== state.files.length ||
    new Set(state.captures.map((point) => point.pointId)).size !== state.captures.length ||
    state.files.some((file) => !targetAllowed(file.relative, state.ownerId) || [file.before, file.after].some((item) => item && item.mode & 0o022))
  )
    throw fail();
  return state;
}
async function sync(directory: string) {
  const file = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readPrivate(filename: string, maximum: number) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o077 || before.size > maximum) throw fail();
    const data = await file.readFile();
    if (data.length !== before.size || !same(before, await file.stat()) || !same(before, await fs.lstat(filename))) throw fail();
    return data;
  } finally {
    await file.close();
  }
}
async function atomic(filename: string, data: Buffer, replace: boolean) {
  const directory = path.dirname(filename);
  await privateBackupDirectory(directory);
  const before = await fs.lstat(directory);
  const temporary = path.join(directory, `.settings-${randomUUID()}.partial`);
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await privateBackupDirectory(directory);
    const current = await fs.lstat(directory);
    if (current.dev !== before.dev || current.ino !== before.ino) throw fail();
    if (replace) await fs.rename(temporary, filename);
    else await fs.link(temporary, filename);
    await fs.unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
    await sync(directory);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
async function recoveryKey(store: string, create: boolean) {
  const filename = path.join(store, 'recovery.key');
  try {
    return await readPrivate(filename, 32);
  } catch (error) {
    if (!create || !missing(error)) throw error;
    const key = randomBytes(32);
    try {
      await atomic(filename, key, false).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    } finally {
      key.fill(0);
    }
    return readPrivate(filename, 32);
  }
}

/** Caller retains the process-shared restore lease and exclusive maintenance throughout preparation, mutation and recovery. */
export class SettingsBackupTransaction {
  private constructor(
    private readonly dataDir: string,
    readonly directory: string,
    private current: SettingsTransactionState,
  ) {}
  get state(): Readonly<SettingsTransactionState> {
    return structuredClone(this.current);
  }
  static async active(dataDir: string, store = path.join(dataDir, 'backups', 'settings-restores')) {
    let pointer: unknown;
    try {
      const details = await fs.lstat(store);
      if (!details.isDirectory() || details.isSymbolicLink() || details.mode & 0o077 || details.uid !== process.getuid?.()) throw fail();
      await privateBackupDirectory(store);
      pointer = JSON.parse((await readPrivate(path.join(store, 'active.json'), 1024)).toString('utf8'));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const parsed = type({ version: '1', id }).onUndeclaredKey('reject').assert(pointer);
    const directory = path.join(store, parsed.id);
    await privateBackupDirectory(directory);
    const state = validate(JSON.parse((await readPrivate(path.join(directory, 'journal.json'), 64 * 1024)).toString('utf8')));
    if (state.id !== parsed.id) throw fail();
    return new SettingsBackupTransaction(dataDir, directory, state);
  }
  static async reserve(options: { dataDir: string; store?: string; ownerId: number; importId: string; reviewId: string; archiveSha256: string }) {
    const store = options.store ?? path.join(options.dataDir, 'backups', 'settings-restores');
    const previous = await SettingsBackupTransaction.active(options.dataDir, store);
    if (previous && !terminal(previous.state.phase)) throw fail();
    const state = validate({
      version: 1,
      id: randomUUID(),
      ownerId: options.ownerId,
      importId: options.importId,
      reviewId: options.reviewId,
      archiveSha256: options.archiveSha256,
      createdAt: Date.now(),
      phase: 'preparing',
      files: [],
      captures: [],
    });
    await privateBackupDirectory(store);
    const directory = path.join(store, state.id);
    await fs.mkdir(directory, { mode: 0o700 });
    const transaction = new SettingsBackupTransaction(options.dataDir, directory, state);
    await transaction.save('preparing');
    await atomic(path.join(store, 'active.json'), Buffer.from(JSON.stringify({ version: 1, id: state.id })), true);
    return transaction;
  }
  static async prepare(options: {
    dataDir: string;
    store?: string;
    ownerId: number;
    importId: string;
    reviewId: string;
    archiveSha256: string;
    files: { relative: string; data: Buffer | null }[];
    captures?: SettingsCaptureIntent[];
    runtimeBefore?: Buffer;
    reservedId?: string;
    signal: AbortSignal;
  }) {
    const store = options.store ?? path.join(options.dataDir, 'backups', 'settings-restores');
    const prior = await SettingsBackupTransaction.active(options.dataDir, store);
    const reserved =
      prior &&
      prior.state.id === options.reservedId &&
      prior.state.phase === 'preparing' &&
      prior.state.ownerId === options.ownerId &&
      prior.state.importId === options.importId &&
      prior.state.reviewId === options.reviewId &&
      prior.state.archiveSha256 === options.archiveSha256;
    if (prior && !terminal(prior.state.phase) && !reserved) throw fail();
    if (options.reservedId && !reserved) throw fail();
    const state = validate({
      version: 1,
      id: reserved ? prior.state.id : randomUUID(),
      ownerId: options.ownerId,
      importId: options.importId,
      reviewId: options.reviewId,
      archiveSha256: options.archiveSha256,
      createdAt: Date.now(),
      phase: 'prepared',
      files: options.files.map(({ relative, data }) => ({
        relative,
        before: null,
        after: data === null ? null : { bytes: data.length, sha256: sha(data), mode: 0o600 },
      })),
      captures: options.captures ?? [],
      ...(options.runtimeBefore ? { runtimeBefore: { bytes: options.runtimeBefore.length, sha256: sha(options.runtimeBefore) } } : {}),
    });
    options.signal.throwIfAborted();
    await privateBackupDirectory(store);
    const directory = path.join(store, state.id);
    if (reserved) await privateBackupDirectory(directory);
    else await fs.mkdir(directory, { mode: 0o700 });
    const transaction = new SettingsBackupTransaction(options.dataDir, directory, state);
    const key = await recoveryKey(store, true);
    try {
      if (key.length !== 32) throw fail();
      if (options.runtimeBefore)
        await atomic(
          path.join(directory, 'runtime-before.orbis'),
          await backupMetadataBytes(options.runtimeBefore, key.toString('base64url'), false),
          false,
        );
      for (const [index, entry] of options.files.entries()) {
        options.signal.throwIfAborted();
        const before = await transaction.readTarget(entry.relative);
        try {
          const record = state.files[index];
          if (!record) throw fail();
          if (before) {
            record.before = { bytes: before.data.length, sha256: sha(before.data), mode: before.mode };
            await atomic(
              path.join(directory, `before-${index}.orbis`),
              await backupMetadataBytes(before.data, key.toString('base64url'), false, maximumFile),
              false,
            );
          }
          if (entry.data !== null)
            await atomic(
              path.join(directory, `after-${index}.orbis`),
              await backupMetadataBytes(entry.data, key.toString('base64url'), false, maximumFile),
              false,
            );
        } finally {
          before?.data.fill(0);
        }
      }
      await transaction.save('prepared');
      await atomic(path.join(store, 'active.json'), Buffer.from(JSON.stringify({ version: 1, id: state.id })), true);
      return transaction;
    } finally {
      key.fill(0);
    }
  }
  private async save(phase: SettingsTransactionState['phase']) {
    const next = validate({ ...this.current, phase });
    await atomic(path.join(this.directory, 'journal.json'), Buffer.from(JSON.stringify(next)), true);
    this.current = next;
  }
  private async parent(relative: string, create = false) {
    if (!targetAllowed(relative, this.current.ownerId)) throw fail();
    const base = path.resolve(this.dataDir);
    let directory = base;
    const seals: { directory: string; stat: Awaited<ReturnType<typeof fs.stat>> }[] = [];
    for (const part of ['', 'state', ...relative.split('/').slice(0, -1)]) {
      if (part) directory = path.join(directory, part);
      if (create && directory !== base) {
        await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022 ||
        (await fs.realpath(directory)) !== directory
      )
        throw fail();
      seals.push({ directory, stat });
    }
    return {
      directory,
      assert: async () => {
        for (const seal of seals) {
          const current = await fs.lstat(seal.directory);
          if (
            current.dev !== seal.stat.dev ||
            current.ino !== seal.stat.ino ||
            current.mode !== seal.stat.mode ||
            current.uid !== seal.stat.uid ||
            current.isSymbolicLink()
          )
            throw fail();
        }
      },
    };
  }
  private async readTarget(relative: string): Promise<{ data: Buffer; mode: number } | null> {
    let parent: Awaited<ReturnType<SettingsBackupTransaction['parent']>>;
    try {
      parent = await this.parent(relative);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const filename = path.join(parent.directory, path.basename(relative));
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) {
        await parent.assert();
        return null;
      }
      throw error;
    }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.mode & 0o022 || before.size > maximumFile)
        throw fail();
      const data = await file.readFile();
      await parent.assert();
      if (!same(before, await file.stat()) || !same(before, await fs.lstat(filename)) || data.length !== before.size) throw fail();
      return { data, mode: before.mode & 0o777 };
    } finally {
      await file.close();
    }
  }
  private async restoreFile(index: number, direction: 'before' | 'after', signal: AbortSignal) {
    signal.throwIfAborted();
    const entry = this.current.files[index];
    if (!entry) throw fail();
    await this.clearTemporary(index);
    const current = await this.readTarget(entry.relative);
    const equal = (expected: typeof entry.before) =>
      current === null
        ? expected === null
        : expected !== null && expected.bytes === current.data.length && expected.sha256 === sha(current.data) && expected.mode === current.mode;
    try {
      if (equal(entry[direction])) return;
      if (!equal(entry[direction === 'after' ? 'before' : 'after'])) throw fail();
    } finally {
      current?.data.fill(0);
    }
    const desired = entry[direction];
    const parent = await this.parent(entry.relative, desired !== null);
    const filename = path.join(parent.directory, path.basename(entry.relative));
    const assertUnchanged = async () => {
      const latest = await this.readTarget(entry.relative);
      const expected = entry[direction === 'after' ? 'before' : 'after'];
      try {
        if (
          latest === null
            ? expected !== null
            : expected === null || expected.bytes !== latest.data.length || expected.sha256 !== sha(latest.data) || expected.mode !== latest.mode
        )
          throw fail();
      } finally {
        latest?.data.fill(0);
      }
    };
    if (desired === null) {
      await parent.assert();
      await assertUnchanged();
      await fs.unlink(filename);
      await sync(parent.directory);
      await parent.assert();
      return;
    }
    const key = await recoveryKey(path.dirname(this.directory), false);
    let data: Buffer | undefined;
    try {
      if (key.length !== 32) throw fail();
      data = await backupMetadataBytes(
        await readPrivate(path.join(this.directory, `${direction}-${index}.orbis`), maximumFile + 52),
        key.toString('base64url'),
        true,
        maximumFile,
      );
      if (data.length !== desired.bytes || sha(data) !== desired.sha256) throw fail();
      const temporary = path.join(parent.directory, `.orbis-settings-${this.current.id}-${index}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.chmod(desired.mode);
        await file.sync();
      } finally {
        await file.close();
      }
      await parent.assert();
      // Maintenance excludes Orbis writers; detect independent edits made during decryption and staging.
      await assertUnchanged();
      await fs.rename(temporary, filename);
      await sync(parent.directory);
      await parent.assert();
    } finally {
      key.fill(0);
      data?.fill(0);
    }
  }
  private async clearTemporary(index: number) {
    const entry = this.current.files[index];
    if (!entry) throw fail();
    let parent: Awaited<ReturnType<SettingsBackupTransaction['parent']>>;
    try {
      parent = await this.parent(entry.relative);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const temporary = path.join(parent.directory, `.orbis-settings-${this.current.id}-${index}.tmp`);
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.size > maximumFile) throw fail();
      const bytes = await file.readFile();
      try {
        let verified = [entry.before, entry.after].some(
          (value) => value && value.bytes === bytes.length && value.sha256 === sha(bytes) && value.mode === (stat.mode & 0o777),
        );
        if (!verified && (stat.mode & 0o777) === 0o600) {
          for (const direction of ['before', 'after'] as const) {
            const expected = entry[direction];
            if (!expected || bytes.length >= expected.bytes) continue;
            const key = await recoveryKey(path.dirname(this.directory), false);
            let full: Buffer | undefined;
            try {
              if (key.length !== 32) throw fail();
              full = await backupMetadataBytes(
                await readPrivate(path.join(this.directory, `${direction}-${index}.orbis`), maximumFile + 52),
                key.toString('base64url'),
                true,
                maximumFile,
              );
              if (full.length !== expected.bytes || sha(full) !== expected.sha256) throw fail();
              if (bytes.equals(full.subarray(0, bytes.length))) verified = true;
            } finally {
              key.fill(0);
              full?.fill(0);
            }
            if (verified) break;
          }
        }
        if (!verified) throw fail();
      } finally {
        bytes.fill(0);
      }
      await parent.assert();
      if (!same(stat, await file.stat()) || !same(stat, await fs.lstat(temporary))) throw fail();
      await fs.unlink(temporary);
      await sync(parent.directory);
    } finally {
      await file.close();
    }
  }
  async applyFiles(signal: AbortSignal) {
    if (this.current.phase !== 'prepared') throw fail();
    await this.save('applying');
    for (let index = 0; index < this.current.files.length; index++) await this.restoreFile(index, 'after', signal);
  }
  async complete() {
    if (this.current.phase !== 'applying') throw fail();
    await this.save('complete');
  }
  async runtimeBefore(): Promise<Buffer | null> {
    const expected = this.current.runtimeBefore;
    if (!expected) return null;
    const key = await recoveryKey(path.dirname(this.directory), false);
    try {
      if (key.length !== 32) throw fail();
      const bytes = await backupMetadataBytes(
        await readPrivate(path.join(this.directory, 'runtime-before.orbis'), 1048576 + 52),
        key.toString('base64url'),
        true,
      );
      if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) {
        bytes.fill(0);
        throw fail();
      }
      return bytes;
    } finally {
      key.fill(0);
    }
  }
  async rollback(signal: AbortSignal, removeCapture?: (intent: SettingsCaptureIntent) => Promise<void>, beforeFinish?: () => Promise<void>) {
    if (this.current.phase === 'complete' || this.current.phase === 'rolled-back') throw fail();
    await this.save('rolling-back');
    try {
      for (const intent of this.current.captures.filter((value) => !value.existed).reverse()) {
        if (!removeCapture) throw fail();
        await removeCapture(intent);
      }
      for (let index = this.current.files.length - 1; index >= 0; index--) await this.restoreFile(index, 'before', signal);
      await beforeFinish?.();
      await this.save('rolled-back');
    } catch (error) {
      await this.save('recovery').catch(() => undefined);
      throw error;
    }
  }
}
