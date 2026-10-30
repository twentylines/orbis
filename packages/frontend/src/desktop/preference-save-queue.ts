export class PreferenceSession {
  readonly epoch = {};
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;

  constructor(active: boolean) {
    if (!active) this.invalidate();
  }

  invalidate() {
    this.controller.abort(new Error('Your session changed. Reload your settings before saving.'));
  }
}

export class PreferenceSaveQueue {
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly signal: AbortSignal) {}

  assertCurrent() {
    this.signal.throwIfAborted();
  }

  enqueue(write: () => Promise<void>) {
    const run = async () => {
      this.assertCurrent();
      await write();
    };
    const result = this.pending.then(run, run);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
