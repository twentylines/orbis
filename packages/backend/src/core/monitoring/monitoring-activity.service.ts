import { Injectable, type OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class MonitoringActivityService implements OnModuleDestroy {
  private viewers = 0;
  private active = false;
  private lastActiveAt = Date.now();
  private browserExpiry?: ReturnType<typeof setTimeout>;
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

  touchBrowser() {
    clearTimeout(this.browserExpiry);
    this.browserExpiry = setTimeout(() => {
      this.browserExpiry = undefined;
      this.publish();
    }, 75_000);
    this.browserExpiry.unref();
    this.publish();
  }

  isIdleFor(milliseconds: number) {
    return !this.active && Date.now() - this.lastActiveAt >= milliseconds;
  }

  private publish() {
    const next = this.viewers > 0 || this.peerExpiry !== undefined || this.browserExpiry !== undefined;
    if (next || this.active) this.lastActiveAt = Date.now();
    if (next === this.active) return;
    this.active = next;
    for (const listener of this.listeners) listener(next);
  }

  onModuleDestroy() {
    clearTimeout(this.peerExpiry);
    clearTimeout(this.browserExpiry);
    this.peerExpiry = undefined;
    this.browserExpiry = undefined;
    this.viewers = 0;
    this.publish();
    this.listeners.clear();
  }
}
