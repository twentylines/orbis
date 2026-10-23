import { Injectable, type OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class MonitoringActivityService implements OnModuleDestroy {
  private viewers = 0;
  private active = false;
  private peerExpiry?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(active: boolean) => void>();

  subscribe(listener: (active: boolean) => void) {
    this.listeners.add(listener);
    listener(this.active);
    return () => this.listeners.delete(listener);
  }

  connect() {
    this.viewers++;
    this.publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.viewers--;
      this.publish();
    };
  }

  touchPeer() {
    clearTimeout(this.peerExpiry);
    this.peerExpiry = setTimeout(() => {
      this.peerExpiry = undefined;
      this.publish();
    }, 45_000);
    this.peerExpiry.unref();
    this.publish();
  }

  private publish() {
    const next = this.viewers > 0 || this.peerExpiry !== undefined;
    if (next === this.active) return;
    this.active = next;
    for (const listener of this.listeners) listener(next);
  }

  onModuleDestroy() {
    clearTimeout(this.peerExpiry);
    this.peerExpiry = undefined;
    this.viewers = 0;
    this.publish();
    this.listeners.clear();
  }
}
