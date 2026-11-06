import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupDockerVolumes, inspectDockerVolumeArchive, requireLegacyBackupVolumePolicy, type BackupVolumeEntry } from './backup-docker-volumes';

let temporary: string;
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volume-capture-')));
});
afterEach(async () => fs.rm(temporary, { recursive: true, force: true }));

it('does not create a legacy backup that has volume bindings but lacks their data', async () => {
  await expect(requireLegacyBackupVolumePolicy(temporary)).resolves.toBeUndefined();
  const directory = path.join(temporary, 'state', 'app-volume-pins');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await expect(requireLegacyBackupVolumePolicy(temporary)).rejects.toThrow('volume-aware');
  await fs.writeFile(path.join(directory, 'binding.json'), '{}');
  await expect(requireLegacyBackupVolumePolicy(temporary)).rejects.toThrow('volume-aware');
});

it('refuses legacy capture when a dedicated authority exists or its required mount is missing', async () => {
  vi.stubEnv('ORBIS_APP_VOLUME_AUTHORITY', 'orbis.app-volume-authority.v1');
  try {
    await expect(requireLegacyBackupVolumePolicy(temporary)).rejects.toThrow('volume-aware');
    vi.stubEnv('ORBIS_APP_VOLUME_AUTHORITY', 'none');
    await expect(requireLegacyBackupVolumePolicy(temporary)).resolves.toBeUndefined();
    await fs.mkdir(path.join(temporary, 'orbis-volumes'), { mode: 0o700 });
    await expect(requireLegacyBackupVolumePolicy(temporary)).rejects.toThrow('volume-aware');
  } finally {
    vi.unstubAllEnvs();
  }
});
type Member = { name: string; kind?: string; data?: string; link?: string };
function tar(entries: Member[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    const data = Buffer.from(entry.data ?? '');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.kind ?? '0', 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data);
    if (data.length % 512) blocks.push(Buffer.alloc(512 - (data.length % 512)));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const ordinary: Member[] = [
  { name: 'config/', kind: '5' },
  { name: 'config/settings', data: 'application data' },
];
async function inspect(entries: Member[], suffix = Buffer.alloc(0), limit = 1024 * 1024) {
  const file = path.join(temporary, 'archive.tar');
  await fs.writeFile(file, Buffer.concat([tar(entries), suffix]));
  return inspectDockerVolumeArchive(file, 'config', limit, new AbortController().signal);
}

it('checks the complete archive graph without extracting app files onto the host', async () => {
  expect(
    await inspect([...ordinary, { name: 'config/latest', kind: '2', link: 'settings' }, { name: 'config/hard', kind: '1', link: 'config/settings' }]),
  ).toMatchObject({ entries: 4 });
  expect((await fs.readdir(temporary)).sort()).toEqual(['archive.tar']);
});

it('accepts a symlink to a valid hardlinked file even when the link occurs earlier in the tar stream', async () => {
  expect(
    await inspect([
      { name: 'config/', kind: '5' },
      { name: 'config/current', kind: '2', link: 'settings' },
      { name: 'config/hard', data: 'application data' },
      { name: 'config/settings', kind: '1', link: 'config/hard' },
    ]),
  ).toMatchObject({ entries: 4 });
});

it.each([
  ['escaping file', [...ordinary, { name: '../outside', data: 'bad' }]],
  ['absolute file', [...ordinary, { name: '/config/outside', data: 'bad' }]],
  ['foreign root', [...ordinary, { name: 'other/settings', data: 'bad' }]],
  ['duplicate file', [...ordinary, { name: 'config/settings', data: 'bad' }]],
  ['device', [...ordinary, { name: 'config/device', kind: '3' }]],
  ['fifo', [...ordinary, { name: 'config/fifo', kind: '6' }]],
  ['symlink escape', [...ordinary, { name: 'config/link', kind: '2', link: '../../outside' }]],
  ['escape then reenter', [...ordinary, { name: 'config/link', kind: '2', link: '../config/settings' }]],
  ['absolute symlink', [...ordinary, { name: 'config/link', kind: '2', link: '/config/settings' }]],
  ['dangling symlink', [...ordinary, { name: 'config/link', kind: '2', link: 'missing' }]],
  ['symlink chain', [...ordinary, { name: 'config/one', kind: '2', link: 'settings' }, { name: 'config/two', kind: '2', link: 'one' }]],
  ['file below link', [...ordinary, { name: 'config/link', kind: '2', link: 'settings' }, { name: 'config/link/file', data: 'bad' }]],
  ['hardlink escape', [...ordinary, { name: 'config/link', kind: '1', link: '../outside' }]],
  ['forward hardlink', [{ name: 'config/', kind: '5' }, { name: 'config/link', kind: '1', link: 'config/settings' }, ordinary[1]]],
  ['link payload', [...ordinary, { name: 'config/link', kind: '2', link: 'settings', data: 'bad' }]],
] as const)('rejects %s before any restore upload', async (_name, entries) => {
  await expect(inspect([...entries] as Member[])).rejects.toThrow();
});

it('rejects a corrupt checksum, truncated end, trailing payload and exceeded byte budget', async () => {
  const file = path.join(temporary, 'invalid.tar');
  const bytes = tar(ordinary);
  bytes[148] = 120;
  await fs.writeFile(file, bytes);
  await expect(inspectDockerVolumeArchive(file, 'config', 4096, new AbortController().signal)).rejects.toThrow();
  await fs.writeFile(file, tar(ordinary).subarray(0, -512));
  await expect(inspectDockerVolumeArchive(file, 'config', 4096, new AbortController().signal)).rejects.toThrow();
  await expect(inspect(ordinary, Buffer.from('payload'))).rejects.toThrow();
  await expect(inspect(ordinary, Buffer.alloc(0), 1024)).rejects.toThrow();
});

it('requires every independently inventoried file and records only known runtime-socket exclusions', async () => {
  const file = path.join(temporary, 'volume.tar');
  const expected: BackupVolumeEntry[] = [
    { name: '.', kind: 'directory' },
    {
      name: 'settings',
      kind: 'file',
      bytes: Buffer.byteLength('application data'),
      sha256: createHash('sha256').update('application data').digest('hex'),
    },
    { name: 'runtime.sock', kind: 'socket' },
  ];
  const signal = new AbortController().signal;
  await fs.writeFile(file, tar(ordinary));
  expect((await inspectDockerVolumeArchive(file, 'config', 4096, signal, expected)).excludedRuntimeSockets).toEqual(['runtime.sock']);
  await fs.writeFile(file, tar([ordinary[0]] as Member[]));
  await expect(inspectDockerVolumeArchive(file, 'config', 4096, signal, expected)).rejects.toThrow();
  await fs.writeFile(file, tar([ordinary[0], { name: 'config/settings', data: 'changed contents' }] as Member[]));
  await expect(inspectDockerVolumeArchive(file, 'config', 4096, signal, expected)).rejects.toThrow();
  await fs.writeFile(file, tar([...ordinary, { name: 'config/extra', data: 'unlisted' }]));
  await expect(inspectDockerVolumeArchive(file, 'config', 4096, signal, expected)).rejects.toThrow();
});

function fixture() {
  const id = 'a'.repeat(64);
  const project = 'demo_store';
  const volume = { Name: 'application-volume', Driver: 'local', Scope: 'local', CreatedAt: '2026-11-05T00:00:00Z', Options: null, Labels: {} };
  const original = {
    Id: id,
    Image: `sha256:${'b'.repeat(64)}`,
    Config: {
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'server',
        'com.docker.compose.container-number': '1',
        'runtipi.appurn': 'demo:store',
        'runtipi.managed': 'true',
      },
    },
    State: { Running: true, Paused: false, Restarting: false, StartedAt: '2026-11-05T00:00:00Z' },
    Mounts: [{ Type: 'volume', Name: volume.Name, Source: '/never/read/docker/storage', Destination: '/config', RW: true }] as [
      { Type: string; Name: string; Source: string; Destination: string; RW: boolean },
    ],
  };
  const rows = new Map([[id, original]]);
  const archive = vi.fn(async () => Readable.from([tar(ordinary)]));
  const docker = {
    listContainers: vi.fn(async () => [...rows.keys()].map((Id) => ({ Id }))),
    getContainer: vi.fn((Id: string) => ({ inspect: async () => structuredClone(rows.get(Id)), getArchive: archive })),
    getVolume: vi.fn(() => ({ inspect: async () => structuredClone(volume) })),
  };
  const store = new BackupDockerVolumes(docker as unknown as Dockerode);
  const inventories = [
    {
      key: createHash('sha256').update(`orbis.backup-volume.v1\n${volume.Name}`).digest('hex'),
      sourceName: volume.Name,
      containerId: id,
      entries: [
        { name: '.', kind: 'directory' as const },
        {
          name: 'settings',
          kind: 'file' as const,
          bytes: Buffer.byteLength('application data'),
          sha256: createHash('sha256').update('application data').digest('hex'),
        },
      ],
    },
  ];
  return { id, project, volume, original, rows, docker, archive, store, inventories, managed: [{ id, project }] };
}

