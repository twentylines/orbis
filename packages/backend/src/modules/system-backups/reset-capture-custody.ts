import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import { resetJournalSchema, type ResetJournal } from '../system-reset/reset-contract';
import { privateBackupDirectory } from './backup-files';
import { ResetCustodyRecords } from './reset-backup-custody';

const sourceFields = {
  kind: "'core' | 'components'",
  id: 'string.uuid',
  ownerId: 'number.integer > 0',
  identitySha256: '/^[a-f0-9]{64}$/',
} as const;
const sourceSchema = type({ '+': 'reject', ...sourceFields }).narrow((value) => Number.isSafeInteger(value.ownerId));
export type ResetCaptureSource = typeof sourceSchema.infer;
const entrySchema = type({ '+': 'reject', ...sourceFields, holderId: 'number.integer > 0', previousResetId: 'string.uuid | null' }).narrow(
  (value) => Number.isSafeInteger(value.ownerId) && Number.isSafeInteger(value.holderId),
);
const key = (source: Pick<ResetCaptureSource, 'kind' | 'id'>) => `${source.kind}:${source.id}`;
const maximumCaptures = 2 * timeMachineLimits.points;
const maximumResets = 4096;
const manifestFields = {
  resetId: 'string.uuid',
  controller: 'string > 0 & string <= 253',
  createdAt: 'number.integer > 0',
  users: 'number.integer > 0[]',
  captures: entrySchema.array(),
} as const;
const validManifest = (value: { users: number[]; captures: Array<typeof entrySchema.infer> }) =>
  value.users.length <= 256 &&
  new Set(value.users).size === value.users.length &&
  value.users.every(Number.isSafeInteger) &&
  value.captures.length <= maximumCaptures &&
  new Set(value.captures.map(key)).size === value.captures.length;
const manifestV1 = type({ '+': 'reject', version: '1', ...manifestFields }).narrow(
  (value) => validManifest(value) && value.captures.every((capture) => value.users.includes(capture.holderId)),
);
const manifestV2 = type({ '+': 'reject', version: '2', ...manifestFields, orphanedOwners: 'number.integer > 0[]' }).narrow(
  (value) =>
    validManifest(value) &&
    value.orphanedOwners.length <= maximumCaptures &&
    value.orphanedOwners.every((ownerId) => Number.isSafeInteger(ownerId) && !value.users.includes(ownerId)) &&
    new Set(value.orphanedOwners).size === value.orphanedOwners.length &&
    value.captures.every((capture) => value.users.includes(capture.holderId) || value.orphanedOwners.includes(capture.holderId)),
);
const manifestSchema = manifestV1.or(manifestV2);
const markerSchema = type({ '+': 'reject', version: '1', resetId: 'string.uuid' });
const claimantSchema = type({ '+': 'reject', version: '1', resetId: 'string.uuid', claimantId: 'number.integer > 0' }).narrow((value) =>
  Number.isSafeInteger(value.claimantId),
);
type Manifest = typeof manifestSchema.infer;
type RecordState = { manifest: Manifest; available: boolean; claimantId?: number; claimed: boolean };
const invalid = () => new Error('Saved capture ownership needs local review.');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical((value as Record<string, unknown>)[name])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

