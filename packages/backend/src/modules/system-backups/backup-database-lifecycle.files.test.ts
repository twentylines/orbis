import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { BackupRequirementError } from './backup-files';
import { BackupDatabaseService } from './backup-database.service';

const exec = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./backup-docker-exec', async (load) => {
  const actual = await load<typeof import('./backup-docker-exec')>();
  return { ...actual, backupDockerExec: exec.run };
});

const image = `sha256:${'a'.repeat(64)}`;
const label = 'io.orbis.backup-database-review';
type SandboxInfo = {
  Name: string;
  Image: string;
  Config: { User?: string; NetworkDisabled?: boolean; Labels: Record<string, string> };
  HostConfig: Dockerode.HostConfig;
  Mounts: { Type: 'bind' | 'tmpfs'; Source?: string; Destination?: string }[];
  State: { Running: boolean };
};
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-database-lifecycle-')));
  await fs.chmod(root, 0o700);
  exec.run.mockReset();
  exec.run.mockResolvedValue(0);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const data = path.join(root, 'data');
  const content = path.join(root, 'content');
  const destination = path.join(root, 'normalized');
  const storage = path.join(data, 'backups', 'database-review');
  const journal = path.join(storage, 'sandbox.json');
  const databaseId = 'b'.repeat(64);
  const network = { 'fixture-network': { Aliases: ['database.fixture'], IPAddress: '192.0.2.3' } };
  let sandboxInfo: SandboxInfo | undefined;
  let adjust: (info: SandboxInfo) => void = () => undefined;
  const sandbox = {
    inspect: vi.fn(async () => {
      if (!sandboxInfo) throw Object.assign(new Error('Disposable missing container'), { statusCode: 404 });
      return sandboxInfo;
    }),
    start: vi.fn(async () => {
      if (sandboxInfo) sandboxInfo.State.Running = true;
    }),
    remove: vi.fn(async (_options: unknown) => {
      sandboxInfo = undefined;
    }),
  };
  const docker = {
    getContainer: vi.fn((name: string) => {
      if (name === os.hostname()) return { inspect: vi.fn(async () => ({ NetworkSettings: { Networks: network } })) };
      if (name === databaseId)
        return {
          inspect: vi.fn(async () => ({
            Id: databaseId,
            Name: '/database.fixture',
            Image: image,
            NetworkSettings: { Networks: network },
            State: { Running: true, Paused: false, Restarting: false },
            Config: { Image: 'postgres:16-alpine' },
          })),
        };
      return sandbox;
    }),
    listContainers: vi.fn(async () => [{ Id: databaseId, NetworkSettings: { Networks: network } }]),
    getImage: vi.fn(() => ({ inspect: vi.fn(async () => ({ Id: image, Config: { Volumes: { '/var/lib/postgresql/data': {} } } })) })),
    createContainer: vi.fn(async (options: Dockerode.ContainerCreateOptions) => {
      if (!options.Image || !options.HostConfig) throw new Error('Disposable sandbox configuration is incomplete');
      sandboxInfo = {
        Name: `/${options.name}`,
        Image: options.Image,
        Config: { User: options.User, NetworkDisabled: options.NetworkDisabled, Labels: options.Labels ?? {} },
        HostConfig: structuredClone(options.HostConfig),
        Mounts: [],
        State: { Running: false },
      };
      adjust(sandboxInfo);
      return sandbox;
    }),
  };
  const config = {
    get: (name: string) => (name === 'directories' ? { dataDir: data } : name === 'database' ? { host: 'database.fixture' } : undefined),
  };
  const service = new BackupDatabaseService(config as unknown as ConfigurationService, docker as unknown as Dockerode);
  return {
    service,
    docker,
    sandbox,
    data,
    content,
    destination,
    storage,
    journal,
    adjust: (change: typeof adjust) => {
      adjust = change;
    },
    orphan: (info: Pick<SandboxInfo, 'Name' | 'Image' | 'Config'> | undefined) => {
      sandboxInfo = info ? { ...info, HostConfig: {}, Mounts: [], State: { Running: true } } : undefined;
    },
  };
}
async function prepareContent(test: ReturnType<typeof fixture>) {
  await fs.mkdir(test.content, { mode: 0o700 });
  await fs.writeFile(path.join(test.content, 'recovery.json'), JSON.stringify({ jwtSecret: 'disposable-local-review-key' }), { mode: 0o600 });
  await fs.writeFile(path.join(test.content, 'database.dump'), 'PGDMPdisposable fixture', { mode: 0o600 });
}
async function orphanJournal(test: ReturnType<typeof fixture>) {
  const owner = { version: 1, name: `orbis-database-review-${randomUUID()}`, nonce: randomUUID(), image };
  await fs.mkdir(test.storage, { recursive: true, mode: 0o700 });
  await fs.writeFile(test.journal, JSON.stringify(owner), { mode: 0o600 });
  return owner;
}
const runReview = (test: ReturnType<typeof fixture>, signal = new AbortController().signal) =>
  test.service.review(test.content, test.destination, signal, () => undefined);
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function user() {
  const encoded = (bytes: number) => Buffer.alloc(bytes, 3).toString('base64').replace(/=+$/, '');
  return {
    id: 1,
    username: 'fixture@example.invalid',
    password: `$argon2id$v=19$m=65536,t=3,p=4$${encoded(16)}$${encoded(32)}`,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    operator: true,
    totp_secret: null,
    totp_enabled: false,
    salt: null,
    locale: 'en',
    has_seen_welcome: false,
  };
}

