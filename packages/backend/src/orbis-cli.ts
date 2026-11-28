import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { appJobResponseSchema } from '@runtipi/common/schemas/app-job';
import { type } from 'arktype';
import jwt from 'jsonwebtoken';
import { DATA_DIR } from './common/constants';
import { validateAppUrn } from './common/helpers/app-helpers';
import { readCliSecret } from './common/helpers/permissions-helpers';

class ResetError extends Error {}
class AppJobError extends Error {}

const usage = `Usage:
  orbis-cli reset-password
  orbis-cli app backup <app-id>:<store-id>
  orbis-cli app update <app-id>:<store-id> [--no-backup]

Updates create an app backup by default. --no-backup skips the optional archive; migrations still create a recovery checkpoint.`;

const cliToken = (secret: string) => jwt.sign({}, secret, { algorithm: 'HS256', subject: 'cli', expiresIn: 60 });

async function recordPasswordChangeRequest(dataDir: string) {
  const state = path.join(dataDir, 'state');
  const marker = path.join(state, 'password-change-request');
  const pending = path.join(state, `.orbis-password-reset-${randomUUID()}`);
  const owned = (stat: { uid: number }) => stat.uid === 0 || stat.uid === process.geteuid?.();
  try {
    const directory = await lstat(state);
    if (!directory.isDirectory() || !owned(directory) || (directory.mode & 0o022) !== 0)
      throw new ResetError('The Orbis state directory is not private.');
    const current = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (current && (!current.isFile() || current.nlink !== 1 || !owned(current)))
      throw new ResetError('The existing password reset request needs review.');

    const file = await open(pending, 'wx', 0o600);
    try {
      try {
        await file.writeFile(String(Math.floor(Date.now() / 1000)));
      } finally {
        await file.close();
      }
      await rename(pending, marker);
    } finally {
      await unlink(pending).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } catch (error) {
    if (error instanceof ResetError) throw error;
    throw new ResetError('Could not create the local password reset request. Check Orbis state storage.');
  }
}

function submitPasswordReset(port: number, secret: string, newPassword: string) {
  const token = cliToken(secret);
  const body = JSON.stringify({ newPassword });
  return new Promise<{ status?: number; confirmed: boolean }>((resolve, reject) => {
    const post = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/auth/reset-password',
        method: 'POST',
        agent: false,
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      async (response) => {
        try {
          const status = response.statusCode;
          if (status !== 201) {
            response.destroy();
            resolve({ status, confirmed: false });
            return;
          }
          response.setEncoding('utf8');
          let text = '';
          for await (const chunk of response) {
            text += chunk;
            if (text.length > 4096) throw new Error('Invalid password reset response');
          }
          resolve({ status, confirmed: JSON.parse(text)?.success === true });
        } catch (error) {
          reject(error);
        }
      },
    );
    post.once('error', reject);
    post.end(body);
  });
}

export async function resetOperatorPassword(dataDir: string, newPassword: string, port = 3000) {
  if (newPassword.length < 8) throw new ResetError('Enter a password with at least eight characters.');
  const secret = readCliSecret(dataDir);
  if (!secret) throw new ResetError('The local Orbis CLI key is unavailable. Start Orbis and check its installation state.');

  await recordPasswordChangeRequest(dataDir);
  const unconfirmed = 'Orbis could not confirm the password reset. Check whether the new password works before retrying.';
  const { status, confirmed } = await submitPasswordReset(port, secret, newPassword).catch(() => {
    throw new ResetError(unconfirmed);
  });
  if (confirmed) return;
  if (status === 401 || status === 403) throw new ResetError('Orbis did not authorize the password reset. Check that the operator account exists.');
  if (status === 409) throw new ResetError('A password reset is already running. Check its result before retrying.');
  throw new ResetError(unconfirmed);
}

async function promptForPassword() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ResetError('Run this command in an interactive terminal.');
  // A terminal readline interface with no output stream accepts editing without echoing input.
  const terminal = createInterface({ input: process.stdin, terminal: true, historySize: 0 });
  const input = new AbortController();
  terminal.on('SIGINT', () => input.abort());
  terminal.on('close', () => input.abort());
  try {
    process.stderr.write('New password: ');
    const password = await terminal.question('', { signal: input.signal });
    process.stderr.write('\nConfirm new password: ');
    const confirmation = await terminal.question('', { signal: input.signal });
    if (password !== confirmation) throw new ResetError('The passwords do not match.');
    return password;
  } catch (error) {
    if (input.signal.aborted) throw new ResetError('Password reset cancelled.');
    throw error;
  } finally {
    terminal.close();
    process.stderr.write('\n');
  }
}

type AppAction = 'backup' | 'update';

