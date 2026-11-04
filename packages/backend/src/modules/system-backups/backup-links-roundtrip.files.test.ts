import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inventoryBackup, copyBackupFiles, packageBackup } from './backup-files';
import { decryptBackup } from './backup-crypto';
import { inspectFullBackup } from './backup-import';
import { createBackupSourceSeal } from './backup-restore-source';
import { makeReviewedBackupFixture, fileMetadata } from './backup-restore-source.fixture';
import { materializeBackupSource, restoreTreeNames, restoreTreesForManifest, type RestoreTreeName } from './backup-restore-materialize';
import { verifyRestoreFiles } from './backup-restore-files';
import { BackupDirectorySwap } from './backup-directory-swap';

let temporary: string;
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'link-roundtrip-')));
});
afterEach(async () => fs.rm(temporary, { recursive: true, force: true }));
function initializeDarwinFlags(directory: string) {
  if (process.platform !== 'darwin') return;
  execFileSync('/usr/bin/python3', [
    '-c',
    'import os,stat,sys\nfor directory,_,files in os.walk(sys.argv[1],followlinks=False):\n for name in files:\n  file=os.path.join(directory,name); s=os.lstat(file)\n  if stat.S_ISREG(s.st_mode): os.chflags(file,s.st_flags|0x40|0x8000,follow_symlinks=False)',
    directory,
  ]);
}

it.skipIf(process.platform !== 'linux')(
  'captures, encrypts, imports and restores app links without following them or replacing omitted media',
  async () => {
    const signal = new AbortController().signal;
    // SQL normalization is a reviewed fixture; this exercises the real filesystem and encrypted archive pipeline.
    const source = await makeReviewedBackupFixture(temporary);
    const live = path.join(temporary, 'live-app-data');
    await fs.mkdir(path.join(live, 'bin'), { recursive: true, mode: 0o700 });
    const bytes = '#!/bin/sh\nprintf fixture\n';
    await fs.writeFile(path.join(live, 'tool.sh'), bytes, { mode: 0o755 });
    await fs.symlink('../tool.sh', path.join(live, 'bin', 'tool'));
    initializeDarwinFlags(live);
    const inventory = await inventoryBackup([{ name: 'app-data', source: live }], signal, [], { allowAppDataLinksAndSockets: true });
    const files = await copyBackupFiles(inventory, source.content, signal, () => undefined);
    await fs.writeFile(path.join(source.content, 'data/.env'), 'TZ=UTC\n', { mode: 0o600 });
    const manifest = {
      ...source.manifest,
      version: 2 as const,
      mediaPolicy: 'preserve-destination' as const,
      files: [...source.manifest.files, await fileMetadata(source.content, 'data/.env'), ...files],
      directories: [...source.manifest.directories, ...inventory.directories],
      symlinks: inventory.symlinks,
      excludedRuntimeSockets: inventory.excludedRuntimeSockets,
    };
    await fs.writeFile(path.join(source.content, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    expect(
      await fs.lstat(path.join(source.content, 'app-data/bin/tool')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const packaged = path.join(temporary, 'package');
    await fs.mkdir(packaged, { mode: 0o700 });
    const passphrase = 'disposable-roundtrip-key';
    const encrypted = await packageBackup({ directory: packaged, content: source.content, passphrase, signal, progress: () => undefined });
    initializeDarwinFlags(packaged);
    const archive = path.join(temporary, 'decrypted.tar.gz');
    await decryptBackup({ source: encrypted, destination: archive, passphrase, signal });
    const opened = path.join(temporary, 'opened');
    await fs.mkdir(opened, { mode: 0o700 });
    const inspected = await inspectFullBackup({
      archive,
      destination: path.join(opened, 'content'),
      maxExpandedBytes: 16 * 1024 * 1024,
      signal,
      target: { orbisVersion: source.manifest.orbisVersion, runtipiVersion: '4.10.1', architecture: 'arm64' },
    });
    expect(inspected.manifest.symlinks).toEqual(inventory.symlinks);
    expect(inspected.review.mediaPolicy).toBe('preserve-destination');
    expect(inspected.review.fileCount).toBe(manifest.files.length + manifest.symlinks.length + 3);
    await fs.cp(path.join(source.directory, 'database'), path.join(opened, 'database'), { recursive: true });
    initializeDarwinFlags(opened);
    const seal = createBackupSourceSeal(inspected.integrity, source.seal.normalized);
    const roots = {} as Record<RestoreTreeName, string>;
    for (const name of restoreTreeNames) {
      roots[name] = path.join(temporary, `target-${name}`);
      await fs.mkdir(roots[name], { mode: 0o700 });
    }
    const media = path.join(roots.media, 'library.mkv');
    await fs.writeFile(media, 'preserved destination library');
    const mediaInode = (await fs.stat(media)).ino;
    const swap = await BackupDirectorySwap.create({ id: randomUUID(), root: roots['app-data'], journal: path.join(temporary, 'swap') });
    const staged = { ...roots, 'app-data': swap.incomingDirectory };
    const ledger = path.join(temporary, 'files.ndjson');
    const result = await materializeBackupSource({ directory: opened, expected: seal, roots: staged, ledger, signal, progress: () => undefined });
    const selectedRoots = Object.fromEntries(restoreTreesForManifest(manifest).map((name) => [name, staged[name]]));
    await verifyRestoreFiles({ roots: selectedRoots, ledger, expected: result.files, signal });
    expect(await fs.readlink(path.join(staged['app-data'], 'bin/tool'))).toBe('../tool.sh');
    expect(await fs.readFile(path.join(staged['app-data'], 'bin/tool'), 'utf8')).toBe(bytes);
    await swap.seal(signal, { allowAppDataLinks: true });
    await swap.promote(signal);
    await verifyRestoreFiles({ roots: { ...selectedRoots, 'app-data': roots['app-data'] }, ledger, expected: result.files, signal });
    await swap.commit();
    expect((await fs.lstat(path.join(roots['app-data'], 'bin/tool'))).isSymbolicLink()).toBe(true);
    expect(
      createHash('sha256')
        .update(await fs.readFile(path.join(roots['app-data'], 'bin/tool')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await fs.readFile(media, 'utf8')).toBe('preserved destination library');
    expect((await fs.stat(media)).ino).toBe(mediaInode);
  },
);
