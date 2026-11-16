import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { privateBackupDirectory } from './backup-files';
import type { CorePortableActor } from '../time-machine-capsules/core-portable-root-client';

export type CoreInspectionBinding = { pointId: string; ownerId: number; archiveSha256: string; manifestSha256: string; actor: CorePortableActor };
export type CoreInspectionRecord = CoreInspectionBinding & { requestId: string; id: string; version: 1 | 2 };
const fail = () => new Error('Local inspection requires protected recovery. Existing data was preserved.');
const fields = ['actor', 'archiveSha256', 'id', 'manifestSha256', 'ownerId', 'pointId', 'requestId', 'version'];
const namespaces = ['core-inspections', 'core-bootstrap-inspections', 'core-runtime-enrollments', 'core-target-preparations'] as const;
type Namespace = (typeof namespaces)[number];
type DispatchIntent = 'requested' | 'approval-requested' | 'settled' | 'approval-settled';
const intents: DispatchIntent[] = ['requested', 'approval-requested', 'settled', 'approval-settled'];
const valid = (value: CoreInspectionRecord) =>
  value &&
  Object.keys(value).sort().join(',') === fields.join(',') &&
  (value.version === 1 || value.version === 2) &&
  uuid.allows(value.id) &&
  uuid.allows(value.requestId) &&
  uuid.allows(value.pointId) &&
  Number.isSafeInteger(value.ownerId) &&
  value.ownerId > 0 &&
  hash.allows(value.archiveSha256) &&
  hash.allows(value.manifestSha256) &&
  value.actor &&
  Object.keys(value.actor).sort().join(',') === 'ownerId,securityBinding,sessionBinding' &&
  value.actor.ownerId === value.ownerId &&
  hash.allows(value.actor.sessionBinding) &&
  hash.allows(value.actor.securityBinding);
const same = (a: CoreInspectionRecord, b: CoreInspectionRecord) =>
  a.requestId === b.requestId &&
  a.pointId === b.pointId &&
  a.ownerId === b.ownerId &&
  a.archiveSha256 === b.archiveSha256 &&
  a.manifestSha256 === b.manifestSha256 &&
  a.actor.ownerId === b.actor.ownerId &&
  a.actor.sessionBinding === b.actor.sessionBinding &&
  a.actor.securityBinding === b.actor.securityBinding;

export class CoreInspectionStore {
  private readonly root: string;
  constructor(dataDir: string, namespace: Namespace = 'core-inspections') {
    if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir || !namespaces.includes(namespace)) throw fail();
    this.root = path.join(dataDir, 'backups', 'time-machine', namespace);
  }
  private async directory(target: string) {
    await privateBackupDirectory(target);
    const info = await fs.lstat(target);
    if ((info.mode & 0o777) !== 0o700) throw fail();
  }
  private async read(filename: string): Promise<CoreInspectionRecord | undefined> {
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
        before.size > 4096
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
      const value: CoreInspectionRecord = JSON.parse(body);
      if (!valid(value)) throw fail();
      return value;
    } catch {
      throw fail();
    } finally {
      await file.close();
    }
  }
  private async publish(directory: string, filename: string, value: CoreInspectionRecord): Promise<boolean> {
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let linked = false;
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      try {
        await fs.link(temporary, filename);
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await file.close();
      await fs.unlink(temporary);
    }
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return linked;
  }
  async get(requestId: string, expected: CoreInspectionBinding): Promise<CoreInspectionRecord | undefined> {
    if (!uuid.allows(requestId)) throw fail();
    await this.directory(this.root);
    const record = await this.read(path.join(this.root, `${requestId}.json`));
    if (!record) return undefined;
    if (!same(record, { ...expected, requestId, id: record.id, version: 1 })) throw fail();
    if (record.version === 2) return record;
    // Retain the original paired records without replacing their operation identity.
    const pointDirectory = path.join(this.root, record.pointId);
    await this.directory(pointDirectory);
    let found = false;
    for (let index = 0; index < 256; index++) {
      const slot = await this.read(path.join(pointDirectory, `${index}.json`));
      if (!slot) continue;
      if (slot.pointId !== record.pointId) throw fail();
      if (slot.requestId === requestId) {
        if (found || !same(slot, record) || slot.id !== record.id) throw fail();
        found = true;
      }
    }
    if (!found) throw fail();
    return record;
  }
  async reserve(requestId: string, binding: CoreInspectionBinding): Promise<CoreInspectionRecord> {
    if (!uuid.allows(requestId)) throw fail();
    await this.directory(this.root);
    const proposed: CoreInspectionRecord = { version: 2, id: randomUUID(), requestId, ...binding };
    if (!valid(proposed)) throw fail();
    const filename = path.join(this.root, `${requestId}.json`);
    if (!(await this.read(filename))) await this.publish(this.root, filename, proposed);
    const named = await this.read(filename);
    if (!named || !same(named, proposed)) throw fail();
    if (named.version === 2) return named;
    const legacy = await this.get(requestId, binding);
    if (!legacy) throw fail();
    return legacy;
  }
  async marked(requestId: string, binding: CoreInspectionBinding, intent: DispatchIntent): Promise<boolean> {
    if (!intents.includes(intent)) throw fail();
    const record = await this.get(requestId, binding);
    if (!record || record.version !== 2) throw fail();
    const marker = await this.read(path.join(this.root, `${requestId}.${intent}.json`));
    if (!marker) return false;
    if (!same(marker, record) || marker.id !== record.id || marker.version !== record.version) throw fail();
    return true;
  }
  // A marker records dispatch intent, never successful execution or permission to replay.
  async mark(requestId: string, binding: CoreInspectionBinding, intent: DispatchIntent): Promise<void> {
    if (!intents.includes(intent)) throw fail();
    const record = await this.get(requestId, binding);
    if (!record || record.version !== 2) throw fail();
    await this.publish(this.root, path.join(this.root, `${requestId}.${intent}.json`), record);
    if (!(await this.marked(requestId, binding, intent))) throw fail();
  }
  async recoveryRecords(): Promise<CoreInspectionRecord[]> {
    await this.directory(this.root);
    const records: CoreInspectionRecord[] = [];
    const directory = await fs.opendir(this.root);
    try {
      for await (const entry of directory) {
        if (entry.name.startsWith('.pending-')) continue;
        if (!entry.name.endsWith('.json')) throw fail();
        const parts = entry.name.slice(0, -5).split('.');
        if (parts.length === 2 && uuid.allows(parts[0]) && intents.includes(parts[1] as DispatchIntent)) {
          const marker = await this.read(path.join(this.root, entry.name));
          const record = await this.read(path.join(this.root, `${parts[0]}.json`));
          if (
            !marker ||
            !record ||
            record.version !== 2 ||
            marker.version !== 2 ||
            record.requestId !== parts[0] ||
            !same(marker, record) ||
            marker.id !== record.id
          )
            throw fail();
          continue;
        }
        if (!uuid.allows(entry.name.slice(0, -5))) throw fail();
        const record = await this.read(path.join(this.root, entry.name));
        if (!record || record.version !== 2 || `${record.requestId}.json` !== entry.name) throw fail();
        records.push(record);
      }
    } finally {
      await directory.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    return records;
  }
}
