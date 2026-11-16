import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import type { SettingsBackupJob } from '@runtipi/common/schemas/settings-backup';
import { resetJournalSchema, type ResetJournal } from '../system-reset/reset-contract';
import { privateBackupDirectory } from './backup-files';

export type CustodyBackupJob = SettingsBackupJob & { ownerId: number };
const manifestSchema = type({
  '+': 'reject',
  version: '1',
  resetId: 'string.uuid',
  controller: 'string > 0 & string <= 253',
  createdAt: 'number.integer > 0',
  users: 'number.integer > 0[]',
  jobs: type({ '+': 'reject', id: 'string.uuid', ownerId: 'number.integer > 0', metadataSha256: '/^[a-f0-9]{64}$/' }).array(),
}).narrow(
  (value) =>
    value.users.length <= 256 &&
    new Set(value.users).size === value.users.length &&
    value.users.every(Number.isSafeInteger) &&
    value.jobs.length <= 32 &&
    new Set(value.jobs.map((job) => job.id)).size === value.jobs.length &&
    value.jobs.every((job) => Number.isSafeInteger(job.ownerId) && value.users.includes(job.ownerId)),
);
const markerSchema = type({ '+': 'reject', version: '1', resetId: 'string.uuid' });
const claimantSchema = type({ '+': 'reject', version: '1', resetId: 'string.uuid', claimantId: 'number.integer > 0' }).narrow((value) =>
  Number.isSafeInteger(value.claimantId),
);
type Manifest = typeof manifestSchema.infer;
type Pending = { manifest: Manifest; claimantId?: number };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const invalid = () => new Error('Saved backup ownership needs local review.');
const maximumResets = 4096;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const metadataDigest = (job: CustodyBackupJob) => {
  const { ownerId: _owner, ...metadata } = job;
  return createHash('sha256').update(canonical(metadata)).digest('hex');
};

export class ResetCustodyRecords {
  constructor(protected readonly root: string) {}

  protected filename(id: string, suffix = '') {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw invalid();
    return path.join(this.root, `${id}${suffix}`);
  }
  protected async read(filename: string): Promise<unknown | undefined> {
    await privateBackupDirectory(this.root);
    try {
      await fs.lstat(filename);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    await privateBackupDirectory(filename);
    const record = path.join(filename, 'record.json');
    const file = await fs.open(record, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size > 65_536) throw invalid();
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      const after = await file.stat();
      const current = await fs.lstat(record);
      for (const key of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const)
        if (before[key] !== after[key] || before[key] !== current[key]) throw invalid();
      return value;
    } finally {
      await file.close();
    }
  }
  protected async publish(filename: string, value: unknown) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 65_536) throw invalid();
    await privateBackupDirectory(this.root);
    const before = await fs.lstat(this.root);
    const temporary = path.join(this.root, `.custody-${randomUUID()}`);
    await fs.mkdir(temporary, { mode: 0o700 });
    const file = await fs.open(path.join(temporary, 'record.json'), 'wx', 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      const prepared = await fs.open(temporary, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        await prepared.sync();
      } finally {
        await prepared.close();
      }
      await privateBackupDirectory(this.root);
      const current = await fs.lstat(this.root);
      if (current.dev !== before.dev || current.ino !== before.ino) throw invalid();
      // A nonempty marker directory is never replaced. Its synced contents arrive atomically.
      await fs.rename(temporary, filename).catch((error: NodeJS.ErrnoException) => {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code ?? '')) throw error;
      });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
    const directory = await fs.open(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if (canonical(await this.read(filename)) !== canonical(value)) throw invalid();
  }
}