it('pins a shared local volume once and records each managed consumer without host storage paths', async () => {
  const f = fixture();
  const second = structuredClone(f.original);
  second.Id = 'c'.repeat(64);
  second.Config.Labels['com.docker.compose.container-number'] = '2';
  f.rows.set(second.Id, second);
  const plan = await f.store.plan([...f.managed, { id: second.Id, project: f.project }], new AbortController().signal);
  expect(plan.volumes.length).toBe(1);
  expect(plan.volumes[0]?.mounts.length).toBe(2);
  expect(Object.isFrozen(plan.volumes[0]?.mounts)).toBe(true);
  expect(JSON.stringify(plan)).not.toContain('/never/read');
  expect(f.archive).not.toHaveBeenCalled();
});

it.each(['driver', 'remote-options', 'foreign-consumer', 'nested-mount', 'volume-subpath', 'replica-divergence', 'foreign-owner-label', 'paused'])(
  'refuses %s before stopping apps or downloading data',
  async (change) => {
    const f = fixture();
    if (change === 'driver') f.volume.Driver = 'nfs';
    if (change === 'remote-options') Object.assign(f.volume, { Options: { type: 'nfs' } });
    if (change === 'foreign-owner-label') f.original.Config.Labels['runtipi.managed'] = 'false';
    if (change === 'paused') f.original.State.Paused = true;
    if (change === 'volume-subpath')
      Object.assign(f.original, { HostConfig: { Mounts: [{ Type: 'volume', VolumeOptions: { Subpath: 'nested' } }] } });
    if (change === 'nested-mount') f.original.Mounts.push({ ...f.original.Mounts[0], Destination: '/config/nested' });
    if (change === 'foreign-consumer' || change === 'replica-divergence') {
      const second = structuredClone(f.original);
      second.Id = 'c'.repeat(64);
      second.Config.Labels['com.docker.compose.container-number'] = '2';
      if (change === 'replica-divergence') second.Mounts[0].Name = 'other-volume';
      f.rows.set(second.Id, second);
      if (change === 'replica-divergence') f.managed.push({ id: second.Id, project: f.project });
    }
    await expect(f.store.plan(f.managed, new AbortController().signal)).rejects.toThrow();
    expect(f.archive).not.toHaveBeenCalled();
  },
);