it('removes only an exactly owned orphan, including anonymous volumes, then durably clears its journal', async () => {
  const test = fixture();
  const owner = await orphanJournal(test);
  test.orphan({ Name: `/${owner.name}`, Image: owner.image, Config: { Labels: { [label]: owner.nonce } } });
  await test.service.onModuleInit();
  expect(test.sandbox.remove).toHaveBeenCalledWith(expect.objectContaining({ force: true, v: true }));
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(test.docker.createContainer).not.toHaveBeenCalled();
});

it.each(['name', 'label', 'image'] as const)('preserves a foreign orphan and journal on %s mismatch', async (kind) => {
  const test = fixture();
  const owner = await orphanJournal(test);
  const original = digest(await fs.readFile(test.journal));
  const info = { Name: `/${owner.name}`, Image: owner.image, Config: { Labels: { [label]: owner.nonce } } };
  if (kind === 'name') info.Name = '/unrelated-container';
  if (kind === 'label') info.Config.Labels[label] = randomUUID();
  if (kind === 'image') info.Image = `sha256:${'c'.repeat(64)}`;
  test.orphan(info);
  await expect(test.service.onModuleInit()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(test.sandbox.remove).not.toHaveBeenCalled();
  expect(digest(await fs.readFile(test.journal)) === original).toBe(true);
});

it('clears a valid stale journal when its sandbox already disappeared', async () => {
  const test = fixture();
  await orphanJournal(test);
  await test.service.onModuleInit();
  expect(test.sandbox.remove).not.toHaveBeenCalled();
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['malformed-json', 'null-json', 'unsafe-permissions'] as const)('fails closed on an unsafe journal: %s', async (kind) => {
  const test = fixture();
  await orphanJournal(test);
  if (kind === 'malformed-json') await fs.writeFile(test.journal, '{');
  if (kind === 'null-json') await fs.writeFile(test.journal, 'null');
  if (kind === 'unsafe-permissions') await fs.chmod(test.journal, 0o644);
  await expect(test.service.onModuleInit()).rejects.toBeInstanceOf(BackupRequirementError);
  expect(test.sandbox.remove).not.toHaveBeenCalled();
  expect(test.docker.createContainer).not.toHaveBeenCalled();
  expect((await fs.stat(test.journal)).isFile()).toBe(true);
});

it.each(['bind-mount', 'missing-tmpfs', 'writable-root', 'host-network', 'privileged', 'logging'] as const)(
  'refuses to start after isolation mismatch: %s',
  async (kind) => {
    const test = fixture();
    await prepareContent(test);
    test.adjust((info) => {
      if (kind === 'bind-mount') info.Mounts = [{ Type: 'bind', Source: '/disposable-fixture', Destination: '/host' }];
      if (kind === 'missing-tmpfs') {
        const mounts = info.HostConfig.Tmpfs;
        if (!mounts) throw new Error('Disposable tmpfs configuration is missing');
        delete mounts['/sandbox'];
      }
      if (kind === 'writable-root') info.HostConfig.ReadonlyRootfs = false;
      if (kind === 'host-network') info.HostConfig.NetworkMode = 'host';
      if (kind === 'privileged') info.HostConfig.Privileged = true;
      if (kind === 'logging') {
        const logging = info.HostConfig.LogConfig;
        if (!logging) throw new Error('Disposable logging configuration is missing');
        logging.Type = 'json-file';
      }
    });
    await expect(runReview(test)).rejects.toBeInstanceOf(BackupRequirementError);
    expect(test.sandbox.start).not.toHaveBeenCalled();
    expect(exec.run).not.toHaveBeenCalled();
    expect(test.sandbox.remove).toHaveBeenCalledWith(expect.objectContaining({ force: true, v: true }));
    await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('persists ownership before creating any sandbox', async () => {
  const test = fixture();
  await prepareContent(test);
  test.adjust(() => {
    throw new Error('Disposable creation checkpoint');
  });
  test.docker.createContainer.mockImplementationOnce(async (options) => {
    const owner = JSON.parse(await fs.readFile(test.journal, 'utf8'));
    expect(owner.name === options.name && owner.image === options.Image && owner.nonce === options.Labels?.[label]).toBe(true);
    expect((await fs.stat(test.journal)).mode & 0o077).toBe(0);
    throw new Error('Disposable creation checkpoint');
  });
  await expect(runReview(test)).rejects.toBeInstanceOf(BackupRequirementError);
  expect(test.docker.createContainer).toHaveBeenCalledTimes(1);
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('never publishes a partial ownership journal after a failed temporary write', async () => {
  const test = fixture();
  await prepareContent(test);
  const actualOpen = fs.open.bind(fs);
  let injected = false;
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await actualOpen(...args);
    if (!injected && typeof args[0] === 'string' && path.dirname(args[0]) === test.storage && path.basename(args[0]).endsWith('.tmp')) {
      injected = true;
      const actualWrite = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
        await actualWrite('{"version":1');
        throw Object.assign(new Error('Disposable temporary write failure'), { code: 'EIO' });
      });
    }
    return file;
  });
  await expect(runReview(test)).rejects.toMatchObject({ code: 'EIO' });
  open.mockRestore();
  expect(injected).toBe(true);
  expect(test.docker.createContainer).not.toHaveBeenCalled();
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(test.storage)).toEqual([]);
  const restarted = fixture();
  await expect(restarted.service.onModuleInit()).resolves.toBeUndefined();
  expect(restarted.sandbox.remove).not.toHaveBeenCalled();
});

it('preserves a preexisting destination even when the review fails', async () => {
  const test = fixture();
  await prepareContent(test);
  await fs.mkdir(test.destination, { mode: 0o700 });
  const marker = path.join(test.destination, 'keep');
  await fs.writeFile(marker, 'preserve existing contents', { mode: 0o600 });
  const original = digest(await fs.readFile(marker));
  await expect(runReview(test)).rejects.toBeInstanceOf(BackupRequirementError);
  expect(digest(await fs.readFile(marker)) === original).toBe(true);
  expect(await fs.readdir(test.destination)).toEqual(['keep']);
  expect(test.sandbox.remove).toHaveBeenCalledTimes(1);
});

it('still removes its sandbox when failed destination cleanup itself throws', async () => {
  const test = fixture();
  await prepareContent(test);
  exec.run.mockImplementation(async (options: { command: string[]; stdout: (chunk: Buffer) => Promise<void> }) => {
    if (options.command[0] === 'psql') await options.stdout(Buffer.from('{}\n'));
    return 0;
  });
  const actualRemove = fs.rm.bind(fs);
  vi.spyOn(fs, 'rm').mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === test.destination) throw Object.assign(new Error('Disposable removal failure'), { code: 'EIO' });
    return actualRemove(...args);
  });
  await expect(runReview(test)).rejects.toMatchObject({ code: 'EIO' });
  expect(test.sandbox.remove).toHaveBeenCalledWith(expect.objectContaining({ force: true, v: true }));
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['caller', 'shutdown'] as const)('removes the sandbox after %s cancellation with a fresh cleanup signal', async (kind) => {
  const test = fixture();
  await prepareContent(test);
  const entered = deferred();
  const controller = new AbortController();
  exec.run.mockImplementation(async (options: { command: string[]; signal: AbortSignal }) => {
    if (options.command[0] === 'pg_restore') {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    return 0;
  });
  const reviewing = runReview(test, controller.signal);
  const rejected = expect(reviewing).rejects.toThrow();
  await entered.promise;
  if (kind === 'caller') controller.abort();
  else await test.service.onModuleDestroy();
  await rejected;
  expect(test.sandbox.remove).toHaveBeenCalledTimes(1);
  const cleanup = test.sandbox.remove.mock.calls[0]?.[0] as { force: boolean; v: boolean; abortSignal: AbortSignal } | undefined;
  expect(cleanup?.force).toBe(true);
  expect(cleanup?.v).toBe(true);
  expect(cleanup?.abortSignal.aborted).toBe(false);
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(test.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('writes private normalized rows and matching metadata, then removes the sandbox', async () => {
  const test = fixture();
  await prepareContent(test);
  exec.run.mockImplementation(async (options: { command: string[]; stdout: (chunk: Buffer) => Promise<void> }) => {
    if (options.command[0] === 'psql' && options.command.at(-1)?.includes('FROM public."user"'))
      await options.stdout(Buffer.from(`${JSON.stringify(user())}\n`));
    return 0;
  });
  const result = await runReview(test);
  const rows = path.join(test.destination, 'records.ndjson');
  const metadata = path.join(test.destination, 'records.json');
  const data = await fs.readFile(rows);
  const saved = JSON.parse(await fs.readFile(metadata, 'utf8'));
  expect(result.counts).toEqual({ user: 1, app_store: 0, app: 0, link: 0 });
  expect(result.bytes).toBe(data.length);
  expect(result.sha256 === digest(data)).toBe(true);
  expect(saved.version).toBe(1);
  expect(saved.bytes).toBe(result.bytes);
  expect(saved.sha256 === result.sha256).toBe(true);
  expect((await fs.stat(rows)).mode & 0o077).toBe(0);
  expect((await fs.stat(metadata)).mode & 0o077).toBe(0);
  expect((await fs.stat(test.destination)).mode & 0o077).toBe(0);
  expect(test.sandbox.remove).toHaveBeenCalledWith(expect.objectContaining({ force: true, v: true }));
  await expect(fs.stat(test.journal)).rejects.toMatchObject({ code: 'ENOENT' });
});
