import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import type { ArchiveService } from '@/core/archive/archive.service';
import type { AppStorageObservation, AppStorageWitness } from '../host-updates/app-storage-observation';
import type { AppMigrationImage } from '../docker/app-migration-images';
import { appMigrationLedgerSchema } from '../apps/app-migration-ledger';
import { validateArchiveLinks, validateBackupTree } from './backup-links';
import { requireMigrationAppStopped } from '../docker/app-migration-engine';

export const migrationFailure = () => new Error('The app migration requires verified recovery. Keep its operation record and any checkpoint.');
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const imageId = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const migrationId = type('string').narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value));
const pinSchema = type({
  migrationId,
  sourceSha256: hash,
  definitionSha256: hash,
  imageId,
  reference: 'string > 0 & string <= 1024',
  platform: "'linux/amd64' | 'linux/amd64/v1' | 'linux/arm64' | 'linux/arm64/v8'",
}).onUndeclaredKey('reject');
const originalSchema = type({ id: hash, imageId, service: 'string > 0 & string <= 128' }).onUndeclaredKey('reject');
export const migrationOperationSchema = type({
  version: '1',
  requestId: uuid,
  stageId: uuid,
  appUrn: type('string').narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,127}:[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)),
  appId: 'number.integer > 0 & number <= 2147483647',
  // Immutable app-row creation time, not the time of this request.
  createdAt: '0 <= number.integer <= 2147483647',
  fromVersion: '0 <= number.integer <= 2147483647',
  toVersion: '0 <= number.integer <= 2147483647',
  previousLedger: appMigrationLedgerSchema,
  images: pinSchema.array().atLeastLength(1).atMostLength(300),
  originalContainers: originalSchema.array().atMostLength(256),
}).onUndeclaredKey('reject');
export type MigrationOperation = typeof migrationOperationSchema.infer;
const runnerSchema = type({
  migrationId,
  nonce: type('string').narrow((value) => /^[a-f0-9]{32}$/.test(value)),
  name: type('string').narrow((value) => /^orbis-migration-[a-f0-9]{32}-[a-f0-9]{12}$/.test(value)),
  specSha256: hash,
  containerId: hash.or('null'),
  phase: "'create-intent' | 'created' | 'start-intent' | 'terminal' | 'removed'",
  exitCode: type('0 <= number.integer <= 255').or('null'),
  terminalSha256: hash.or('null'),
}).onUndeclaredKey('reject');
export type MigrationRunnerRecord = typeof runnerSchema.infer;
const checkpointSchema = type({
  file: "'before.tar.gz'",
  bytes: 'number.integer > 0 & number <= 9007199254740991',
  sha256: hash,
  fileIdentity: 'string > 0 & string <= 512',
}).onUndeclaredKey('reject');
const stateSchema = type({
  schema: "'orbis.app-migration-journal.v1'",
  revision: '0 <= number.integer <= 2147483647',
  operation: migrationOperationSchema,
  storageSha256: hash,
  sourceController: type({ id: hash, imageId, startedAt: 'string > 0 & string <= 128', definitionSha256: hash }).onUndeclaredKey('reject'),
  phase:
    "'allocated' | 'capturing' | 'ready' | 'running' | 'migrations-complete' | 'activation-attempted' | 'recovery-required' | 'restoring' | 'restored' | 'commit-intent' | 'committed'",
  targetWritesPossible: 'boolean',
  commitAttempted: 'boolean',
  commitReceiptSha256: hash.or('null'),
  checkpoint: checkpointSchema.or('null'),
  runners: runnerSchema.array().atMostLength(300),
  restores: type({ id: uuid, phase: "'intent' | 'staged' | 'promoting' | 'committed' | 'abandoned'" })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(16),
}).onUndeclaredKey('reject');
export type MigrationJournalState = typeof stateSchema.infer;
const live = new Set<string>();
export const migrationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const migrationStorageHash = (value: Readonly<AppStorageObservation>) =>
  migrationHash({
    appUrn: value.appUrn,
    daemonSha256: value.daemonSha256,
    dockerSocket: value.dockerSocket,
    hostBasePath: value.hostBasePath,
    hostPath: value.hostPath,
    containerPath: value.containerPath,
    directory: value.directory,
    mountTablesSha256: value.mountTablesSha256,
  });
