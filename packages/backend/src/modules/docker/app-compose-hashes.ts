import { spawn } from 'node:child_process';
import { appComposeEnvironment } from './app-compose-environment';

const failure = () => new Error('The installed app configuration could not be matched to its deployment.');
const flags = new Set(['--env-file', '--profile', '--project-name', '--project-directory', '--file', '-f', '-p']);

/** Read-only Compose parsing. A frozen invocation may pass its already-open config as descriptor 3. */
export async function readComposeServiceHashes(args: readonly string[], descriptor?: number, signal?: AbortSignal): Promise<Record<string, string>> {
  if (
    !args.length ||
    args.length > 64 ||
    args.length % 2 ||
    args.some(
      (value, index) => typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value) || (index % 2 === 0 && !flags.has(value)),
    ) ||
    (descriptor !== undefined && (!Number.isSafeInteger(descriptor) || descriptor < 0))
  )
    throw failure();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker-compose', [...args, 'config', '--hash', '*'], {
        env: appComposeEnvironment(true),
        stdio: descriptor === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', descriptor],
        timeout: 30_000,
        killSignal: 'SIGKILL',
        signal,
      });
    } catch {
      reject(failure());
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errors = 0;
    let failed = false;
    child.stdout?.on('data', (body: Buffer) => {
      bytes += body.length;
      if (bytes > 64 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      } else chunks.push(Buffer.from(body));
    });
    // Discard diagnostics: interpolation errors can include private app values.
    child.stderr?.on('data', (body: Buffer) => {
      errors += body.length;
      if (errors > 256 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      failed = true;
      reject(failure());
    });
    child.once('close', (code, exitSignal) => {
      try {
        if (failed || code !== 0 || exitSignal || signal?.aborted) throw failure();
        const result = new Map<string, string>();
        const lines = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim().split('\n');
        if (!lines.length || lines.length > 256) throw failure();
        for (const line of lines) {
          const match = /^([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}) ([a-f0-9]{64})$/.exec(line.trim());
          if (!match?.[1] || !match[2] || result.has(match[1])) throw failure();
          result.set(match[1], match[2]);
        }
        resolve(Object.fromEntries(result));
      } catch {
        reject(failure());
      }
    });
  });
}
