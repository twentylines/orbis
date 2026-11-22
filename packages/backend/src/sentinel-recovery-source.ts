import { captureRecoverySource, recoverySourceCapability, type SourceChannel } from './modules/sentinel-recovery/source-exporter';

/** Length-prefixed private Root pipe. It is never an HTTP or logging protocol. */
export class RecoverySourcePipe implements SourceChannel {
  private readonly iterator = process.stdin[Symbol.asyncIterator]();
  private buffer = Buffer.alloc(0);
  close() {
    // The interactive parent keeps its input open through the terminal receipt.
    // Release our reader only after capture has unwound its SQL/file fences.
    process.stdin.destroy();
    this.buffer = Buffer.alloc(0);
  }
  async send(value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    if (!body.length || body.length > recoverySourceCapability.maxFrameBytes) throw new Error();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    await new Promise<void>((resolve, reject) => process.stdout.write(Buffer.concat([header, body]), (error) => (error ? reject(error) : resolve())));
  }
  async receive(signal: AbortSignal): Promise<unknown> {
    const fill = async (count: number) => {
      while (this.buffer.length < count) {
        signal.throwIfAborted();
        const next = await this.iterator.next();
        if (next.done) throw new Error();
        this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
        if (this.buffer.length > recoverySourceCapability.maxFrameBytes + 4) throw new Error();
      }
    };
    await fill(4);
    const size = this.buffer.readUInt32BE();
    if (!size || size > recoverySourceCapability.maxFrameBytes) throw new Error();
    await fill(size + 4);
    const body = this.buffer.subarray(4, size + 4);
    this.buffer = this.buffer.subarray(size + 4);
    const { readProtectedRecoveryJson } = await import('./modules/sentinel-recovery/identity');
    return readProtectedRecoveryJson(body);
  }
}

if (import.meta.main) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let channel: RecoverySourcePipe | undefined;
  try {
    if (process.argv.length === 3 && process.argv[2] === '--capability') process.stdout.write(`${JSON.stringify(recoverySourceCapability)}\n`);
    else if (process.argv.length === 3 && process.argv[2] === '--capture' && process.platform === 'linux' && process.getuid?.() === 0) {
      timer = setTimeout(() => {
        process.stderr.write('The stopped credential source could not be verified.\n');
        process.exit(1);
      }, recoverySourceCapability.deadlineMs);
      channel = new RecoverySourcePipe();
      await captureRecoverySource({
        input: '/source-input',
        channel,
        signal: AbortSignal.timeout(recoverySourceCapability.deadlineMs),
      });
    } else throw new Error();
  } catch {
    process.stderr.write('The stopped credential source could not be verified.\n');
    process.exitCode = 1;
  } finally {
    channel?.close();
    clearTimeout(timer);
  }
}
