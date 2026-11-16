import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { privateBackupDirectory } from './backup-files';
import type { CoreInspectionRecord } from './time-machine-core-inspection.store';

export type CoreReconciliationBinding = {
  sourcePreparation: CoreInspectionRecord;
  sourceInspection: CoreInspectionRecord;
  destinationInspection: CoreInspectionRecord;
};
export type CoreReconciliationRecord = CoreReconciliationBinding & { version: 1; requestId: string; id: string };
export type CoreRestorationReviewRecord = {
  version: 1;
  requestId: string;
  id: string;
  reconciliationRequestId: string;
  reconciliationId: string;
  reconciliationSha256: string;
};
type Intent = 'requested' | 'settled';
const fail = () => new Error('Isolated reconciliation requires protected recovery. Existing data was preserved.');
const keys = (value: object) => Object.keys(value).sort().join(',');
const inspectionValid = (value: CoreInspectionRecord) =>
  value &&
  keys(value) === 'actor,archiveSha256,id,manifestSha256,ownerId,pointId,requestId,version' &&
  value.version === 2 &&
  [value.id, value.pointId, value.requestId].every((id) => uuid.allows(id)) &&
  Number.isSafeInteger(value.ownerId) &&
  value.ownerId > 0 &&
  hash.allows(value.archiveSha256) &&
  hash.allows(value.manifestSha256) &&
  value.actor &&
  keys(value.actor) === 'ownerId,securityBinding,sessionBinding' &&
  value.actor.ownerId === value.ownerId &&
  hash.allows(value.actor.sessionBinding) &&
  hash.allows(value.actor.securityBinding);
export const sameReconciliationInspection = (a: CoreInspectionRecord, b: CoreInspectionRecord) =>
  ['version', 'id', 'requestId', 'pointId', 'ownerId', 'archiveSha256', 'manifestSha256'].every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  ) &&
  a.actor.ownerId === b.actor.ownerId &&
  a.actor.sessionBinding === b.actor.sessionBinding &&
  a.actor.securityBinding === b.actor.securityBinding;
const same = (a: CoreReconciliationBinding, b: CoreReconciliationBinding) =>
  sameReconciliationInspection(a.sourcePreparation, b.sourcePreparation) &&
  sameReconciliationInspection(a.sourceInspection, b.sourceInspection) &&
  sameReconciliationInspection(a.destinationInspection, b.destinationInspection);
const valid = (value: CoreReconciliationRecord) =>
  value &&
  keys(value) === 'destinationInspection,id,requestId,sourceInspection,sourcePreparation,version' &&
  value.version === 1 &&
  uuid.allows(value.id) &&
  uuid.allows(value.requestId) &&
  inspectionValid(value.sourcePreparation) &&
  inspectionValid(value.sourceInspection) &&
  inspectionValid(value.destinationInspection) &&
  new Set([value.id, value.requestId, value.sourcePreparation.id, value.sourceInspection.id, value.destinationInspection.id]).size === 5 &&
  sameReconciliationInspection(value.sourceInspection, { ...value.sourcePreparation, id: value.sourceInspection.id }) &&
  value.sourcePreparation.ownerId === value.destinationInspection.ownerId &&
  value.sourcePreparation.actor.sessionBinding === value.destinationInspection.actor.sessionBinding &&
  value.sourcePreparation.actor.securityBinding === value.destinationInspection.actor.securityBinding;
const validReview = (value: CoreRestorationReviewRecord) =>
  value &&
  keys(value) === 'id,reconciliationId,reconciliationRequestId,reconciliationSha256,requestId,version' &&
  value.version === 1 &&
  [value.id, value.requestId, value.reconciliationRequestId, value.reconciliationId].every((id) => uuid.allows(id)) &&
  value.id !== value.reconciliationId &&
  hash.allows(value.reconciliationSha256);
const reconciliationDigest = (record: CoreReconciliationRecord) => {
  const inspection = (value: CoreInspectionRecord) => [
    value.version,
    value.id,
    value.requestId,
    value.pointId,
    value.ownerId,
    value.archiveSha256,
    value.manifestSha256,
    value.actor.ownerId,
    value.actor.sessionBinding,
    value.actor.securityBinding,
  ];
  return createHash('sha256')
    .update('orbis.core-restoration-review-binding.v1\n')
    .update(
      JSON.stringify([
        record.version,
        record.requestId,
        record.id,
        inspection(record.sourcePreparation),
        inspection(record.sourceInspection),
        inspection(record.destinationInspection),
      ]),
    )
    .digest('hex');
};

