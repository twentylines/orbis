import { ConflictException, Injectable } from '@nestjs/common';
import { transferLimits } from './transfer-transport';

@Injectable()
export class TransferCapacity {
  private readonly source = new Map<symbol, () => boolean>();
  private readonly destination = new Set<symbol>();
  private transferring: symbol | undefined;
  private readonly retentionCleanup = new Set<() => void>();
  registerRetentionCleanup(clean: () => void) {
    this.retentionCleanup.add(clean);
    return () => {
      this.retentionCleanup.delete(clean);
    };
  }
  private prune() {
    for (const clean of this.retentionCleanup) clean();
  }

  reserveSource(active: () => boolean) {
    this.prune();
    if (this.source.size >= transferLimits.jobs || [...this.source.values()].filter((read) => read()).length >= transferLimits.offers)
      throw new ConflictException('Finish or cancel an existing source transfer before creating another.');
    const key = Symbol();
    this.source.set(key, active);
    return () => {
      this.source.delete(key);
    };
  }
  reserveTransfer() {
    if (this.transferring) throw new ConflictException('Wait for the current transfer to finish.');
    const key = Symbol();
    this.transferring = key;
    return () => {
      if (this.transferring === key) this.transferring = undefined;
    };
  }
  reserveDestination() {
    this.prune();
    if (this.destination.size >= transferLimits.jobs) throw new ConflictException('Finish existing transfers before creating another.');
    const key = Symbol();
    this.destination.add(key);
    return () => {
      this.destination.delete(key);
    };
  }
}
