import { ConflictException, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { CoreCaptureRecovery } from './time-machine-core-recovery';

const unavailable = () => new ConflictException('Snapshot recovery is not ready to continue.');

@Injectable()
export class CoreCaptureRecoveryService implements OnModuleDestroy {
  private recovery?: CoreCaptureRecovery;
  private readonly shutdown = new AbortController();
  readonly signal = this.shutdown.signal;

  register(recovery: CoreCaptureRecovery) {
    if (this.recovery || this.signal.aborted) throw unavailable();
    this.recovery = recovery;
  }

  status(id: string, ownerId: number) {
    try {
      if (!this.recovery) throw unavailable();
      return this.recovery.status(id, ownerId);
    } catch {
      throw unavailable();
    }
  }

  continue(id: string, ownerId: number) {
    if (!this.status(id, ownerId).canContinue || !this.recovery || this.signal.aborted) throw unavailable();
    const attempt = this.recovery.retry(id, ownerId);
    void attempt.catch(() => console.warn('Snapshot recovery needs attention. Orbis remains held.'));
    return { id, state: 'starting' as const };
  }

  onModuleDestroy() {
    this.shutdown.abort();
  }
}