export class CoreReconciliationStore {
  readonly root: string;
  private readonly reviews: string;
  constructor(dataDir: string) {
    if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw fail();
    this.root = path.join(dataDir, 'backups', 'time-machine', 'core-target-reconciliations');
    // Observation records remain separate so older controllers can read their original operation format.
    this.reviews = path.join(dataDir, 'backups', 'time-machine', 'core-restoration-reviews');
  }
  private async directory() {
    await privateBackupDirectory(this.root);
    if (((await fs.lstat(this.root)).mode & 0o777) !== 0o700) throw fail();
  }
  private async read<T>(filename: string, validate: (value: T) => boolean): Promise<T | undefined> {
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw fail();
    }
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.uid !== process.getuid?.() ||
        before.size < 1 ||
        before.size > 8192
      )
        throw fail();
      const body = await file.readFile('utf8');
      const after = await file.stat();
      const named = await fs.lstat(filename);
      if (
        ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].some(
          (key) => Reflect.get(before, key) !== Reflect.get(after, key) || Reflect.get(before, key) !== Reflect.get(named, key),
        )
      )
        throw fail();
      const record: T = JSON.parse(body);
      if (!validate(record)) throw fail();
      return record;
    } catch {
      throw fail();
    } finally {
      await file.close();
    }
  }
  private async publish(filename: string, record: CoreReconciliationRecord | CoreRestorationReviewRecord) {
    const parent = path.dirname(filename);
    const temporary = path.join(parent, `.pending-${randomUUID()}`);
    const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
      try {
        await fs.link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await file.close();
      await fs.unlink(temporary);
    }
    const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async get(requestId: string): Promise<CoreReconciliationRecord | undefined> {
    if (!uuid.allows(requestId)) throw fail();
    await this.directory();
    const record = await this.read(path.join(this.root, `${requestId}.json`), valid);
    if (record && record.requestId !== requestId) throw fail();
    return record;
  }
  async reserve(requestId: string, binding: CoreReconciliationBinding) {
    const proposed: CoreReconciliationRecord = { version: 1, requestId, id: randomUUID(), ...binding };
    if (!valid(proposed)) throw fail();
    await this.directory();
    await this.publish(path.join(this.root, `${requestId}.json`), proposed);
    const record = await this.get(requestId);
    if (!record || !same(record, binding)) throw fail();
    return record;
  }
  async marked(record: CoreReconciliationRecord, intent: Intent) {
    if (!['requested', 'settled'].includes(intent) || !valid(record)) throw fail();
    const named = await this.get(record.requestId);
    if (!named || named.id !== record.id || !same(named, record)) throw fail();
    const marker = await this.read(path.join(this.root, `${record.requestId}.${intent}.json`), valid);
    if (marker && (marker.id !== record.id || marker.requestId !== record.requestId || !same(marker, record))) throw fail();
    return marker !== undefined;
  }
  async mark(record: CoreReconciliationRecord, intent: Intent) {
    await this.marked(record, intent);
    if (intent === 'settled' && !(await this.marked(record, 'requested'))) throw fail();
    await this.publish(path.join(this.root, `${record.requestId}.${intent}.json`), record);
    if (!(await this.marked(record, intent))) throw fail();
  }
  async review(requestId: string, parent: CoreReconciliationRecord, create = false): Promise<CoreRestorationReviewRecord | undefined> {
    if (!uuid.allows(requestId) || !valid(parent)) throw fail();
    const current = await this.get(parent.requestId);
    if (!current || current.id !== parent.id || !same(current, parent)) throw fail();
    if (create && (!(await this.marked(parent, 'requested')) || !(await this.marked(parent, 'settled')))) throw fail();
    try {
      await fs.lstat(this.reviews);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail();
      if (!create) return undefined;
    }
    const created = await fs.mkdir(this.reviews, { recursive: true, mode: 0o700 });
    await privateBackupDirectory(this.reviews);
    if (((await fs.lstat(this.reviews)).mode & 0o777) !== 0o700) throw fail();
    if (created) {
      const parent = await fs.open(path.dirname(this.reviews), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    const filename = path.join(this.reviews, `${parent.requestId}.${requestId}.json`);
    if (create) {
      const proposed: CoreRestorationReviewRecord = {
        version: 1,
        requestId,
        id: randomUUID(),
        reconciliationRequestId: parent.requestId,
        reconciliationId: parent.id,
        reconciliationSha256: reconciliationDigest(parent),
      };
      if (!validReview(proposed)) throw fail();
      await this.publish(filename, proposed);
    }
    const record = await this.read(filename, validReview);
    if (
      record &&
      (record.requestId !== requestId ||
        record.reconciliationRequestId !== parent.requestId ||
        record.reconciliationId !== parent.id ||
        record.reconciliationSha256 !== reconciliationDigest(parent))
    )
      throw fail();
    if (create && !record) throw fail();
    return record;
  }
  async recoveryRecords() {
    await this.directory();
    const records: CoreReconciliationRecord[] = [];
    const directory = await fs.opendir(this.root);
    for await (const entry of directory) {
      if (/^\.pending-[a-f0-9-]{36}$/.test(entry.name)) continue;
      const match = /^([a-f0-9-]{36})(?:\.(requested|settled))?\.json$/.exec(entry.name);
      if (!match || !uuid.allows(match[1])) throw fail();
      const record = await this.get(match[1]);
      if (!record) throw fail();
      if (match[2]) {
        await this.marked(record, match[2] as Intent);
        if (match[2] === 'settled' && !(await this.marked(record, 'requested'))) throw fail();
      } else records.push(record);
    }
    return records;
  }
}
