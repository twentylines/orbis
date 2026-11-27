import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import jwt from 'jsonwebtoken';
import { DATA_DIR } from './common/constants';
import { readCliSecret } from './common/helpers/permissions-helpers';

class ResetError extends Error {}

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
  const token = jwt.sign({}, secret, { algorithm: 'HS256', subject: 'cli', expiresIn: 60 });
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

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== 'reset-password') throw new ResetError('Usage: orbis-cli reset-password');
    await resetOperatorPassword(DATA_DIR, await promptForPassword());
    process.stdout.write('The Orbis operator password was reset. Sign in with the new password and set up your sign-in methods again in Security.\n');
  } catch (error) {
    process.stderr.write(
      `${error instanceof ResetError ? error.message : 'Could not reset the Orbis operator password. Check the local Orbis installation.'}\n`,
    );
    process.exitCode = 1;
  }
}
