import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { encodePinnedCompose } from './app-volume-compose';
import type { AppVolumePins } from './app-volume-pins';

const fail = () => new Error('Restored volume configuration could not be prepared safely.');
const execute = promisify(execFile);
export async function readEffectiveAppCompose(args: readonly string[], signal?: AbortSignal): Promise<unknown> {
  try {
    const { stdout } = await execute('docker-compose', [...args, 'config', '--format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      killSignal: 'SIGKILL',
      signal,
    });
    return JSON.parse(stdout);
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw fail();
  }
}
export async function prepareAppVolumeInvocation(options: { effective: unknown; pins: AppVolumePins; directory: string; projectDirectory: string }) {
  if (
    process.platform !== 'linux' ||
    !path.isAbsolute(options.directory) ||
    !path.isAbsolute(options.projectDirectory) ||
    path.resolve(options.directory) !== options.directory ||
    path.resolve(options.projectDirectory) !== options.projectDirectory
  )
    throw fail();
  const bytes = encodePinnedCompose(options.effective, options.pins);
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(options.directory)) !== options.directory) throw fail();
  const parent = await fs.open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let output: FileHandle | undefined;
  let input: FileHandle | undefined;
  let file: string | undefined;
  try {
    const stat = await parent.stat();
    if (!stat.isDirectory() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw fail();
    file = `/proc/self/fd/${parent.fd}/${randomUUID()}.json`;
    output = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await output.writeFile(bytes);
    input = await fs.open(`/proc/self/fd/${output.fd}`, constants.O_RDONLY);
    const before = await output.stat();
    const after = await input.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || after.size !== bytes.length) throw fail();
    await fs.unlink(file);
    file = undefined;
    await output.close();
    output = undefined;
    const descriptor = input;
    input = undefined;
    let closed = false;
    return {
      args: ['--project-name', options.pins.project, '--project-directory', options.projectDirectory, '--file', '/proc/self/fd/3'],
      fd: descriptor.fd,
      release: async () => {
        if (closed) return;
        closed = true;
        await descriptor.close();
      },
    };
  } finally {
    await output?.close();
    await input?.close();
    if (file) await fs.unlink(file).catch(() => undefined);
    await parent.close();
  }
}
