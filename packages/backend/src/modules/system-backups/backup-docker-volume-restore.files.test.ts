import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackupDockerVolumeRestore, type VolumeRestoreIdentity } from './backup-docker-volume-restore';
import { fullBackupFixture } from './backup-import.fixture';
import { addBackupVolumeFixture, volumeFixtureHash } from './backup-volume.fixture';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volume-restore-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const linux = it.skipIf(process.platform !== 'linux');
const missing = () => Object.assign(new Error('missing'), { statusCode: 404 });
const signal = () => new AbortController().signal;

async function setup() {
  const base = await fullBackupFixture(root);
  const fixture = await addBackupVolumeFixture(base.content, base.manifest);
  const writeManifest = async () => {
    const bytes = Buffer.from(JSON.stringify(fixture.manifest));
    await fs.writeFile(path.join(base.content, 'manifest.json'), bytes, { mode: 0o600 });
    await fs.chmod(path.join(base.content, 'manifest.json'), 0o600);
    return volumeFixtureHash(bytes);
  };
  const identity: VolumeRestoreIdentity = {
    restoreId: randomUUID(),
    nonce: randomUUID(),
    imageId: `sha256:${'a'.repeat(64)}`,
    manifestSha256: await writeManifest(),
  };
  const directory = path.join(root, 'store');
  const volumes = new Map<string, Record<string, unknown>>();
  const containers = new Map<string, { raw: Record<string, unknown>; archive: Buffer }>();
  const removed: string[] = [];
  const states: string[] = [];
  let upload: 'ok' | 'incomplete' | 'ambiguous' | 'block' = 'ok';
  let wrongObservation = false;
  let foreign = false;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const uploading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: identity.imageId, Os: 'linux', Config: {} }) }),
    info: async () => ({ ID: 'fixture-engine' }),
    getVolume: (name: string) => ({
      inspect: async () => {
        const value = volumes.get(name);
        if (!value) throw missing();
        return value;
      },
    }),
    createVolume: async (spec: { Name: string; Labels: Record<string, string> }) => {
      volumes.set(spec.Name, {
        Name: spec.Name,
        Driver: 'local',
        Scope: 'local',
        CreatedAt: '2026-01-01T00:00:00Z',
        Mountpoint: `/var/lib/docker/volumes/${spec.Name}/_data`,
        Options: {},
        Labels: spec.Labels,
      });
    },
    listContainers: async () => [...containers.keys()].map((Id) => ({ Id })).concat(foreign ? [{ Id: 'foreign' }] : []),
    getContainer: (id: string) => ({
      inspect: async () => {
        if (id === 'foreign') return { Id: id, Mounts: [{ Type: 'volume', Name: [...volumes.keys()][0] }] };
        const value = containers.get(id);
        if (!value) throw missing();
        return value.raw;
      },
    }),
    createContainer: async (
      spec: Dockerode.ContainerCreateOptions & { name: string; HostConfig: { Mounts: Array<{ Source: string; Target: string }> } },
    ) => {
      const id = (containers.size + 1).toString(16).padStart(64, '0');
      const mount = spec.HostConfig.Mounts[0];
      if (!mount) throw new Error('missing fixture mount');
      const raw = {
        Id: id,
        Name: `/${spec.name}`,
        Image: spec.Image,
        Config: { ...spec },
        HostConfig: spec.HostConfig,
        Mounts: [{ Type: 'volume', Name: mount.Source, Destination: mount.Target, RW: true }],
        State: { Running: false, Paused: false, Restarting: false, Pid: 0, StartedAt: '0001-01-01T00:00:00Z' },
        NetworkSettings: { Networks: {} },
      };
      const item = { raw, archive: Buffer.alloc(0) };
      containers.set(id, item);
      return {
        id,
        inspect: async () => {
          if (!containers.has(id)) throw missing();
          return raw;
        },
        putArchive: async (stream: Readable) => {
          if (upload === 'block') {
            entered?.();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          if (upload === 'incomplete') return;
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          item.archive = Buffer.concat(chunks);
          if (upload === 'ambiguous') throw new Error('connection lost');
        },
        getArchive: async () => Readable.from([item.archive]),
        remove: async () => {
          removed.push(id);
          containers.delete(id);
        },
      };
    },
  };
  const options = {
    directory,
    identity,
    guard: async () => {
      try {
        const current = JSON.parse(await fs.readFile(path.join(directory, 'current.json'), 'utf8'));
        const attempt = JSON.parse(await fs.readFile(path.join(directory, `${current.generation}.json`), 'utf8'));
        states.push(`${attempt.phase}:${attempt.targets[0].state}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    observe: async (request: { generation: string; targetName: string; phase: 'empty' | 'restored' }) => ({
      generation: request.generation,
      targetName: wrongObservation ? 'foreign' : request.targetName,
      entries:
        request.phase === 'empty'
          ? [{ name: '.', kind: 'directory' as const }]
          : fixture.inventory.entries.filter((entry) => entry.kind !== 'socket'),
      availableBytes: 1024 ** 4,
      availableInodes: 1_000_000,
    }),
  };
  const prepare = (id = identity, abort = signal()) =>
    new BackupDockerVolumeRestore(docker as unknown as Dockerode, { ...options, identity: id }).prepare({ content: base.content, signal: abort });
  return {
    ...base,
    ...fixture,
    directory,
    identity,
    writeManifest,
    volumes,
    containers,
    removed,
    states,
    prepare,
    uploading,
    setUpload: (value: typeof upload) => {
      upload = value;
    },
    setWrong: () => {
      wrongObservation = true;
    },
    setForeign: () => {
      foreign = true;
    },
    release: () => release?.(),
  };
}

it.skipIf(process.platform === 'linux')('refuses preparation on non-Linux before touching Docker or storage', async () => {
  const directory = path.join(root, 'store');
  const restore = new BackupDockerVolumeRestore({} as Dockerode, {
    directory,
    identity: {} as VolumeRestoreIdentity,
    guard: async () => {},
    observe: async () => {
      throw new Error('unexpected');
    },
  });
  await expect(restore.prepare({ content: root, signal: signal() })).rejects.toThrow();
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

linux('prepares fresh storage, records monotonic durable states and freezes the receipt', async () => {
  const f = await setup();
  const result = await f.prepare();
  expect(result.phase).toBe('verified');
  expect(result.targets[0]).toMatchObject({ state: 'ready', sourceName: f.volume.sourceName, uploaderId: '1'.padStart(64, '0') });
  expect(result.targets[0]?.targetName).not.toBe(f.volume.sourceName);
  expect(Object.isFrozen(result) && Object.isFrozen(result.targets) && Object.isFrozen(result.targets[0])).toBe(true);
  const order = ['intent', 'volume-created', 'holder-intent', 'holder-created', 'uploading', 'uploaded', 'verified', 'removing-holder', 'ready'];
  const positions = f.states.filter((state) => state.startsWith('preparing:')).map((state) => order.indexOf(state.split(':')[1] ?? ''));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(positions).toContain(order.indexOf('uploading'));
  const current = JSON.parse(await fs.readFile(path.join(f.directory, 'current.json'), 'utf8'));
  expect(JSON.parse(await fs.readFile(path.join(f.directory, `${current.generation}.json`), 'utf8'))).toEqual(result);
  expect(f.volumes.size).toBe(1);
  expect(f.removed).toEqual(['1'.padStart(64, '0')]);
});

linux.each(['hash', 'tar'])('rejects source %s corruption before allocating a volume', async (kind) => {
  const f = await setup();
  const file = path.join(f.content, f.volume.archive.name);
  const bytes = await fs.readFile(file);
  bytes[148] = 120;
  await fs.writeFile(file, bytes);
  if (kind === 'tar') {
    await f.refresh(f.volume.archive.name);
    f.identity.manifestSha256 = await f.writeManifest();
  }
  await expect(f.prepare()).rejects.toThrow();
  expect(f.volumes.size).toBe(0);
});

linux('rejects reusing a store for a different identity', async () => {
  const f = await setup();
  await f.prepare();
  await expect(f.prepare({ ...f.identity, nonce: randomUUID() })).rejects.toThrow();
  expect(f.volumes.size).toBe(1);
});

linux.each(['observation', 'consumer'])('preserves allocated storage when %s is foreign', async (kind) => {
  const f = await setup();
  if (kind === 'observation') f.setWrong();
  else f.setForeign();
  await expect(f.prepare()).rejects.toThrow();
  expect(f.volumes.size).toBe(1);
  expect(f.removed).toEqual([]);
});

linux.each(['incomplete', 'ambiguous', 'cancelled'])('preserves %s upload and retries to a distinct generation and target', async (kind) => {
  const f = await setup();
  const controller = new AbortController();
  f.setUpload(kind === 'cancelled' ? 'block' : kind === 'incomplete' ? 'incomplete' : 'ambiguous');
  const pending = f.prepare(f.identity, controller.signal);
  if (kind === 'cancelled') {
    await f.uploading;
    controller.abort();
    f.release();
  }
  await expect(pending).rejects.toThrow();
  const old = JSON.parse(await fs.readFile(path.join(f.directory, 'current.json'), 'utf8'));
  const oldAttempt = JSON.parse(await fs.readFile(path.join(f.directory, `${old.generation}.json`), 'utf8'));
  expect(oldAttempt.phase).toBe('ambiguous');
  const oldTarget = oldAttempt.targets[0].targetName;
  expect(f.volumes.has(oldTarget)).toBe(true);
  expect(f.removed).toEqual([]);
  f.setUpload('ok');
  const next = await f.prepare();
  expect(next.generation).not.toBe(old.generation);
  expect(next.targets[0]?.targetName).not.toBe(oldTarget);
  expect(f.volumes.has(oldTarget)).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(f.directory, `${old.generation}.json`), 'utf8'))).toEqual(oldAttempt);
});

linux('rejects a concurrent operation while the store lease is held', async () => {
  const f = await setup();
  f.setUpload('block');
  const pending = f.prepare();
  await f.uploading;
  await expect(f.prepare()).rejects.toThrow();
  f.release();
  await expect(pending).resolves.toMatchObject({ phase: 'verified' });
  expect(f.volumes.size).toBe(1);
});
