import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';

export const verifierMarkerPrefix = 'ORBIS_RESTORE_VERIFY_V1:';
const stages = ['startup', 'env', 'app', 'database', 'recovery', 'activation', 'listen'] as const;
const failures = ['readonly', 'permission', 'missing', 'refused', 'timeout', 'db-auth', 'db-missing', 'schema', 'startup-failed'] as const;
export type VerifierStartupStage = (typeof stages)[number];
export type VerifierDiagnostic = { stage: VerifierStartupStage; failure: (typeof failures)[number] };
const codes: Record<string, VerifierDiagnostic['failure']> = {
  EROFS: 'readonly',
  EACCES: 'permission',
  EPERM: 'permission',
  ENOENT: 'missing',
  ECONNREFUSED: 'refused',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  '28P01': 'db-auth',
  '3D000': 'db-missing',
  '42P01': 'schema',
};
export class VerifierStartupFailure extends Error {
  readonly diagnostic: VerifierDiagnostic;
  constructor(stage: VerifierStartupStage, error: unknown) {
    super('Restore verifier startup failed.');
    let current = error;
    let failure: VerifierDiagnostic['failure'] = 'startup-failed';
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
      const code = Object.getOwnPropertyDescriptor(current, 'code')?.value;
      if (typeof code === 'string' && Object.hasOwn(codes, code)) {
        failure = codes[code] ?? 'startup-failed';
        break;
      }
      current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
    }
    this.diagnostic = { stage, failure };
  }
}
export class VerifierStartupDiagnostics {
  private enabled = false;
  enable() {
    this.enabled = true;
  }
  async run<T>(stage: VerifierStartupStage, action: () => Promise<T>): Promise<T> {
    if (!this.enabled) return action();
    try {
      return await action();
    } catch (error) {
      throw error instanceof VerifierStartupFailure ? error : new VerifierStartupFailure(stage, error);
    }
  }
  get active() {
    return this.enabled;
  }
}
export function verifierStartupMarker(error: VerifierStartupFailure) {
  return `${verifierMarkerPrefix}${JSON.stringify(error.diagnostic)}\n`;
}
export function reportVerifierStartupFailure(error: VerifierStartupFailure, write: (marker: string, finished: () => void) => void, exit: () => void) {
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    clearTimeout(timer);
    exit();
  };
  const timer = setTimeout(finish, 250);
  try {
    write(verifierStartupMarker(error), finish);
  } catch {
    finish();
  }
}
export const verifierDiagnosticCheck = ({ stage, failure }: VerifierDiagnostic) => `verifier-${stage}-${failure}`;
const runtimeChecks = new Set([
  'runtime',
  'verifier-mounts',
  'preparation-phase',
  'not-prepared',
  'container-snapshot',
  'initial-restart-policy',
  'restart-policy',
  'worker-identity',
  'original-image',
  'candidate-network',
  'verifier-network',
  'container-auto-remove',
  'candidate-mounts',
  'worker-mounts',
  'worker-sandbox',
  'verifier-filesystem',
  'verifier-devices',
  'other-writer',
  'environment-phase',
  'verifier-exited',
  'verifier-health',
  'verifier-startup-failed',
  'verifier-diagnostics',
  ...stages.flatMap((stage) => failures.map((failure) => verifierDiagnosticCheck({ stage, failure }))),
]);
export function restoreFailureProgress(error: unknown, stage: string) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const check = Object.getOwnPropertyDescriptor(current, 'runtimeCheck')?.value;
    if (typeof check === 'string' && runtimeChecks.has(check)) return { stage, check };
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return { stage, check: undefined };
}

export class VerifierDiagnosticParser {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private channel = 0;
  private total = 0;
  private line = '';
  private discardLine = false;
  private invalid = false;
  private marker: VerifierDiagnostic | undefined;
  private markers = 0;
  push(raw: Buffer) {
    if (this.invalid) return;
    this.total += raw.length;
    if (this.total > 65536) {
      this.invalid = true;
      this.line = '';
      this.marker = undefined;
      return;
    }
    let offset = 0;
    while (offset < raw.length) {
      if (!this.remaining) {
        const take = Math.min(8 - this.header.length, raw.length - offset);
        this.header = Buffer.concat([this.header, raw.subarray(offset, offset + take)]);
        offset += take;
        if (this.header.length < 8) continue;
        this.channel = this.header[0] ?? 0;
        this.remaining = this.header.readUInt32BE(4);
        if (
          ![1, 2].includes(this.channel) ||
          this.header[1] ||
          this.header[2] ||
          this.header[3] ||
          this.remaining > 65536 - this.total + raw.length
        ) {
          this.invalid = true;
          this.marker = undefined;
          this.line = '';
          return;
        }
        this.header = Buffer.alloc(0);
        if (!this.remaining) continue;
      }
      const take = Math.min(this.remaining, raw.length - offset);
      if (this.channel === 2) this.stderr(raw.subarray(offset, offset + take));
      offset += take;
      this.remaining -= take;
    }
  }
  private stderr(chunk: Buffer) {
    for (const byte of chunk) {
      if (byte === 10) {
        if (!this.discardLine && this.line.startsWith(verifierMarkerPrefix)) {
          try {
            const value: unknown = JSON.parse(this.line.slice(verifierMarkerPrefix.length));
            if (
              value &&
              typeof value === 'object' &&
              Object.keys(value).length === 2 &&
              'stage' in value &&
              'failure' in value &&
              stages.some((stage) => stage === value.stage) &&
              failures.some((failure) => failure === value.failure) &&
              this.line.slice(verifierMarkerPrefix.length).trimEnd() === JSON.stringify({ stage: value.stage, failure: value.failure })
            ) {
              this.markers++;
              this.marker = value as VerifierDiagnostic;
            }
          } catch {
            /* Other stderr is discarded. */
          }
        }
        this.line = '';
        this.discardLine = false;
      } else if (this.line.length >= 512 || (byte !== 13 && (byte < 32 || byte > 126))) {
        this.line = '';
        this.discardLine = true;
      } else if (!this.discardLine) this.line += String.fromCharCode(byte);
    }
  }
  get unusable() {
    return this.invalid;
  }
  result() {
    return !this.invalid && !this.header.length && !this.remaining && this.markers === 1 ? this.marker : undefined;
  }
}
export async function attachVerifierDiagnostics(container: Dockerode.Container, signal: AbortSignal) {
  const connecting = new AbortController();
  const timer = setTimeout(() => connecting.abort(), 2000);
  let stream: Duplex;
  try {
    stream = (await container.attach({
      stream: true,
      stdin: false,
      stdout: false,
      stderr: true,
      logs: false,
      hijack: true,
      abortSignal: AbortSignal.any([signal, connecting.signal]),
    })) as Duplex;
  } finally {
    clearTimeout(timer);
  }
  const parser = new VerifierDiagnosticParser();
  let closed = false;
  const ended = new Promise<void>((resolve) => {
    const finish = () => {
      closed = true;
      resolve();
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
  stream.on('data', (chunk: Buffer) => {
    parser.push(Buffer.from(chunk));
    if (parser.unusable) stream.destroy();
  });
  const close = () => stream.destroy();
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return {
    async finish() {
      if (!closed) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ended,
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 250);
          }),
        ]).finally(() => clearTimeout(deadline));
      }
      return parser.result();
    },
    close() {
      signal.removeEventListener('abort', close);
      stream.destroy();
    },
  };
}
