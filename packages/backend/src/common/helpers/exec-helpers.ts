import { execFile, spawn } from 'node:child_process';
import type { ExecFileOptions, SpawnOptionsWithoutStdio } from 'node:child_process';
import { promisify } from 'node:util';

type ExecFileAsyncParams = [command: string, args?: string[], options?: ExecFileOptions];

type ExecResult = { stdout: string; stderr: string };

const promisifiedExecFile = promisify(execFile);

export const execFileAsync = async (...args: ExecFileAsyncParams): Promise<ExecResult> => {
  const [command, cmdArgs = [], options = {}] = args;

  if (!command) {
    throw new Error('Command cannot be empty');
  }

  try {
    const { stdout, stderr } = await promisifiedExecFile(command, cmdArgs, {
      ...options,
      encoding: 'utf-8',
    });

    return { stdout, stderr };
  } catch (error) {
    if (error instanceof Error) {
      return { stderr: error.message, stdout: '' };
    }

    return { stderr: String(error), stdout: '' };
  }
};

export const spawnAsync = async (command: string, args: string[], options: SpawnOptionsWithoutStdio = {}) =>
  new Promise<ExecResult>((resolve) => {
    const { signal, ...spawnOptions } = options;
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'Operation was cancelled.' });
      return;
    }
    const processGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: processGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let processError = '';
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (killSignal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (processGroup) process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processError ||= 'Could not terminate the command.';
      }
    };
    const abort = () => {
      kill('SIGTERM');
      escalation ??= setTimeout(() => {
        kill('SIGKILL');
      }, 2000);
      escalation.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      processError = error.message;
    });

    child.on('exit', (code, exitSignal) => {
      if (signal?.aborted || code !== 0 || exitSignal) kill('SIGKILL');
    });

    child.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (escalation) clearTimeout(escalation);
      if (processError) stderr = processError;
      if (signal?.aborted) stderr ||= 'Operation was cancelled.';
      else if ((code !== 0 || exitSignal) && !stderr) {
        stderr = exitSignal ? `Command terminated by ${exitSignal}` : `Command failed with exit code ${code}`;
      }

      resolve({ stdout, stderr });
    });
  });
