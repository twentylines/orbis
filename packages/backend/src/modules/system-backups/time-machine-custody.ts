import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request } from 'express';
import { backupMaintenanceActive, enterBackupMutation } from '@/common/backup-maintenance';
import type { AuthService } from '../auth/auth.service';
import type { ResetJournal } from '../system-reset/reset-contract';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { ResetCaptureCustody, type ResetCaptureSource } from './reset-capture-custody';
import type { TimeMachineStore, StoredTimeMachinePoint } from './time-machine-store';
import type { TimeMachineComponentsStore, StoredComponentsPoint } from './time-machine-components-store';
import { timeMachineConflict } from './time-machine-policy';

export const captureCustodyKey = (kind: ResetCaptureSource['kind'], id: string) => `${kind}:${id}`;
function source(kind: ResetCaptureSource['kind'], point: StoredTimeMachinePoint | StoredComponentsPoint): ResetCaptureSource {
  const metadata: Record<string, unknown> = { ...point };
  delete metadata.status;
  delete metadata.issue;
  delete metadata.backupJobId;
  return {
    kind,
    id: point.id,
    ownerId: point.ownerId,
    identitySha256: createHash('sha256').update(`orbis-reset-capture-source-v1\n${kind}\n`).update(canonicalPublicationJson(metadata)).digest('hex'),
  };
}

export class TimeMachineCustody {
  private readonly records: ResetCaptureCustody;
  private readonly directory: string;
  private seenHistory = false;
  private claims: Promise<void> = Promise.resolve();
  constructor(
    dataDirectory: string,
    private readonly core: () => TimeMachineStore,
    private readonly components: () => TimeMachineComponentsStore,
    private readonly auth: AuthService,
    private readonly closing: () => boolean,
  ) {
    this.directory = path.join(dataDirectory, 'backups', 'reset-capture-custody');
    this.records = new ResetCaptureCustody(this.directory);
  }

  private async history() {
    try {
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw timeMachineConflict('storage-unavailable');
      this.seenHistory = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (this.seenHistory) throw timeMachineConflict('storage-unavailable');
      return false;
    }
  }

  async owners(core: StoredTimeMachinePoint[], components: StoredComponentsPoint[]) {
    if (!(await this.history()))
      return new Map([
        ...core.map((point) => [captureCustodyKey('core', point.id), point.ownerId] as const),
        ...components.map((point) => [captureCustodyKey('components', point.id), point.ownerId] as const),
      ]);
    return this.records.owners([...core.map((point) => source('core', point)), ...components.map((point) => source('components', point))]);
  }
  async assertOwner(kind: ResetCaptureSource['kind'], point: StoredTimeMachinePoint | StoredComponentsPoint, ownerId: number) {
    const owner = (await this.history()) ? (await this.records.owners([source(kind, point)])).get(captureCustodyKey(kind, point.id)) : point.ownerId;
    if (owner !== ownerId) throw timeMachineConflict('point-not-found');
  }
  private async inventory() {
    const [core, components] = await Promise.all([this.core().list(), this.components().list()]);
    return [...core.map((point) => source('core', point)), ...components.map((point) => source('components', point))].sort((a, b) =>
      captureCustodyKey(a.kind, a.id) < captureCustodyKey(b.kind, b.id) ? -1 : 1,
    );
  }
  async prepare(journal: ResetJournal, currentUsers: number[]) {
    if (journal.accounts !== 'remove') return;
    if (!backupMaintenanceActive() || this.closing()) throw timeMachineConflict('operation-busy');
    const sources = await this.inventory();
    await this.records.prepareForGlobalReset(journal, sources, currentUsers);
    this.seenHistory = true;
    if (canonicalPublicationJson(sources) !== canonicalPublicationJson(await this.inventory())) throw timeMachineConflict('revision-conflict');
  }
  async complete(journal: ResetJournal, verifyReceipt: () => Promise<boolean>) {
    if (journal.accounts !== 'remove') return;
    if (!(await this.history())) return;
    // Journals completed by releases without capture custody retain their legacy semantics.
    if (!(await this.records.hasReset(journal))) return;
    await this.records.complete(journal, verifyReceipt);
  }
  async reconcile(ownerId: number, request?: Request) {
    if (!request || !(await this.history())) return;
    const work = this.claims.then(async () => {
      if (!(await this.records.pendingFor(ownerId))) return;
      const release = enterBackupMutation();
      if (!release) throw timeMachineConflict('operation-busy');
      try {
        const before = { ...(await this.auth.operatorActionContext(request)) };
        if (before.userId !== ownerId) throw timeMachineConflict('point-not-found');
        const validate = async () => {
          if (this.closing()) throw timeMachineConflict('operation-busy');
          const current = await this.auth.operatorActionContext(request);
          if (
            current.userId !== before.userId ||
            current.sessionBinding !== before.sessionBinding ||
            current.securityBinding !== before.securityBinding
          )
            throw timeMachineConflict('point-not-found');
        };
        await this.records.claim(ownerId, validate, async (kind, id) => {
          if (kind === 'components') {
            const point = await this.components().find(id);
            return point ? source(kind, point) : undefined;
          }
          try {
            return source(kind, await this.core().load(id));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
        });
      } finally {
        release();
      }
    });
    this.claims = work.catch(() => undefined);
    await work;
  }
}
