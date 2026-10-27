import fs from 'node:fs';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type Dockerode from 'dockerode';
import { BackupRequirementError } from './backup-files';

const failed = () => new BackupRequirementError('The isolated database review did not complete. No server data has been changed.');

export async function backupDockerExec(options: {
  container: Dockerode.Container;
  command: string[];
  signal: AbortSignal;
  source?: string;
  maxOutputBytes: number;
  stdout: (chunk: Buffer) => Promise<void>;
}) {
  const { container, command, signal, source, maxOutputBytes, stdout } = options;
  signal.throwIfAborted();
  const operation = await container.exec({
    Cmd: command,
    AttachStdin: Boolean(source),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    abortSignal: signal,
  });
  let stream: Duplex | undefined;
  let input: fs.ReadStream | undefined;
  let inputError = false;
  const abort = () => {
    input?.destroy();
    stream?.destroy(failed());
  };
  let header = Buffer.alloc(0);
  let remaining = 0;
  let channel = 0;
  let bytes = 0;
  let errorBytes = 0;
  try {
    stream = await operation.start({ hijack: true, stdin: Boolean(source), abortSignal: signal });
    // Cancellation can destroy the socket while the input file is still opening.
    stream.on('error', () => undefined);
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    if (source) {
      const file = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      input = file.createReadStream();
      signal.throwIfAborted();
      input.once('error', () => {
        inputError = true;
        stream?.destroy(failed());
      });
      input.pipe(stream);
    }
    for await (const raw of stream as AsyncIterable<Buffer>) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining) {
          const take = Math.min(8 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
          offset += take;
          if (header.length < 8) continue;
          channel = header[0] ?? 0;
          if (![1, 2].includes(channel) || header[1] || header[2] || header[3]) throw failed();
          remaining = header.readUInt32BE(4);
          header = Buffer.alloc(0);
          if (remaining > (channel === 1 ? maxOutputBytes - bytes : 64 * 1024 - errorBytes)) throw failed();
          if (!remaining) continue;
        }
        const take = Math.min(remaining, chunk.length - offset);
        if (channel === 1) {
          bytes += take;
          if (bytes > maxOutputBytes) throw failed();
          await stdout(chunk.subarray(offset, offset + take));
        } else {
          errorBytes += take;
          if (errorBytes > 64 * 1024) throw failed();
        }
        offset += take;
        remaining -= take;
      }
    }
    let result = await operation.inspect({ abortSignal: signal });
    const deadline = Date.now() + 3000;
    while (result.Running && Date.now() < deadline) {
      await delay(25, undefined, { signal });
      result = await operation.inspect({ abortSignal: signal });
    }
    if (header.length || remaining || inputError || (input && !input.readableEnded) || result.Running || result.ExitCode !== 0) throw failed();
    signal.throwIfAborted();
    return bytes;
  } finally {
    signal.removeEventListener('abort', abort);
    input?.unpipe();
    input?.destroy();
    stream?.destroy();
  }
}

export class BackupDatabaseLines {
  private parts: Buffer[] = [];
  private bytes = 0;
  private total = 0;
  private rows = 0;
  constructor(
    private readonly limits: { rowBytes: number; totalBytes: number; rows: number },
    private readonly accept: (value: unknown) => Promise<void>,
  ) {}

  async write(chunk: Buffer) {
    this.total += chunk.length;
    if (this.total > this.limits.totalBytes) throw failed();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.bytes += part.length;
      if (this.bytes > this.limits.rowBytes) throw failed();
      this.parts.push(part);
      if (newline < 0) break;
      if (!this.bytes || ++this.rows > this.limits.rows) throw failed();
      const line = Buffer.concat(this.parts, this.bytes);
      this.parts = [];
      this.bytes = 0;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      } catch {
        throw failed();
      }
      await this.accept(value);
      offset = newline + 1;
    }
  }

  finish() {
    if (this.bytes || this.parts.length) throw failed();
  }
}
