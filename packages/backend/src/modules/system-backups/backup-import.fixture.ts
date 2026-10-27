import fs from 'node:fs/promises';
import path from 'node:path';
import { archiveBackup, copyBackupFiles, inventoryBackup } from './backup-files';
import { encryptBackup } from './backup-crypto';
import type { FullBackupManifest } from './backup-import';

export const fixturePassphrase = 'disposable-backup-import-passphrase';

export async function fullBackupFixture(root: string) {
  const source = path.join(root, 'source');
  const content = path.join(root, 'original');
  const archive = path.join(root, 'backup.tar.gz');
  await fs.mkdir(path.join(source, 'state'), { recursive: true });
  await fs.mkdir(path.join(source, 'app-data', 'empty'), { recursive: true });
  await fs.writeFile(path.join(source, 'state', 'seed'), 'disposable fixture seed');
  await fs.writeFile(path.join(source, '.env'), 'DISPOSABLE_TEST_VALUE=true');
  await fs.writeFile(path.join(source, 'app-data', 'document'), 'fixture app content');
  await fs.writeFile(path.join(source, 'app-data', 'empty-file'), '');
  await fs.writeFile(path.join(source, 'app-data', '名'.repeat(40)), 'long UTF-8 filename fixture');
  await fs.mkdir(content, { mode: 0o700 });
  const inventory = await inventoryBackup(
    [
      { name: 'data/state', source: path.join(source, 'state') },
      { name: 'data/.env', source: path.join(source, '.env') },
      { name: 'app-data', source: path.join(source, 'app-data') },
    ],
    new AbortController().signal,
  );
  const files = await copyBackupFiles(inventory, content, new AbortController().signal, () => undefined);
  const manifest: FullBackupManifest = {
    format: 'orbis-full-backup',
    version: 1,
    createdAt: Date.now(),
    orbisVersion: 'v1.0.0',
    runtipiVersion: '4.10.1',
    architecture: 'arm64',
    files,
    directories: inventory.directories,
    containers: [],
    images: [],
    exclusions: ['logs', 'cache', 'previous-backups', 'container-images'],
  };
  await fs.writeFile(path.join(content, 'database.dump'), 'PGDMPdisposable database fixture');
  await fs.writeFile(
    path.join(content, 'recovery.json'),
    JSON.stringify({ jwtSecret: 'disposable-private-recovery-fixture', userSettings: { timeZone: 'UTC' } }),
  );
  const write = async () => {
    await fs.writeFile(path.join(content, 'manifest.json'), JSON.stringify(manifest));
    await fs.rm(archive, { force: true });
    await archiveBackup(content, archive, new AbortController().signal);
    return archive;
  };
  await write();
  const encrypted = path.join(root, 'backup.orbis');
  await encryptBackup({ source: archive, destination: encrypted, passphrase: fixturePassphrase });
  return { source, content, manifest, archive, encrypted, write };
}