const fileIdentity = (info: BigIntStats) =>
  [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':');
const directoryIdentity = (info: BigIntStats) => [info.dev, info.ino, info.uid, info.gid, info.mode].join(':');
const canonicalPath = (value: string) =>
  path.isAbsolute(value) && path.resolve(value) === value && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/.test(value);
const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

async function privateDirectory(directory: string, create: boolean) {
  if (!canonicalPath(directory)) throw migrationFailure();
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (create) await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await fs.lstat(current, { bigint: true });
    if (!info.isDirectory()) throw migrationFailure();
    if (current === directory && (info.uid !== BigInt(process.geteuid?.() ?? -1) || info.mode & 0o077n)) throw migrationFailure();
  }
}

async function privateFile(file: string, maximum: number) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.geteuid?.() ?? -1) ||
      before.nlink !== 1n ||
      before.mode & 0o077n ||
      before.size > BigInt(maximum)
    )
      throw migrationFailure();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (
      BigInt(length) !== before.size ||
      fileIdentity(before) !== fileIdentity(await handle.stat({ bigint: true })) ||
      fileIdentity(before) !== fileIdentity(await fs.lstat(file, { bigint: true }))
    )
      throw migrationFailure();
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function validate(raw: unknown): MigrationJournalState {
  const state = stateSchema.assert(raw);
  const planned = state.operation.images.map((entry) => entry.migrationId);
  if (new Set(planned).size !== planned.length || planned.some((id, index) => index > 0 && id <= (planned[index - 1] ?? '')))
    throw migrationFailure();
  if (new Set(state.operation.originalContainers.map(({ id }) => id)).size !== state.operation.originalContainers.length) throw migrationFailure();
  if (planned.some((id) => state.operation.previousLedger.migrationIds.includes(id))) throw migrationFailure();
  if (
    state.runners.some(
      (row, index) =>
        row.migrationId !== planned[index] ||
        (row.phase === 'create-intent') !== (row.containerId === null) ||
        ['terminal', 'removed'].includes(row.phase) !== (row.exitCode !== null && row.terminalSha256 !== null) ||
        (index < state.runners.length - 1 && (!['terminal', 'removed'].includes(row.phase) || row.exitCode !== 0)),
    )
  )
    throw migrationFailure();
  if (
    (state.targetWritesPossible && !['activation-attempted', 'commit-intent', 'committed', 'recovery-required'].includes(state.phase)) ||
    (state.phase === 'activation-attempted' && !state.targetWritesPossible)
  )
    throw migrationFailure();
  if (
    (state.commitAttempted && !['commit-intent', 'committed', 'recovery-required'].includes(state.phase)) ||
    (['commit-intent', 'committed'].includes(state.phase) && !state.commitAttempted) ||
    (state.commitReceiptSha256 !== null && (!state.commitAttempted || !['committed', 'recovery-required'].includes(state.phase))) ||
    (state.phase === 'committed' && state.commitReceiptSha256 === null)
  )
    throw migrationFailure();
  if (!['allocated', 'capturing'].includes(state.phase) && !state.checkpoint) throw migrationFailure();
  if (state.phase === 'allocated' && (state.checkpoint || state.runners.length)) throw migrationFailure();
  if (
    new Set(state.restores.map(({ id }) => id)).size !== state.restores.length ||
    state.restores.some((row, index) => index < state.restores.length - 1 && row.phase !== 'abandoned') ||
    (state.restores.length > 0 && !['restoring', 'restored', 'recovery-required'].includes(state.phase)) ||
    (state.phase === 'restoring' && !state.restores.length) ||
    (state.phase === 'restored' && state.restores.at(-1)?.phase !== 'committed') ||
    (state.restores.length > 0 && state.targetWritesPossible)
  )
    throw migrationFailure();
  if (
    ['migrations-complete', 'activation-attempted', 'commit-intent', 'committed'].includes(state.phase) &&
    (state.runners.length !== planned.length || state.runners.some(({ exitCode }) => exitCode !== 0))
  )
    throw migrationFailure();
  return state;
}

