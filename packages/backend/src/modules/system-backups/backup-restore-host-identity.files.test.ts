import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  captureRestoreHostIdentity,
  preservesRestoreHostPath,
  readRestoreHostIdentity,
  verifyRestoreHostIdentity,
  verifyPreservedTraefik,
} from './backup-restore-host-identity';
import { restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';

let temporary: string;
beforeEach(async () => {
  temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-host-identity-')));
  await fs.chmod(temporary, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});
async function fixture() {
  const roots = {} as Record<RestoreTreeName, string>;
  for (const name of restoreTreeNames) {
    roots[name] = path.join(temporary, name);
    await fs.mkdir(roots[name], { mode: 0o700 });
  }
  return {
    directory: path.join(temporary, 'snapshot'),
    id: randomUUID(),
    roots,
    signal: new AbortController().signal,
    transformClusterSync: vi.fn((bytes: Buffer) => bytes),
  };
}

it('uses a fixed machine-identity allowlist without excluding accounts or app configuration', () => {
  for (const name of [
    'data/traefik/private/acme.json',
    'data/state/cluster.json',
    'data/state/secure-access/authority.json',
    'data/state/cluster-sync/settings.json',
    'data/user-config/tipi-compose.yml',
  ])
    expect(preservesRestoreHostPath(name)).toBe(true);
  for (const name of [
    'data/state/seed',
    'data/state/settings.json',
    'data/state/cluster.json.bak',
    'data/user-config/app/docker-compose.yml',
    'data/apps/example/config.json',
    'app-data/documents/file',
  ])
    expect(preservesRestoreHostPath(name)).toBe(false);
});

it('pins empty network configuration and absence without manufacturing source identity', async () => {
  const test = await fixture();
  const seal = await captureRestoreHostIdentity(test);
  const saved = await readRestoreHostIdentity(test.directory, test.id, seal);
  expect(saved.files).toEqual([]);
  expect(saved.directories).toEqual([]);
  expect(saved.snapshot.original.absent).toEqual([
    'data/state/cluster.json',
    'data/state/secure-access',
    'data/state/cluster-sync',
    'data/user-config/tipi-compose.yml',
  ]);
  await verifyRestoreHostIdentity({ ...test, seal });
  await fs.writeFile(path.join(test.roots.state, 'cluster.json'), '{}');
  await expect(verifyRestoreHostIdentity({ ...test, seal })).rejects.toThrow('could not be preserved');
});

it('preserves opaque private bytes and empty directories with metadata and exact content hashes', async () => {
  const test = await fixture();
  await fs.mkdir(path.join(test.roots.traefik, 'tls'), { mode: 0o750 });
  await fs.mkdir(path.join(test.roots.traefik, 'empty'), { mode: 0o700 });
  const bytes = Buffer.from('destination private identity fixture\0');
  await fs.writeFile(path.join(test.roots.traefik, 'tls', 'certificate'), bytes, { mode: 0o640 });
  await fs.writeFile(path.join(test.roots['user-config'], 'tipi-compose.yml'), 'destination core override', { mode: 0o600 });
  await fs.mkdir(path.join(test.roots.state, 'secure-access'));
  await fs.writeFile(path.join(test.roots.state, 'secure-access', 'authority.json'), 'opaque private authority fixture');
  const seal = await captureRestoreHostIdentity(test);
  const saved = await readRestoreHostIdentity(test.directory, test.id, seal);
  const entry = saved.files.find((value) => value.name === 'data/traefik/tls/certificate');
  if (!entry) throw Error('Missing destination certificate fixture');
  expect(entry).toMatchObject({ mode: 0o640, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(await fs.readFile(entry.inputPath)).toEqual(bytes);
  expect(saved.directories.some((value) => value.name === 'data/traefik/empty')).toBe(true);
  await verifyRestoreHostIdentity({ ...test, seal });
});

it('binds plan reset to the captured destination cluster identity and leaves original bytes unchanged', async () => {
  const test = await fixture();
  const hostId = randomUUID();
  await fs.writeFile(path.join(test.roots.state, 'cluster.json'), JSON.stringify({ id: hostId }));
  await fs.mkdir(path.join(test.roots.state, 'cluster-sync'));
  const original = Buffer.from('{"automatic":true}');
  await fs.writeFile(path.join(test.roots.state, 'cluster-sync', 'settings.json'), original);
  const transformClusterSync = vi.fn((_bytes: Buffer, id: string | undefined) => Buffer.from(JSON.stringify({ id, automatic: false })));
  const seal = await captureRestoreHostIdentity({ ...test, transformClusterSync });
  expect(transformClusterSync).toHaveBeenCalledWith(original, hostId);
  const saved = await readRestoreHostIdentity(test.directory, test.id, seal);
  const entry = saved.files.find((value) => value.name.endsWith('cluster-sync/settings.json'));
  if (!entry) throw Error('Missing destination plans fixture');
  expect(JSON.parse(await fs.readFile(entry.inputPath, 'utf8'))).toEqual({ id: hostId, automatic: false });
  expect(await fs.readFile(path.join(test.roots.state, 'cluster-sync', 'settings.json'))).toEqual(original);
  await verifyRestoreHostIdentity({ ...test, seal });
});

it('refuses unsupported settings sync before any live setting is changed', async () => {
  const test = await fixture();
  await fs.mkdir(path.join(test.roots.state, 'cluster-sync'));
  await fs.writeFile(path.join(test.roots.state, 'cluster-sync', 'future-plans.json'), 'unknown future schema');
  await expect(captureRestoreHostIdentity(test)).rejects.toThrow('could not be preserved');
  expect(await fs.readFile(path.join(test.roots.state, 'cluster-sync', 'future-plans.json'), 'utf8')).toBe('unknown future schema');
  expect(test.transformClusterSync).not.toHaveBeenCalled();
});

it.each(['symlink', 'hardlink', 'wrong-kind'] as const)('refuses unsafe protected %s entries', async (kind) => {
  const test = await fixture();
  const file = path.join(test.roots.state, 'cluster.json');
  if (kind === 'wrong-kind') await fs.mkdir(file);
  else {
    const other = path.join(temporary, 'other');
    await fs.writeFile(other, 'fixture');
    if (kind === 'symlink') await fs.symlink(other, file);
    else await fs.link(other, file);
  }
  await expect(captureRestoreHostIdentity(test)).rejects.toThrow('could not be preserved');
});

it.each(['changed', 'removed', 'added', 'replaced-root'] as const)('rejects %s live protected state before cutover', async (change) => {
  const test = await fixture();
  const file = path.join(test.roots.traefik, 'config');
  await fs.writeFile(file, 'destination');
  const seal = await captureRestoreHostIdentity(test);
  if (change === 'changed') await fs.writeFile(file, 'new operator setting');
  if (change === 'removed') await fs.rm(file);
  if (change === 'added') await fs.writeFile(path.join(test.roots.traefik, 'other'), 'new');
  if (change === 'replaced-root') {
    await fs.rename(test.roots.traefik, `${test.roots.traefik}-previous`);
    await fs.mkdir(test.roots.traefik);
    await fs.writeFile(file, 'destination');
  }
  await expect(verifyRestoreHostIdentity({ ...test, seal })).rejects.toThrow('could not be preserved');
});

it('ignores only this transaction’s reserved Traefik working trees', async () => {
  const test = await fixture();
  const seal = await captureRestoreHostIdentity(test);
  for (const suffix of ['incoming', 'previous']) await fs.mkdir(path.join(test.roots.traefik, `.orbis-restore-${test.id}.${suffix}`));
  await verifyRestoreHostIdentity({ ...test, seal });
  await fs.mkdir(path.join(test.roots.traefik, `.orbis-restore-${randomUUID()}.incoming`));
  await expect(verifyRestoreHostIdentity({ ...test, seal })).rejects.toThrow('could not be preserved');
});

it('rejects snapshot tampering and a different restore generation', async () => {
  const test = await fixture();
  const seal = await captureRestoreHostIdentity(test);
  await expect(readRestoreHostIdentity(test.directory, randomUUID(), seal)).rejects.toThrow('could not be preserved');
  await fs.appendFile(path.join(test.directory, 'snapshot.json'), '\n');
  await expect(readRestoreHostIdentity(test.directory, test.id, seal)).rejects.toThrow('could not be preserved');
});

it('preserved Traefik verification ignores legitimately replaced protected state files', async () => {
  const test = await fixture();
  const cluster = path.join(test.roots.state, 'cluster.json');
  await fs.writeFile(cluster, 'destination membership');
  await fs.writeFile(path.join(test.roots.traefik, 'dynamic.json'), 'destination routes');
  const seal = await captureRestoreHostIdentity(test);
  await fs.rename(cluster, `${cluster}.previous`);
  await fs.writeFile(cluster, 'destination membership');
  await verifyPreservedTraefik({ ...test, seal });
  await expect(verifyRestoreHostIdentity({ ...test, seal })).rejects.toThrow();
});

it.each(['equal-byte-replacement', 'root-mode', 'reserved-name'] as const)('rejects a preserved Traefik %s', async (change) => {
  const test = await fixture();
  const file = path.join(test.roots.traefik, 'dynamic.json');
  await fs.writeFile(file, 'destination routes');
  const seal = await captureRestoreHostIdentity(test);
  if (change === 'equal-byte-replacement') {
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, 'destination routes');
    await fs.rm(`${file}.old`);
  }
  if (change === 'root-mode') await fs.chmod(test.roots.traefik, 0o750);
  if (change === 'reserved-name') await fs.mkdir(path.join(test.roots.traefik, `.orbis-restore-${test.id}.incoming`));
  await expect(verifyPreservedTraefik({ ...test, seal })).rejects.toThrow();
});

it('rejects changes while capturing and never writes transformed settings into the live tree', async () => {
  const test = await fixture();
  await fs.writeFile(path.join(test.roots.state, 'cluster.json'), JSON.stringify({ id: randomUUID() }));
  await fs.mkdir(path.join(test.roots.state, 'cluster-sync'));
  const settings = path.join(test.roots.state, 'cluster-sync', 'settings.json');
  await fs.writeFile(settings, 'original destination plans');
  await expect(
    captureRestoreHostIdentity({
      ...test,
      transformClusterSync: (bytes) => {
        writeFileSync(path.join(test.roots.traefik, 'changed-during-capture'), 'new operator setting');
        return bytes;
      },
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(settings, 'utf8')).toBe('original destination plans');
});