/** This ledger survives account removal without extending the legacy backup or reset journal schemas. */
export class ResetBackupCustody extends ResetCustodyRecords {
  private identity(manifest: Manifest, journal: ResetJournal) {
    if (manifest.resetId !== journal.id || manifest.createdAt !== journal.createdAt || canonical(manifest.users) !== canonical(journal.users))
      throw invalid();
  }
  async prepare(journal: ResetJournal, jobs: CustodyBackupJob[]) {
    resetJournalSchema.assert(journal);
    if (journal.accounts !== 'remove') return;
    if (journal.phase !== 'prepared') throw invalid();
    const existing = await this.read(this.filename(journal.id));
    if (existing !== undefined) {
      this.identity(manifestSchema.assert(existing), journal);
      return;
    }
    await this.pending();
    if ((await fs.readdir(this.root)).filter((name) => /^[a-f0-9-]{36}$/.test(name)).length >= maximumResets) throw invalid();
    const manifest: Manifest = manifestSchema.assert({
      version: 1,
      resetId: journal.id,
      controller: journal.controller,
      createdAt: journal.createdAt,
      users: [...journal.users],
      jobs: jobs
        .filter((job) => journal.users.includes(job.ownerId))
        .map((job) => ({ id: job.id, ownerId: job.ownerId, metadataSha256: metadataDigest(job) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    await this.publish(this.filename(journal.id), manifest);
  }
  async complete(journal: ResetJournal, verifyReceipt: () => Promise<boolean>) {
    resetJournalSchema.assert(journal);
    if (journal.accounts !== 'remove') return;
    if (journal.phase !== 'complete') throw invalid();
    const value = await this.read(this.filename(journal.id));
    if (value === undefined) return;
    const manifest = manifestSchema.assert(value);
    this.identity(manifest, journal);
    if ((await verifyReceipt()) !== true) throw invalid();
    await this.publish(this.filename(journal.id, '.available'), { version: 1, resetId: journal.id });
  }
  async pending(): Promise<Pending[]> {
    await privateBackupDirectory(this.root);
    const pending: Pending[] = [];
    const filenames = (await fs.readdir(this.root)).sort();
    if (filenames.length > maximumResets * 4 || filenames.filter((name) => /^[a-f0-9-]{36}$/.test(name)).length > maximumResets) throw invalid();
    for (const filename of filenames) {
      if (!/^[a-f0-9-]{36}$/.test(filename)) {
        if (!/^(?:[a-f0-9-]{36}\.(?:available|claim|claimed)|\.custody-[a-f0-9-]{36})$/.test(filename)) throw invalid();
        if (!filename.startsWith('.custody-') && !filenames.includes(filename.slice(0, 36))) throw invalid();
        await privateBackupDirectory(path.join(this.root, filename));
        continue;
      }
      const manifest = manifestSchema.assert(await this.read(path.join(this.root, filename)));
      if (path.basename(this.filename(manifest.resetId)) !== filename) throw invalid();
      const available = await this.read(this.filename(manifest.resetId, '.available'));
      if (available === undefined) continue;
      if (markerSchema.assert(available).resetId !== manifest.resetId) throw invalid();
      const claimant = await this.read(this.filename(manifest.resetId, '.claim'));
      const claimantId = claimant === undefined ? undefined : claimantSchema.assert(claimant).claimantId;
      if (claimant !== undefined && claimantSchema.assert(claimant).resetId !== manifest.resetId) throw invalid();
      if (claimantId !== undefined && manifest.users.includes(claimantId)) throw invalid();
      const claimed = await this.read(this.filename(manifest.resetId, '.claimed'));
      if (claimed !== undefined) {
        const complete = claimantSchema.assert(claimed);
        if (complete.resetId !== manifest.resetId || complete.claimantId !== claimantId) throw invalid();
        continue;
      }
      if (manifest.jobs.length) pending.push({ manifest, claimantId });
    }
    return pending;
  }
  async quarantined() {
    return new Set((await this.pending()).flatMap(({ manifest }) => manifest.jobs.map((job) => job.id)));
  }
  async claim(
    ownerId: number,
    validate: () => Promise<void>,
    read: (id: string) => Promise<CustodyBackupJob | undefined>,
    write: (job: CustodyBackupJob) => Promise<void>,
    onlyId?: string,
  ) {
    for (const { manifest, claimantId } of await this.pending()) {
      if (onlyId !== undefined && !manifest.jobs.some((job) => job.id === onlyId)) continue;
      if (manifest.users.includes(ownerId)) continue;
      if (claimantId !== undefined && claimantId !== ownerId) throw invalid();
      await validate();
      const claim = { version: 1 as const, resetId: manifest.resetId, claimantId: ownerId };
      await this.publish(this.filename(manifest.resetId, '.claim'), claim);
      for (const expected of manifest.jobs) {
        const job = await read(expected.id);
        // Deletion does not transfer an identifier or prevent recovery of other saved files.
        if (!job) continue;
        if (metadataDigest(job) !== expected.metadataSha256 || (job.ownerId !== expected.ownerId && job.ownerId !== ownerId)) throw invalid();
        await validate();
        if (job.ownerId !== ownerId) await write({ ...job, ownerId });
        await validate();
      }
      await validate();
      await this.publish(this.filename(manifest.resetId, '.claimed'), claim);
    }
  }
}