/** Private durable state; no phase here authorizes an unverified restore or SQL commit. */
export class AppMigrationJournal {
  #closed = false;
  #executing = false;
  #bytes: Buffer;
  private constructor(
    readonly directory: string,
    private state: MigrationJournalState,
    private readonly identity: string,
    bytes: Buffer,
  ) {
    this.#bytes = bytes;
  }

  /** Only typed absence selects first allocation. A present partial/linked/corrupt operation is never overwritten. */
  static async operationExists(root: string, requestId: string) {
    if (!canonicalPath(root) || root.split('/').length > 128 || !uuid.allows(requestId)) throw migrationFailure();
    let current = '/';
    for (const part of root.split('/').filter(Boolean)) {
      current = path.join(current, part);
      const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return false;
      if (!info.isDirectory() || info.isSymbolicLink() || (current === root && (info.uid !== process.geteuid?.() || info.mode & 0o077)))
        throw migrationFailure();
    }
    return fs.lstat(path.join(root, requestId)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
  }

  static async create(root: string, operation: MigrationOperation, storage: AppStorageWitness) {
    const input = structuredClone(migrationOperationSchema.assert(operation));
    const directory = path.join(root, input.requestId);
    if (live.has(directory)) throw migrationFailure();
    live.add(directory);
    try {
      await privateDirectory(root, true);
      await fs.mkdir(directory, { mode: 0o700 });
      await syncDirectory(root);
      const initial = await storage.use(async (_docker, observed) => {
        if (observed.appUrn !== input.appUrn) throw migrationFailure();
        return {
          schema: 'orbis.app-migration-journal.v1' as const,
          revision: 0,
          operation: input,
          storageSha256: migrationStorageHash(observed),
          sourceController: structuredClone(observed.controller),
          phase: 'allocated' as const,
          targetWritesPossible: false,
          commitAttempted: false,
          commitReceiptSha256: null,
          checkpoint: null,
          runners: [],
          restores: [],
        };
      });
      const state = validate(initial);
      const bytes = Buffer.from(JSON.stringify(state));
      const journal = new AppMigrationJournal(directory, state, directoryIdentity(await fs.lstat(directory, { bigint: true })), bytes);
      await journal.write(bytes, true);
      return journal;
    } catch {
      live.delete(directory);
      throw migrationFailure();
    }
  }

  static async open(root: string, operation: MigrationOperation) {
    const directory = path.join(root, operation.requestId);
    if (!uuid.allows(operation.requestId) || live.has(directory)) throw migrationFailure();
    live.add(directory);
    try {
      await privateDirectory(root, false);
      await privateDirectory(directory, false);
      const bytes = await privateFile(path.join(directory, 'journal.json'), 1024 * 1024);
      const state = validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (JSON.stringify(state.operation) !== JSON.stringify(migrationOperationSchema.assert(operation))) throw migrationFailure();
      return new AppMigrationJournal(directory, state, directoryIdentity(await fs.lstat(directory, { bigint: true })), bytes);
    } catch {
      live.delete(directory);
      throw migrationFailure();
    }
  }

  /** Selects a private operation by the complete staged update binding, never by an untrusted archive or raw path. */
  static async openBound(root: string, expected: Omit<MigrationOperation, 'images'> & { migrationIds: readonly string[] }) {
    if (!uuid.allows(expected.requestId) || !uuid.allows(expected.stageId)) throw migrationFailure();
    const directory = path.join(root, expected.requestId);
    await privateDirectory(root, false);
    await privateDirectory(directory, false);
    const state = validate(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await privateFile(path.join(directory, 'journal.json'), 1024 * 1024))),
    );
    const { migrationIds, ...binding } = expected;
    if (
      Object.entries(binding).some(([key, value]) => JSON.stringify(Reflect.get(state.operation, key)) !== JSON.stringify(value)) ||
      JSON.stringify(state.operation.images.map(({ migrationId }) => migrationId)) !== JSON.stringify(migrationIds)
    )
      throw migrationFailure();
    return AppMigrationJournal.open(root, state.operation);
  }

  private async checkDirectory() {
    if (this.#closed) throw migrationFailure();
    await privateDirectory(this.directory, false);
    if (directoryIdentity(await fs.lstat(this.directory, { bigint: true })) !== this.identity) throw migrationFailure();
  }
  private async write(bytes: Buffer, exclusive = false) {
    await this.checkDirectory();
    if (bytes.length > 1024 * 1024) throw migrationFailure();
    const temporary = path.join(this.directory, `.journal-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.checkDirectory();
    if (exclusive) {
      await fs.link(temporary, path.join(this.directory, 'journal.json'));
      await fs.unlink(temporary);
    } else {
      if (!(await privateFile(path.join(this.directory, 'journal.json'), 1024 * 1024)).equals(this.#bytes)) throw migrationFailure();
      await fs.rename(temporary, path.join(this.directory, 'journal.json'));
    }
    await syncDirectory(this.directory);
    this.#bytes = bytes;
  }
  async read(): Promise<Readonly<MigrationJournalState>> {
    await this.checkDirectory();
    if (!(await privateFile(path.join(this.directory, 'journal.json'), 1024 * 1024)).equals(this.#bytes)) throw migrationFailure();
    return structuredClone(this.state);
  }
  private async save(value: MigrationJournalState) {
    await this.read();
    const next = validate({ ...value, revision: this.state.revision + 1 });
    await this.write(Buffer.from(JSON.stringify(next)));
    this.state = next;
  }

  async capture(storage: AppStorageWitness, localDirectory: string, archive: ArchiveService) {
    return this.exclusive(() => this.captureCheckpoint(storage, localDirectory, archive)).catch(() => {
      throw migrationFailure();
    });
  }
  private async captureCheckpoint(storage: AppStorageWitness, localDirectory: string, archive: ArchiveService) {
    const before = await this.read();
    if (
      before.phase !== 'allocated' ||
      !canonicalPath(localDirectory) ||
      this.directory === localDirectory ||
      this.directory.startsWith(localDirectory + '/')
    )
      throw migrationFailure();
    await this.save({ ...this.state, phase: 'capturing' });
    const checkpoint = await storage.use(async (docker, observed) => {
      if (migrationStorageHash(observed) !== before.storageSha256 || (await fs.realpath(localDirectory)) !== localDirectory) throw migrationFailure();
      const info = await fs.lstat(localDirectory, { bigint: true });
      if (!info.isDirectory() || String(info.dev) !== observed.directory.device || String(info.ino) !== observed.directory.inode)
        throw migrationFailure();
      await requireMigrationAppStopped(docker, before, observed);
      await validateBackupTree(localDirectory);
      let total = 0n;
      let count = 0;
      const audit = async (name: string): Promise<void> => {
        if (++count > 250000) throw migrationFailure();
        const item = await fs.lstat(name, { bigint: true });
        if (item.isFile()) {
          if (item.nlink !== 1n) throw migrationFailure();
          total += item.size;
        } else if (item.isDirectory()) for (const child of await fs.readdir(name)) await audit(path.join(name, child));
        else if (!item.isSymbolicLink()) throw migrationFailure();
      };
      await audit(localDirectory);
      const capacity = await fs.statfs(this.directory, { bigint: true });
      if (capacity.bavail * capacity.bsize < total + 64n * 1024n * 1024n) throw migrationFailure();
      const pending = path.join(this.directory, 'before.partial');
      const guard = await fs.open(pending, 'wx', 0o600);
      await guard.close();
      const output = await archive.createTarGz(localDirectory, pending);
      if (output.stderr.trim()) throw migrationFailure();
      await fs.chmod(pending, 0o600);
      const entries = await archive.listTarGz(pending);
      validateArchiveLinks(entries, (name) => {
        const normalized = name.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
        if (!normalized || normalized === '.') return 'app-data';
        if (
          path.posix.isAbsolute(normalized) ||
          path.posix.normalize(normalized) !== normalized ||
          normalized.split('/').includes('..') ||
          normalized.includes('\\')
        )
          throw migrationFailure();
        return `app-data/${normalized}`;
      });
      await requireMigrationAppStopped(docker, before, observed);
      const handle = await fs.open(pending, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(pending, path.join(this.directory, 'before.tar.gz'));
      await fs.unlink(pending);
      await syncDirectory(this.directory);
      return this.hashCheckpoint();
    });
    // A failed post-effect storage check must leave the operation in capturing.
    await this.save({ ...this.state, phase: 'ready', checkpoint });
  }

  private async hashCheckpoint() {
    const file = path.join(this.directory, 'before.tar.gz');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.uid !== BigInt(process.geteuid?.() ?? -1) ||
        before.mode & 0o077n ||
        before.size <= 0n ||
        before.size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw migrationFailure();
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (
        fileIdentity(before) !== fileIdentity(await handle.stat({ bigint: true })) ||
        fileIdentity(before) !== fileIdentity(await fs.lstat(file, { bigint: true }))
      )
        throw migrationFailure();
      return { file: 'before.tar.gz' as const, bytes: Number(before.size), sha256: hash.digest('hex'), fileIdentity: fileIdentity(before) };
    } finally {
      await handle.close();
    }
  }
  async verifyCheckpoint() {
    await this.read();
    if (!this.state.checkpoint || JSON.stringify(await this.hashCheckpoint()) !== JSON.stringify(this.state.checkpoint)) throw migrationFailure();
  }

  async intent(pin: AppMigrationImage, specHash: (name: string, nonce: string) => string) {
    const state = await this.read();
    if (!['ready', 'running'].includes(state.phase)) throw migrationFailure();
    const index = state.operation.images.findIndex((entry) => entry.migrationId === pin.migrationId);
    if (index < 0 || JSON.stringify(state.operation.images[index]) !== JSON.stringify(pin)) throw migrationFailure();
    const existing = state.runners.find((row) => row.migrationId === pin.migrationId);
    if (existing) {
      if (existing.specSha256 !== specHash(existing.name, existing.nonce)) throw migrationFailure();
      return existing;
    }
    if (JSON.stringify(state.operation.images[state.runners.length]) !== JSON.stringify(pin)) throw migrationFailure();
    const nonce = randomBytes(16).toString('hex');
    const name = `orbis-migration-${migrationHash({ appUrn: state.operation.appUrn, requestId: state.operation.requestId, stageId: state.operation.stageId, migration: pin.migrationId }).slice(0, 32)}-${nonce.slice(0, 12)}`;
    const row: MigrationRunnerRecord = {
      migrationId: pin.migrationId,
      nonce,
      name,
      specSha256: specHash(name, nonce),
      containerId: null,
      phase: 'create-intent',
      exitCode: null,
      terminalSha256: null,
    };
    await this.save({ ...this.state, phase: 'running', runners: [...this.state.runners, row] });
    return structuredClone(row);
  }
  async record(
    id: string,
    next: 'created' | 'start-intent' | 'terminal' | 'removed',
    containerId: string,
    exitCode: number | null = null,
    terminalSha256: string | null = null,
  ) {
    const state = await this.read();
    if (state.phase !== 'running') throw migrationFailure();
    const index = state.runners.findIndex((row) => row.migrationId === id);
    const row = state.runners[index];
    if (!row || !hash.allows(containerId)) throw migrationFailure();
    const allowed = { created: ['create-intent'], 'start-intent': ['created'], terminal: ['start-intent'], removed: ['terminal'] };
    if (!allowed[next].includes(row.phase) || (row.containerId !== null && row.containerId !== containerId)) throw migrationFailure();
    const runners = structuredClone(this.state.runners);
    runners[index] = { ...row, phase: next, containerId, exitCode, terminalSha256 };
    await this.save({ ...this.state, runners });
  }
  async finishMigrations() {
    if ((await this.read()).phase !== 'running') throw migrationFailure();
    await this.save({ ...this.state, phase: 'migrations-complete' });
  }
  async activationAttempted() {
    if ((await this.read()).phase !== 'migrations-complete') throw migrationFailure();
    await this.save({ ...this.state, phase: 'activation-attempted', targetWritesPossible: true });
  }
  async requireRecovery() {
    await this.save({ ...this.state, phase: 'recovery-required' });
  }
  async beginCommit() {
    const state = await this.read();
    if (!['migrations-complete', 'activation-attempted'].includes(state.phase) || state.commitAttempted || state.restores.length)
      throw migrationFailure();
    await this.save({ ...this.state, phase: 'commit-intent', commitAttempted: true });
  }
  async confirmCommitted(receiptSha256: string) {
    const state = await this.read();
    if (
      !state.commitAttempted ||
      !['commit-intent', 'committed', 'recovery-required'].includes(state.phase) ||
      !hash.allows(receiptSha256) ||
      (state.commitReceiptSha256 !== null && state.commitReceiptSha256 !== receiptSha256)
    )
      throw migrationFailure();
    await this.save({ ...this.state, phase: 'committed', commitReceiptSha256: receiptSha256 });
  }
  async beginRestore() {
    const state = await this.read();
    if (
      state.targetWritesPossible ||
      state.commitAttempted ||
      !state.checkpoint ||
      !['ready', 'running', 'migrations-complete', 'recovery-required', 'restoring'].includes(state.phase) ||
      (state.restores.length && state.restores.at(-1)?.phase !== 'abandoned') ||
      state.restores.length >= 16
    )
      throw migrationFailure();
    const row = { id: randomUUID(), phase: 'intent' as const };
    await this.save({ ...this.state, phase: 'restoring', restores: [...this.state.restores, row] });
    return row;
  }
  async restoreStep(id: string, phase: 'staged' | 'promoting' | 'committed' | 'abandoned') {
    const state = await this.read();
    const row = state.restores.at(-1);
    const allowed = { staged: ['intent'], promoting: ['staged'], committed: ['promoting'], abandoned: ['intent', 'staged', 'promoting'] };
    if (
      state.targetWritesPossible ||
      !['restoring', 'recovery-required'].includes(state.phase) ||
      row?.id !== id ||
      !allowed[phase].includes(row.phase)
    )
      throw migrationFailure();
    await this.save({ ...this.state, phase: 'restoring', restores: [...state.restores.slice(0, -1), { id, phase }] });
  }
  async restored() {
    const state = await this.read();
    if (!['restoring', 'recovery-required'].includes(state.phase) || state.targetWritesPossible || state.restores.at(-1)?.phase !== 'committed')
      throw migrationFailure();
    await this.save({ ...this.state, phase: 'restored' });
  }
  toJSON(): never {
    throw migrationFailure();
  }
  async exclusive<T>(effect: () => Promise<T>): Promise<T> {
    if (this.#closed || this.#executing) throw migrationFailure();
    this.#executing = true;
    try {
      return await effect();
    } finally {
      this.#executing = false;
    }
  }
  async close() {
    if (this.#closed) return;
    if (this.#executing) throw migrationFailure();
    this.#closed = true;
    live.delete(this.directory);
  }
}
