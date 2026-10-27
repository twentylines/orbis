import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRuntimeService } from './backup-runtime.service';

let directory: string;
const config = {
  get: (key: string) =>
    key === 'database'
      ? { host: 'database', username: 'fixture-user', password: 'disposable fixture password', database: 'fixture' }
      : { dataDir: '/data', appDataDir: '/app-data' },
} as ConfigurationService;
const frame = (channel: number, data: Buffer) => {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
};
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-runtime-export-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function databaseStream(chunks: Buffer[], exitCode = 0) {
  const execution = {
    start: vi.fn().mockResolvedValue(Readable.from(chunks)),
    inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: exitCode }),
  };
  const exec = vi.fn().mockResolvedValue(execution);
  const docker = { getContainer: vi.fn().mockReturnValue({ exec }) } as unknown as Dockerode;
  return { runtime: new BackupRuntimeService(config, docker), exec, execution };
}

it('streams fragmented Docker frames into an exact PostgreSQL archive with backpressure and measured bytes', async () => {
  const data = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(256 * 1024, 17)]);
  const wire = Buffer.concat([frame(1, data.subarray(0, 7000)), frame(1, data.subarray(7000))]);
  const chunks: Buffer[] = [];
  for (let start = 0; start < wire.length; start += 317) chunks.push(wire.subarray(start, start + 317));
  const { runtime, exec } = databaseStream(chunks);
  const progress: number[] = [];
  const file = path.join(directory, 'database.dump');
  await runtime.dumpDatabase('db', file, new AbortController().signal, (bytes) => progress.push(bytes));
  expect(await fs.readFile(file)).toEqual(data);
  expect(progress.at(-1)).toBe(data.length);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(exec.mock.calls[0]?.[0].Cmd)).not.toContain('disposable fixture password');
  expect(exec.mock.calls[0]?.[0].Tty).toBe(false);
});

it.each(['stderr', 'exit', 'truncated', 'wrong-format'] as const)('refuses an incomplete database result: %s', async (failure) => {
  const data = failure === 'wrong-format' ? Buffer.from('NOTPGfixture') : Buffer.from('PGDMPfixture');
  const chunks = [frame(1, data), ...(failure === 'stderr' ? [frame(2, Buffer.from('disposable-private-error-detail'))] : [])];
  if (failure === 'truncated') {
    const original = chunks[0];
    if (!original) throw new Error('Missing fixture frame');
    chunks[0] = original.subarray(0, original.length - 2);
  }
  const { runtime } = databaseStream(chunks, failure === 'exit' ? 1 : 0);
  await expect(runtime.dumpDatabase('db', path.join(directory, 'database.dump'), new AbortController().signal, () => undefined)).rejects.toThrow();
  try {
    await runtime.dumpDatabase('db', path.join(directory, 'second.dump'), new AbortController().signal, () => undefined);
  } catch (error) {
    expect(String(error)).not.toContain('disposable-private-error-detail');
  }
});

function planFixture(extraMount?: { Type: string; Source: string; Destination: string; RW: boolean }, dbNetwork = 'private') {
  const self = {
    Id: 'controller',
    Mounts: [
      { Type: 'bind', Source: '/host/runtime/data', Destination: '/data' },
      { Type: 'bind', Source: '/host/runtime/app-data', Destination: '/app-data' },
    ],
    NetworkSettings: { Networks: { private: {} } },
  };
  const app = {
    Id: 'app',
    Name: '/app',
    Config: { Labels: { 'com.docker.compose.project': 'fixture_store' }, Image: 'fixture:1' },
    State: { Running: true },
    NetworkSettings: { Networks: { private: {} } },
    Mounts: [extraMount ?? { Type: 'bind', Source: '/host/runtime/app-data/store/fixture', Destination: '/data', RW: true }],
  };
  const db = {
    Id: 'database',
    Name: '/database',
    Config: { Image: 'postgres:14' },
    State: { Running: true },
    NetworkSettings: { Networks: { [dbNetwork]: { Aliases: ['database'] } } },
    Mounts: [],
  };
  const docker = {
    getContainer: vi.fn((id: string) => ({ inspect: async () => (id === os.hostname() ? self : id === 'app' ? app : db) })),
    listContainers: vi.fn().mockResolvedValue([
      { Id: 'app', Labels: app.Config.Labels },
      { Id: 'database', Labels: {} },
    ]),
  } as unknown as Dockerode;
  return new BackupRuntimeService(config, docker);
}
it('maps only data roots that the export actually includes', async () => {
  expect((await planFixture().plan(['fixture_store'])).containers).toEqual([{ id: 'app', project: 'fixture_store', running: true }]);
  await expect(
    planFixture({ Type: 'bind', Source: '/host/runtime/data/backups', Destination: '/data', RW: true }).plan(['fixture_store']),
  ).rejects.toThrow('external storage');
});
it('refuses Docker volumes and a database from a different network', async () => {
  await expect(planFixture({ Type: 'volume', Source: '/volume', Destination: '/data', RW: true }).plan(['fixture_store'])).rejects.toThrow(
    'Docker volume',
  );
  await expect(planFixture(undefined, 'unrelated').plan(['fixture_store'])).rejects.toThrow('identified safely');
});
