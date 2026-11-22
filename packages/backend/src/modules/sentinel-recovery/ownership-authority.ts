import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { HostCredentialRecoveryBroker, OwnershipGrant, OwnershipPurpose } from './host-broker';

type Broker = Pick<HostCredentialRecoveryBroker, 'ownershipPrepare' | 'ownershipCheck' | 'ownershipComplete'>;
type WriteState = 'not-started' | 'uncertain' | 'committed';
export type OwnershipOutcome = Readonly<{
  requestId: string;
  operationId?: string;
  writes: WriteState;
  authority: 'unknown' | 'pending' | 'completed';
}>;

export class OwnershipWriteError extends ServiceUnavailableException {
  constructor(readonly outcome: OwnershipOutcome) {
    super('Account ownership could not be verified. Preserve the operation and check recovery before trying again.');
  }
}

/** A pending Root grant, never a local observation of an empty operator table.
 * The durable Root hold spans writes and does not expire on client cancellation.
 * An uncertain write is neither rolled back nor reported as not-written here.
 */
export class OwnershipWriteLease {
  private writes: WriteState = 'not-started';
  private authority: OwnershipOutcome['authority'] = 'pending';
  private finished = false;
  private busy = false;

  private constructor(
    private readonly broker: Broker,
    private readonly grant: OwnershipGrant,
  ) {}

  /** New operation only. A retained request ID must use resume instead. */
  static async prepare(broker: Broker, purpose: OwnershipPurpose, requestId = randomBytes(32).toString('hex')) {
    let grant: OwnershipGrant | undefined;
    try {
      grant = await broker.ownershipPrepare({ requestId, purpose });
      if (grant.state !== 'pending' || grant.requestId !== requestId || grant.purpose !== purpose) throw new Error('No pending grant.');
      return new OwnershipWriteLease(broker, grant);
    } catch {
      throw new OwnershipWriteError(
        Object.freeze({ requestId, ...(grant ? { operationId: grant.operationId } : {}), writes: 'not-started', authority: 'unknown' }),
      );
    }
  }

  /** A retained operation may already include effective writes from an earlier
   * process. A replayed pending grant never proves that those writes did not run.
   */
  static async resume(broker: Broker, purpose: OwnershipPurpose, requestId: string) {
    try {
      const lease = await OwnershipWriteLease.prepare(broker, purpose, requestId);
      lease.writes = 'uncertain';
      return lease;
    } catch (error) {
      throw new OwnershipWriteError(
        Object.freeze({
          ...(error instanceof OwnershipWriteError ? error.outcome : { requestId, authority: 'unknown' as const }),
          writes: 'uncertain',
        }),
      );
    }
  }

  get outcome(): OwnershipOutcome {
    return Object.freeze({ requestId: this.grant.requestId, operationId: this.grant.operationId, writes: this.writes, authority: this.authority });
  }

  get admissionBinding(): string {
    return this.grant.admissionBinding;
  }

  private fail(): never {
    throw new OwnershipWriteError(this.outcome);
  }

  private async invoke<T>(work: () => Promise<T>): Promise<T> {
    if (this.finished || this.busy) return this.fail();
    this.busy = true;
    try {
      return await work();
    } catch {
      this.authority = 'unknown';
      return this.fail();
    } finally {
      this.busy = false;
    }
  }

  /** Recheck again inside the Main writer gate before the worker's first write. */
  async verifyCurrent() {
    await this.invoke(async () => {
      await this.broker.ownershipCheck(this.grant);
      this.authority = 'pending';
    });
  }

  /** Call immediately before invoking anything that may mutate ownership. */
  async beforeWrite() {
    await this.invoke(async () => {
      if (this.writes !== 'not-started') return this.fail();
      await this.broker.ownershipCheck(this.grant);
      this.authority = 'pending';
      this.writes = 'uncertain';
    });
  }

  /** Only a successful resolution of all Main writes reaches this boundary. */
  async finishCommitted() {
    await this.invoke(async () => {
      if (this.writes !== 'uncertain') return this.fail();
      this.writes = 'committed';
      await this.broker.ownershipComplete(this.grant, 'committed');
      this.authority = 'completed';
      this.finished = true;
    });
  }

  /** Cleanup is permitted only before any possibly effective write was invoked. */
  async cancelUnwritten() {
    if (this.finished) return this.writes === 'not-started';
    if (this.writes !== 'not-started') return false;
    await this.invoke(async () => {
      await this.broker.ownershipComplete(this.grant, 'not-written');
      this.authority = 'completed';
      this.finished = true;
    });
    return true;
  }
}