/** The original owner remains part of the capture's encryption and historical identity. */
export class ResetCaptureCustody extends ResetCustodyRecords {
  private async records(): Promise<RecordState[]> {
    await privateBackupDirectory(this.root);
    const filenames = (await fs.readdir(this.root)).sort();
    if (filenames.length > maximumResets * 4 || filenames.filter((name) => /^[a-f0-9-]{36}$/.test(name)).length > maximumResets) throw invalid();
    const records: RecordState[] = [];
    let bytes = 0;
    let captures = 0;
    for (const name of filenames) {
      if (!/^[a-f0-9-]{36}$/.test(name)) {
        if (!/^(?:[a-f0-9-]{36}\.(?:available|claim|claimed)|\.custody-[a-f0-9-]{36})$/.test(name)) throw invalid();
        if (!name.startsWith('.custody-') && !filenames.includes(name.slice(0, 36))) throw invalid();
        await privateBackupDirectory(path.join(this.root, name));
        continue;
      }
      const manifest = manifestSchema.assert(await this.read(path.join(this.root, name)));
      bytes += Buffer.byteLength(JSON.stringify(manifest));
      captures += manifest.captures.length;
      if (bytes > 32 * 1024 * 1024 || captures > 65_536) throw invalid();
      if (path.basename(this.filename(manifest.resetId)) !== name) throw invalid();
      const available = await this.read(this.filename(manifest.resetId, '.available'));
      const claimant = await this.read(this.filename(manifest.resetId, '.claim'));
      const claimed = await this.read(this.filename(manifest.resetId, '.claimed'));
      if (available !== undefined && markerSchema.assert(available).resetId !== manifest.resetId) throw invalid();
      const claimantId = claimant === undefined ? undefined : claimantSchema.assert(claimant).claimantId;
      if (claimant !== undefined && claimantSchema.assert(claimant).resetId !== manifest.resetId) throw invalid();
      if (claimantId !== undefined && (available === undefined || manifest.users.includes(claimantId))) throw invalid();
      if (claimed !== undefined) {
        const complete = claimantSchema.assert(claimed);
        if (available === undefined || complete.resetId !== manifest.resetId || complete.claimantId !== claimantId) throw invalid();
      }
      records.push({ manifest, available: available !== undefined, claimantId, claimed: claimed !== undefined });
    }
    return records;
  }

  private resolve(sources: ResetCaptureSource[], records: RecordState[]) {
    if (sources.length > maximumCaptures || new Set(sources.map(key)).size !== sources.length) throw invalid();
    const owners = new Map<string, { ownerId: number | null; resetId: string | null }>();
    const histories = new Map<string, Array<{ state: RecordState; expected: typeof entrySchema.infer }>>();
    for (const state of records) {
      if (!state.available) continue;
      for (const expected of state.manifest.captures) {
        const identity = key(expected);
        const history = histories.get(identity) ?? [];
        history.push({ state, expected });
        histories.set(identity, history);
      }
    }
    for (const value of sources) {
      const source = sourceSchema.assert(value);
      const identity = key(source);
      let owner: number | null = source.ownerId;
      let resetId: string | null = null;
      const chain = new Map<string | null, { state: RecordState; holderId: number }>();
      for (const { state, expected } of histories.get(identity) ?? []) {
        const { holderId, previousResetId, ...original } = expected;
        if (canonical(original) !== canonical(source) || chain.has(previousResetId)) throw invalid();
        chain.set(previousResetId, { state, holderId });
      }
      let visited = 0;
      while (true) {
        const next: { state: RecordState; holderId: number } | undefined = chain.get(resetId);
        if (!next) break;
        if (++visited > chain.size || owner !== next.holderId) throw invalid();
        const { manifest, claimed, claimantId } = next.state;
        resetId = manifest.resetId;
        owner = claimed && claimantId !== undefined ? claimantId : null;
      }
      if (visited !== chain.size) throw invalid();
      owners.set(identity, { ownerId: owner, resetId });
    }
    return owners;
  }

  async owners(sources: ResetCaptureSource[]) {
    return new Map([...this.resolve(sources, await this.records())].map(([identity, value]) => [identity, value.ownerId]));
  }

  async hasReset(journal: ResetJournal) {
    resetJournalSchema.assert(journal);
    const record = (await this.records()).find(({ manifest }) => manifest.resetId === journal.id);
    if (record && (record.manifest.createdAt !== journal.createdAt || canonical(record.manifest.users) !== canonical(journal.users))) throw invalid();
    return record !== undefined;
  }

  async pendingFor(ownerId: number) {
    return (await this.records()).some((record) => record.available && !record.claimed && !record.manifest.users.includes(ownerId));
  }

  async prepare(journal: ResetJournal, sources: ResetCaptureSource[]) {
    return this.prepareRecord(journal, sources);
  }

