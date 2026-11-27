import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getCliSecret } from '@/common/helpers/permissions-helpers';
import { resetOperatorPassword } from '@/orbis-cli';

let directory: string;
let server: ReturnType<typeof createServer> | undefined;
const password = 'Disposable fixture password';
const stateDirectory = () => join(directory, 'state');
const marker = () => join(stateDirectory(), 'password-change-request');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orbis-cli-'));
  await mkdir(stateDirectory(), { mode: 0o700 });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const local = createServer((request, response) => {
    void Promise.resolve(handle(request, response)).catch(() => {
      response.destroy();
    });
  });
  server = local;
  await new Promise<void>((resolve, reject) => {
    local.once('error', reject);
    local.listen(0, '127.0.0.1', resolve);
  });
  return (local.address() as AddressInfo).port;
}

it('authorizes the existing reset endpoint and refreshes a stale request without changing the key', async () => {
  const secret = await getCliSecret(directory);
  const oldRequest = String(Math.floor(Date.now() / 1000) - 900);
  await writeFile(marker(), oldRequest);
  let handled = false;
  const port = await listen(async (request, response) => {
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/auth/reset-password');
    const bearer = request.headers.authorization?.slice('Bearer '.length) ?? '';
    const token = jwt.verify(bearer, secret, { algorithms: ['HS256'], subject: 'cli' });
    expect(typeof token).toBe('object');
    if (typeof token === 'string') throw new Error('Expected a CLI JWT payload');
    expect((token.exp ?? 0) - (token.iat ?? 0)).toBe(60);
    expect(Number(await readFile(marker(), 'utf8'))).toBeGreaterThan(Number(oldRequest));
    expect((await stat(marker())).mode & 0o777).toBe(0o600);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ newPassword: password });
    expect(await readdir(stateDirectory())).toEqual(['password-change-request']);
    await rm(marker());
    handled = true;
    response.writeHead(201).end(JSON.stringify({ success: true }));
  });
  await expect(resetOperatorPassword(directory, password, port)).resolves.toBeUndefined();
  expect(handled).toBe(true);
  expect(await readFile(join(directory, '.secrets', 'cli-secret'), 'utf8')).toBe(secret);
  await expect(readFile(marker())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires a private local CLI key and a valid password before creating a request', async () => {
  await expect(resetOperatorPassword(directory, 'short')).rejects.toThrow('at least eight characters');
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('CLI key is unavailable');
  expect(await readdir(stateDirectory())).toEqual([]);
});

it('refuses a state directory writable by other users', async () => {
  await getCliSecret(directory);
  await chmod(stateDirectory(), 0o777);
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('state directory is not private');
  expect(await readdir(stateDirectory())).toEqual([]);
});

it('refuses to overwrite an existing symbolic link in the request path', async () => {
  await getCliSecret(directory);
  const unrelated = join(directory, 'preserve');
  await writeFile(unrelated, 'unrelated file');
  await symlink(unrelated, marker());
  await expect(resetOperatorPassword(directory, password)).rejects.toThrow('existing password reset request needs review');
  expect(await readFile(unrelated, 'utf8')).toBe('unrelated file');
});

it.each([
  [201, 'an unconfirmed response', 'could not confirm the password reset'],
  [303, 'a redirect to another endpoint', 'could not confirm the password reset'],
  [401, 'an authorization failure', 'did not authorize'],
  [409, 'a simultaneous reset', 'already running'],
  [500, 'a potentially committed recovery failure', 'could not confirm the password reset'],
])('handles HTTP %d with %s without revealing the response content', async (status, _case, message) => {
  await getCliSecret(directory);
  let calls = 0;
  const port = await listen((request, response) => {
    calls++;
    request.resume();
    response.writeHead(status, { Location: '/another-route' }).end(JSON.stringify({ diagnostic: password }));
  });
  const operation = resetOperatorPassword(directory, password, port);
  await expect(operation).rejects.toThrow(message);
  await expect(operation).rejects.not.toThrow(password);
  expect(calls).toBe(1);
  expect(Number(await readFile(marker(), 'utf8'))).toBeGreaterThan(0);
});