it('refuses forged plans, changed source bindings and late consumers', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const plan = await f.store.plan(f.managed, signal);
  f.original.State.Running = false;
  await expect(f.store.verifyStopped({ ...plan }, signal)).rejects.toThrow();
  await f.store.verifyStopped(plan, signal);
  f.original.Mounts[0].Name = 'substituted-volume';
  await expect(f.store.verifyStopped(plan, signal)).rejects.toThrow();
  f.original.Mounts[0].Name = f.volume.Name;
  f.rows.set('c'.repeat(64), { ...structuredClone(f.original), Id: 'c'.repeat(64) });
  await expect(f.store.verifyStopped(plan, signal)).rejects.toThrow();
});

it('refuses a source that restarted and stopped again after its capture plan', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const plan = await f.store.plan(f.managed, signal);
  f.original.State.Running = false;
  await f.store.verifyStopped(plan, signal);
  f.original.State.StartedAt = '2026-11-05T00:05:00Z';
  await expect(f.store.verifyStopped(plan, signal)).rejects.toThrow();
  expect(f.archive).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux')('captures exact Engine archive bytes only after every consumer stops', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const plan = await f.store.plan(f.managed, signal);
  await expect(
    f.store.capture({ plan, inventories: f.inventories, content: temporary, maximumBytes: 4096, signal, progress: () => undefined }),
  ).rejects.toThrow();
  expect(f.archive).not.toHaveBeenCalled();
  f.original.State.Running = false;
  const progress: number[] = [];
  const records = await f.store.capture({
    plan,
    inventories: f.inventories,
    content: temporary,
    maximumBytes: 4096,
    signal,
    progress: (bytes) => progress.push(bytes),
  });
  expect(records[0]?.archive.sha256).toBe(createHash('sha256').update(tar(ordinary)).digest('hex'));
  expect(await fs.readFile(path.join(temporary, records[0]?.archive.name ?? ''))).toEqual(tar(ordinary));
  const stored = records[0];
  if (!stored) throw new Error('Missing captured volume');
  const inventoryBytes = await fs.readFile(path.join(temporary, stored.inventory.name));
  expect(createHash('sha256').update(inventoryBytes).digest('hex')).toBe(stored.inventory.sha256);
  expect(JSON.parse(inventoryBytes.toString()).entries).toHaveLength(2);
  expect(progress.at(-1)).toBe(tar(ordinary).length + stored.inventory.bytes);
  expect(f.archive).toHaveBeenCalledWith({ path: '/config', abortSignal: expect.any(AbortSignal) });
});

it.skipIf(process.platform !== 'linux')('rejects a directory replacement while keeping writes on the opened directory', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const plan = await f.store.plan(f.managed, signal);
  f.original.State.Running = false;
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  f.archive.mockImplementationOnce(async () => {
    await fs.rename(path.join(temporary, 'volumes'), path.join(temporary, 'original-volumes'));
    await fs.symlink(outside, path.join(temporary, 'volumes'));
    return Readable.from([tar(ordinary)]);
  });
  await expect(
    f.store.capture({ plan, inventories: f.inventories, content: temporary, maximumBytes: 4096, signal, progress: () => undefined }),
  ).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
  expect((await fs.readdir(path.join(temporary, 'original-volumes'))).length).toBe(1);
});

it.skipIf(process.platform !== 'linux')('does not accept a snapshot if a new consumer appears during its download', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const plan = await f.store.plan(f.managed, signal);
  f.original.State.Running = false;
  f.archive.mockImplementationOnce(async () =>
    Readable.from(
      (async function* () {
        yield tar(ordinary);
        f.rows.set('c'.repeat(64), { ...structuredClone(f.original), Id: 'c'.repeat(64) });
      })(),
    ),
  );
  await expect(
    f.store.capture({ plan, inventories: f.inventories, content: temporary, maximumBytes: 4096, signal, progress: () => undefined }),
  ).rejects.toThrow();
});