  /** currentUsers is the complete database cohort read by the global reset caller under maintenance. */
  async prepareForGlobalReset(journal: ResetJournal, sources: ResetCaptureSource[], currentUsers: number[]) {
    if (
      !currentUsers.length ||
      currentUsers.length > 256 ||
      new Set(currentUsers).size !== currentUsers.length ||
      currentUsers.some((id) => !Number.isSafeInteger(id) || id <= 0 || !journal.users.includes(id))
    )
      throw invalid();
    return this.prepareRecord(journal, sources, currentUsers);
  }

  private async prepareRecord(journal: ResetJournal, sources: ResetCaptureSource[], currentUsers?: number[]) {
    resetJournalSchema.assert(journal);
    if (journal.accounts !== 'remove') return;
    if (journal.phase !== 'prepared') throw invalid();
    const records = await this.records();
    const existing = records.find(({ manifest }) => manifest.resetId === journal.id);
    const previous = records.filter(({ manifest }) => manifest.resetId !== journal.id);
    const owners = this.resolve(sources, previous);
    const orphanedOwners = new Set<number>();
    const captures = sources
      .map((source) => {
        const previous = owners.get(key(source));
        if (!previous?.ownerId) throw invalid();
        if (!journal.users.includes(previous.ownerId)) {
          if (!currentUsers || currentUsers.includes(previous.ownerId)) throw invalid();
          orphanedOwners.add(previous.ownerId);
        }
        return { ...sourceSchema.assert(source), holderId: previous.ownerId, previousResetId: previous.resetId };
      })
      .sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const manifest = manifestSchema.assert({
      version: orphanedOwners.size ? 2 : 1,
      resetId: journal.id,
      controller: existing?.manifest.controller ?? journal.controller,
      createdAt: journal.createdAt,
      users: [...journal.users],
      captures,
      ...(orphanedOwners.size ? { orphanedOwners: [...orphanedOwners].sort((a, b) => a - b) } : {}),
    });
    if (existing) {
      if (canonical(existing.manifest) !== canonical(manifest)) throw invalid();
      return;
    }
    if (records.length >= maximumResets) throw invalid();
    await this.publish(this.filename(journal.id), manifest);
  }

  async complete(journal: ResetJournal, verifyReceipt: () => Promise<boolean>) {
    resetJournalSchema.assert(journal);
    if (journal.accounts !== 'remove') return;
    if (journal.phase !== 'complete') throw invalid();
    const record = (await this.records()).find(({ manifest }) => manifest.resetId === journal.id);
    if (
      !record ||
      record.manifest.createdAt !== journal.createdAt ||
      canonical(record.manifest.users) !== canonical(journal.users) ||
      (await verifyReceipt()) !== true
    )
      throw invalid();
    await this.publish(this.filename(journal.id, '.available'), { version: 1, resetId: journal.id });
  }

  async claim(
    ownerId: number,
    validate: () => Promise<void>,
    readSource: (kind: ResetCaptureSource['kind'], id: string) => Promise<ResetCaptureSource | undefined>,
  ) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw invalid();
    const records = await this.records();
    for (const record of records) {
      const { manifest, claimantId } = record;
      if (!record.available || record.claimed || manifest.users.includes(ownerId)) continue;
      if (claimantId !== undefined && claimantId !== ownerId) throw invalid();
      await validate();
      const claim = { version: 1, resetId: manifest.resetId, claimantId: ownerId };
      await this.publish(this.filename(manifest.resetId, '.claim'), claim);
      const previous = records.filter((candidate) => candidate.manifest.resetId !== manifest.resetId);
      const priorHolders = this.resolve(
        manifest.captures.map(({ holderId: _holder, previousResetId: _previous, ...source }) => source),
        previous,
      );
      for (const { holderId, previousResetId, ...expected } of manifest.captures) {
        const source = await readSource(expected.kind, expected.id);
        if (source === undefined) continue;
        const holder = priorHolders.get(key(source));
        if (canonical(sourceSchema.assert(source)) !== canonical(expected) || holder?.ownerId !== holderId || holder.resetId !== previousResetId)
          throw invalid();
        await validate();
      }
      await validate();
      await this.publish(this.filename(manifest.resetId, '.claimed'), claim);
      record.claimed = true;
      record.claimantId = ownerId;
    }
  }
}