function appRequest({
  port,
  secret,
  method,
  route,
  signal,
  body,
}: {
  port: number;
  secret: string;
  method: 'POST' | 'PATCH' | 'GET';
  route: string;
  signal: AbortSignal;
  body?: string;
}) {
  return new Promise<{ status?: number; payload?: unknown }>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(method === 'GET' ? 10_000 : 60_000)]),
        headers: {
          Authorization: `Bearer ${cliToken(secret)}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      async (response) => {
        const status = response.statusCode;
        if (status !== (method === 'POST' ? 201 : 200)) {
          response.destroy();
          resolve({ status });
          return;
        }
        try {
          response.setEncoding('utf8');
          let payload = '';
          for await (const chunk of response) {
            payload += chunk;
            if (payload.length > 4096) throw new Error('App job response exceeds the size limit.');
          }
          resolve({ status, payload: JSON.parse(payload) });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}

const requestIdentity = type({ requestId: /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/ });

export async function runAppJob({
  dataDir,
  action,
  app,
  performBackup = true,
  port = 3000,
  pollIntervalMs = 1000,
  signal,
  write,
}: {
  dataDir: string;
  action: AppAction;
  app: string;
  performBackup?: boolean;
  port?: number;
  pollIntervalMs?: number;
  signal: AbortSignal;
  write: (line: string) => void;
}) {
  try {
    validateAppUrn(app);
  } catch {
    throw new AppJobError('Specify the app as <app-id>:<store-id> using letters, numbers, hyphens, or underscores.');
  }
  const secret = readCliSecret(dataDir);
  if (!secret) throw new AppJobError('The local Orbis CLI key is unavailable. Start Orbis and check its installation state.');
  const urn = encodeURIComponent(app);
  const jobRoute = `/api/app-lifecycle/${urn}`;
  const requestOptions = { port, secret, signal };
  const unconfirmed = 'Orbis could not confirm whether the request was accepted. Check Tasks before retrying.';
  const accepted = await appRequest(
    action === 'backup'
      ? { ...requestOptions, method: 'POST', route: `/api/backups/${urn}/backup` }
      : { ...requestOptions, method: 'PATCH', route: `${jobRoute}/update`, body: JSON.stringify({ performBackup }) },
  ).catch(() => {
    throw new AppJobError(unconfirmed);
  });
  if (accepted.status === 401 || accepted.status === 403) throw new AppJobError('Orbis did not authorize this app operation.');
  if (accepted.status === 404) throw new AppJobError('Orbis could not find the installed app. Check its app ID and store ID.');
  if (accepted.status === 409) throw new AppJobError('Orbis reported a conflict. Check the current app operation in Tasks.');
  if (accepted.status === 400) throw new AppJobError('Orbis did not accept this app operation. Check the app details in Orbis.');
  const identity = requestIdentity(accepted.payload);
  if (identity instanceof type.errors) throw new AppJobError(unconfirmed);

  const { requestId } = identity;
  const review = `Check Tasks for ${requestId}.`;
  const label = action === 'backup' ? 'App backup' : 'App update';
  write(`${label} accepted for ${app} (${requestId}).`);
  const observation = AbortSignal.any([signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]);
  const started = performance.now();
  let lastSeen = started;
  let lastReport = started;
  let previous = '';
  while (!observation.aborted) {
    const response = await appRequest({
      ...requestOptions,
      method: 'GET',
      route: `${jobRoute}/job?requestId=${requestId}`,
      signal: observation,
    }).catch(() => undefined);
    if (response?.status === 401 || response?.status === 403) throw new AppJobError(`Orbis did not authorize the job status check. ${review}`);
    if (response?.status === 200) {
      const result = appJobResponseSchema(response.payload);
      if (result instanceof type.errors) throw new AppJobError(`Orbis returned an invalid job status. ${review}`);
      if (result.job) {
        const job = result.job;
        if (job.requestId !== requestId || job.appUrn !== app || job.command !== action)
          throw new AppJobError(`Orbis returned a different job. ${review}`);
        if (job.status === 'failed' || job.status === 'cancelled') throw new AppJobError(`${label} ${job.status}. ${review}`);
        if (job.status === 'interrupted') throw new AppJobError(`${label} is interrupted. ${review}`);
        if (job.status === 'succeeded') {
          write(`${label} completed for ${app}.`);
          return;
        }
        lastSeen = performance.now();
        const phase = job.phase && job.status !== 'unconfirmed' ? `${job.status}: ${job.phase.replaceAll('_', ' ')}` : job.status;
        if (phase !== previous || lastSeen - lastReport >= 15_000) {
          write(`${label} ${phase} (${Math.floor((lastSeen - started) / 1000)}s elapsed).`);
          previous = phase;
          lastReport = lastSeen;
        }
      }
    } else if (response?.status && response.status < 500) {
      throw new AppJobError(`Orbis did not provide job status. ${review}`);
    }
    if (performance.now() - lastSeen >= 60_000) throw new AppJobError(`Orbis could not confirm the job status. ${review}`);
    await delay(pollIntervalMs, undefined, { signal: observation }).catch(() => undefined);
  }
  throw new AppJobError(`${signal.aborted ? 'Stopped waiting for the job.' : 'Timed out waiting for the job.'} ${review}`);
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === 'reset-password') {
    await resetOperatorPassword(DATA_DIR, await promptForPassword());
    process.stdout.write('The Orbis operator password was reset. Sign in with the new password and set up your sign-in methods again in Security.\n');
    return;
  }
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const [command, action, app, option] = args;
  const skipBackup = action === 'update' && args.length === 4 && option === '--no-backup';
  if (command !== 'app' || (action !== 'backup' && action !== 'update') || !app || (args.length !== 3 && !skipBackup)) throw new AppJobError(usage);
  const wait = new AbortController();
  const stopWaiting = () => wait.abort();
  process.once('SIGINT', stopWaiting);
  try {
    await runAppJob({
      dataDir: DATA_DIR,
      action,
      app,
      performBackup: !skipBackup,
      signal: wait.signal,
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  } finally {
    process.removeListener('SIGINT', stopWaiting);
    if (wait.signal.aborted) process.exitCode = 130;
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof ResetError || error instanceof AppJobError ? error.message : 'Could not complete the command. Check the local Orbis installation.'}\n`,
    );
    process.exitCode ||= 1;
  }
}
