import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FullBackupManifest } from './backup-import';
import type { BackupVolumeArchive, BackupVolumeEntry } from './backup-docker-volumes';
import { stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

export const volumeFixtureHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export async function addBackupVolumeFixture(content: string, base: FullBackupManifest) {
  const container = base.containers[0] ?? { id: 'a'.repeat(64), project: 'fixture-app_catalogue', running: true };
  const sourceName = 'disposable-app-volume';
  const key = volumeFixtureHash(`orbis.backup-volume.v1\n${sourceName}`);
  const source = path.join(path.dirname(content), 'volume-fixture-source');
  await fs.mkdir(path.join(source, 'config', 'empty'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(source, 'config', 'settings'), 'disposable volume data');
  await fs.symlink('settings', path.join(source, 'config', 'current'));
  await fs.mkdir(path.join(content, 'volumes'), { mode: 0o700 });
  const archiveName = `volumes/${key}.tar`;
  const inventoryName = `volumes/${key}.inventory.json`;
  execFileSync('tar', [
    ...(process.platform === 'darwin' ? ['--no-fflags'] : []),
    '--format=ustar',
    '-cf',
    path.join(content, archiveName),
    '-C',
    source,
    'config',
  ]);
  await fs.chmod(path.join(content, archiveName), 0o600);
  const entries: BackupVolumeEntry[] = [
    { name: '.', kind: 'directory' },
    { name: 'current', kind: 'symlink', target: 'settings' },
    { name: 'empty', kind: 'directory' },
    { name: 'settings', kind: 'file', bytes: 22, sha256: volumeFixtureHash('disposable volume data') },
    { name: 'runtime.sock', kind: 'socket' },
  ];
  const inventory = { version: 1, key, sourceName, containerId: container.id, entries };
  await fs.writeFile(path.join(content, inventoryName), JSON.stringify(inventory), { mode: 0o600 });
  const digest = async (name: string) => {
    const bytes = await fs.readFile(path.join(content, name));
    return { name, bytes: bytes.length, sha256: volumeFixtureHash(bytes) };
  };
  const archive = { ...(await digest(archiveName)), root: 'config' };
  const inventoryDigest = await digest(inventoryName);
  const volume: BackupVolumeArchive = {
    key,
    sourceName,
    mounts: [{ containerId: container.id, project: container.project, service: 'app', ordinal: 1, target: '/config', readOnly: false }],
    archive,
    inventory: inventoryDigest,
    excludedRuntimeSockets: ['runtime.sock'],
  };
  const manifest: FullBackupManifest = {
    ...base,
    version: 3,
    mediaPolicy: 'preserve-destination',
    containers: base.containers.length ? base.containers : [container],
    files: [
      ...base.files,
      ...[archive, inventoryDigest].map((entry) => ({
        name: entry.name,
        bytes: entry.bytes,
        sha256: entry.sha256,
        mode: 0o600,
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        mtime: 0,
      })),
    ],
    directories: [...base.directories, { name: 'volumes', mode: 0o700, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, mtime: 0 }],
    volumes: [volume],
  };
  const refresh = async (name: string) => {
    const value = await digest(name);
    const file = manifest.files.find((entry) => entry.name === name);
    if (!file) throw new Error('Missing disposable volume fixture');
    Object.assign(file, value);
    Object.assign(name === archiveName ? volume.archive : volume.inventory, value);
    stabilizeExistingDarwinFixtures(content);
  };
  stabilizeExistingDarwinFixtures(content);
  return { manifest, volume, inventory, refresh };
}
