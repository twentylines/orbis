import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { readComposeServiceHashes } from './app-compose-hashes';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  spawn.mockReset().mockReturnValue(child);
});
it('uses only read-only scoped Compose config with the actual open descriptor', async () => {
  const result = readComposeServiceHashes(['--file', '/proc/self/fd/3'], 71);
  child.stdout.emit('data', Buffer.from('web ' + 'a'.repeat(64) + '\nworker ' + 'b'.repeat(64) + '\n'));
  child.emit('close', 0, null);
  expect(await result).toEqual({ web: 'a'.repeat(64), worker: 'b'.repeat(64) });
  expect(spawn.mock.calls[0]?.[1]).toEqual(['--file', '/proc/self/fd/3', 'config', '--hash', '*']);
  expect(spawn.mock.calls[0]?.[2].stdio).toEqual(['ignore', 'pipe', 'pipe', 71]);
  expect(spawn.mock.calls[0]?.[2].env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
});
it.each(['', 'web bad', 'web ' + 'A'.repeat(64), 'web ' + 'a'.repeat(64) + '\nweb ' + 'b'.repeat(64), 'x '.repeat(40000)])(
  'rejects malformed/oversized output',
  async (body) => {
    const result = readComposeServiceHashes(['--file', '/config']);
    child.stdout.emit('data', Buffer.from(body));
    child.emit('close', 0, null);
    await expect(result).rejects.toThrow('could not be matched');
  },
);
it.each([['up', '-d'], ['--file'], ['--file', 'a\nb'], ['--profile', '*', 'run', 'app']].map((args) => ({ args })))(
  'rejects imperative or unpaired arguments',
  async ({ args }) => {
    await expect(readComposeServiceHashes(args)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  },
);
it('discards child diagnostic values on failure', async () => {
  const result = readComposeServiceHashes(['--file', '/config']);
  child.stderr.emit('data', Buffer.from('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  child.emit('close', 1, null);
  await expect(result).rejects.toThrow('The installed app configuration could not be matched to its deployment.');
});
it('kills excessive diagnostic output and never accepts its later success', async () => {
  const result = readComposeServiceHashes(['--file', '/config']);
  child.stderr.emit('data', Buffer.alloc(262145));
  child.stdout.emit('data', Buffer.from('web ' + 'a'.repeat(64)));
  child.emit('close', 0, null);
  await expect(result).rejects.toThrow();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('does not expose a synchronous child setup diagnostic', async () => {
  spawn.mockImplementationOnce(() => {
    throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');
  });
  await expect(readComposeServiceHashes(['--file', '/config'])).rejects.toThrow(
    'The installed app configuration could not be matched to its deployment.',
  );
});
