import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectFullBackup } from './backup-import';
import { readTarArchive } from '@/core/archive/tar-metadata';
import { fullBackupFixture } from './backup-import.fixture';

let root: string;
const target = { orbisVersion: 'v1.0.0', runtipiVersion: '4.10.1', architecture: 'arm64' };
const inspect = (archive: string, destination = path.join(root, 'inspected'), maximum = 16 * 1024 * 1024, signal = new AbortController().signal) =>
  inspectFullBackup({ archive, destination, maxExpandedBytes: maximum, signal, target });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-import-files-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { force: true, recursive: true });
});

it('stops tiny-file expansion before its allocated-block quota is exhausted', async () => {
  const fixture = await fullBackupFixture(root);
  const hash = createHash('sha256').update('x').digest('hex');
  for (let index = 0; index < 300; index++) {
    const name = `app-data/tiny-${index}`;
    const file = path.join(fixture.content, name);
    await fs.writeFile(file, 'x');
    const stat = await fs.stat(file);
    fixture.manifest.files.push({ name, bytes: 1, sha256: hash, mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, mtime: stat.mtimeMs });
  }
  await fixture.write();
  const quota = 1024 * 1024;
  expect(gunzipSync(await fs.readFile(fixture.archive)).length).toBeLessThan(quota);
  const destination = path.join(root, 'quota');
  const actualStatfs = fs.statfs.bind(fs);
  const allocated = async (directory: string): Promise<number> => {
    let total = 0;
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, child.name);
      total += (await fs.lstat(file)).blocks * 512;
      if (child.isDirectory()) total += await allocated(file);
    }
    return total;
  };
  vi.spyOn(fs, 'statfs').mockImplementation(async (directory) => {
    const stat = await actualStatfs(directory);
    if (String(directory) !== destination) return stat;
    return { ...stat, bavail: Math.floor((256 * 1024 * 1024 + quota - (await allocated(destination))) / Number(stat.bsize)) };
  });
  await expect(inspect(fixture.archive, destination, quota)).rejects.toThrow('free storage or file entries');
  expect(await allocated(destination)).toBeLessThanOrEqual(quota);
});

it('checks inode availability before creating new extracted files', async () => {
  const fixture = await fullBackupFixture(root);
  const real = await fs.statfs(root);
  vi.spyOn(fs, 'statfs').mockResolvedValue({ ...real, ffree: 64 });
  await expect(inspect(fixture.archive)).rejects.toThrow('file entries');
  expect(await fs.readdir(path.join(root, 'inspected'))).toEqual([]);
});

it('inspects an actual exported tar stream and verifies every file without exposing recovery values', async () => {
  const fixture = await fullBackupFixture(root);
  const result = await inspect(fixture.archive);
  expect(result.review.compatibility.compatible).toBe(true);
  expect(result.review.databaseValidation).toBe('pending');
  expect(result.review.hostIdentityPolicy).toBe('preserve-destination');
  expect(result.review.fileCount).toBe(fixture.manifest.files.length + 3);
  expect(JSON.stringify(result.review)).not.toContain('disposable-private-recovery-fixture');
  expect(await fs.readFile(path.join(root, 'inspected', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
  expect((await fs.stat(path.join(root, 'inspected', 'recovery.json'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(root, 'inspected', 'app-data', 'empty'))).mode & 0o777).toBe(0o700);
});

it.each([
  'changed',
  'missing',
  'unlisted',
  'duplicate-file',
  'duplicate-directory',
  'missing-directory-metadata',
  'bad-permissions',
  'missing-seed',
] as const)('rejects incomplete or inconsistent manifest contents: %s', async (kind) => {
  const fixture = await fullBackupFixture(root);
  if (kind === 'changed') await fs.writeFile(path.join(fixture.content, 'app-data', 'document'), 'different bytes');
  if (kind === 'missing') await fs.rm(path.join(fixture.content, 'app-data', 'document'));
  if (kind === 'unlisted') await fs.writeFile(path.join(fixture.content, 'app-data', 'unlisted'), 'extra');
  if (kind === 'duplicate-file') fixture.manifest.files.push({ ...fixture.manifest.files[0] } as (typeof fixture.manifest.files)[number]);
  if (kind === 'duplicate-directory')
    fixture.manifest.directories.push({ ...fixture.manifest.directories[0] } as (typeof fixture.manifest.directories)[number]);
  if (kind === 'missing-directory-metadata')
    fixture.manifest.directories = fixture.manifest.directories.filter((directory) => directory.name !== 'app-data');
  if (kind === 'bad-permissions') {
    const file = fixture.manifest.files[0];
    if (file) file.mode = 0o4755;
  }
  if (kind === 'missing-seed') {
    fixture.manifest.files = fixture.manifest.files.filter((file) => file.name !== 'data/state/seed');
    await fs.rm(path.join(fixture.content, 'data', 'state', 'seed'));
  }
  await fixture.write();
  await expect(inspect(fixture.archive)).rejects.toThrow('not a complete');
});

it.each([
  ['runtipi-version', 'v1.0.0', '4.11.0'],
  ['newer-orbis', 'v1.1.0', '4.10.1'],
  ['unknown-orbis-version', 'development', '4.10.1'],
])('reports compatibility blocker %s after validating the archive', async (blocker, orbisVersion, runtipiVersion) => {
  const fixture = await fullBackupFixture(root);
  fixture.manifest.orbisVersion = orbisVersion ?? '';
  fixture.manifest.runtipiVersion = runtipiVersion ?? '';
  await fixture.write();
  const result = await inspect(fixture.archive);
  expect(result.review.compatibility.blockers).toContain(blocker);
  expect(result.review.compatibility.compatible).toBe(false);
});

const tarMember = (name: string, kind = '0', data = Buffer.alloc(0), link = '', declaredSize = data.length) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.fill(32, 148, 156);
  header.write(kind, 156);
  header.write(link, 157, 100);
  header.write('ustar\0', 257);
  header.write(
    `${header
      .reduce((total, byte) => total + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    8,
  );
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};
it.each([
  ['../outside', '0', ''],
  ['/outside', '0', ''],
  ['app-data/link', '2', '../../outside'],
  ['app-data/hard', '1', 'data/.env'],
  ['data/logs/private', '0', ''],
  ['app-data/device', '3', ''],
  ['app-data/.orbis-restore-11111111-1111-4111-8111-111111111111.previous/old', '0', ''],
  ['data/state/.orbis-restore-11111111-1111-4111-8111-111111111111.incoming/old', '0', ''],
])('rejects unsafe member %s and leaves files outside staging unchanged', async (name, kind, link) => {
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, 'preserve');
  const archive = path.join(root, 'malicious.tar.gz');
  await fs.writeFile(archive, gzipSync(Buffer.concat([tarMember(name ?? '', kind, Buffer.alloc(0), link), Buffer.alloc(1024)])));
  await expect(inspect(archive)).rejects.toThrow();
  expect(await fs.readFile(outside, 'utf8')).toBe('preserve');
});

it('accepts declared recovery-file exclusions while preserving reserved-looking names inside app folders', async () => {
  const fixture = await fullBackupFixture(root);
  const name = 'app-data/empty/.orbis-restore-user-file';
  const file = path.join(fixture.content, name);
  const data = Buffer.from('ordinary nested app data');
  await fs.writeFile(file, data);
  const stat = await fs.stat(file);
  fixture.manifest.files.push({
    name,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    mtime: stat.mtimeMs,
  });
  fixture.manifest.exclusions.push('restore-recovery-files');
  await fixture.write();
  expect((await inspect(fixture.archive)).review.databaseValidation).toBe('pending');
  expect(await fs.readFile(path.join(root, 'inspected', name))).toEqual(data);
});

it.each(['single-zero', 'extra-member', 'gzip-member'] as const)('rejects hidden trailing content: %s', async (kind) => {
  const fixture = await fullBackupFixture(root);
  const original = await fs.readFile(fixture.archive);
  const raw = gunzipSync(original);
  let end = 0;
  while (end < raw.length && raw.subarray(end, end + 512).some((byte) => byte !== 0)) {
    const size = Number.parseInt(
      raw
        .subarray(end + 124, end + 136)
        .toString()
        .replace(/\0.*$/s, '')
        .trim(),
      8,
    );
    end += 512 + Math.ceil(size / 512) * 512;
  }
  const extra = Buffer.concat([tarMember('app-data/hidden', '0', Buffer.from('hidden')), Buffer.alloc(1024)]);
  const archive = path.join(root, 'hidden.tar.gz');
  await fs.writeFile(
    archive,
    kind === 'gzip-member'
      ? Buffer.concat([original, gzipSync(extra)])
      : gzipSync(Buffer.concat([raw.subarray(0, end), Buffer.alloc(kind === 'single-zero' ? 512 : 1024), extra])),
  );
  await expect(inspect(archive)).rejects.toThrow('not a complete');
});

it('bounds decompression and rejects sparse metadata before extracting its payload', async () => {
  const archive = path.join(root, 'bomb.tar.gz');
  await fs.writeFile(archive, gzipSync(Buffer.concat([tarMember('app-data/big', '0', Buffer.alloc(100_000)), Buffer.alloc(1024)])));
  await expect(inspect(archive, path.join(root, 'bounded'), 16_384)).rejects.toThrow();
  const record = 'GNU.sparse.size=999999999999\n';
  let pax = `0 ${record}`;
  for (;;) {
    const next = `${Buffer.byteLength(pax)} ${record}`;
    if (next === pax) break;
    pax = next;
  }
  await fs.writeFile(
    archive,
    gzipSync(Buffer.concat([tarMember('PaxHeader', 'x', Buffer.from(pax)), tarMember('app-data/sparse'), Buffer.alloc(1024)])),
  );
  await expect(inspect(archive, path.join(root, 'sparse'))).rejects.toThrow();
  await expect(fs.stat(path.join(root, 'sparse', 'app-data', 'sparse'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not allocate a manifest larger than its bound', async () => {
  const archive = path.join(root, 'large-manifest.tar.gz');
  await fs.writeFile(
    archive,
    gzipSync(Buffer.concat([tarMember('manifest.json', '0', Buffer.alloc(0), '', 64 * 1024 * 1024 + 1), Buffer.alloc(1024)])),
  );
  await expect(inspect(archive, path.join(root, 'large'), 128 * 1024 * 1024)).rejects.toThrow();
  await expect(fs.stat(path.join(root, 'large', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('honours cancellation and validates the gzip trailer after the tar end', async () => {
  const fixture = await fullBackupFixture(root);
  await expect(inspect(fixture.archive, path.join(root, 'cancelled'), 16 * 1024 * 1024, AbortSignal.abort())).rejects.toThrow('cancelled');
  const bytes = await fs.readFile(fixture.archive);
  const info = gunzipSync(bytes, { info: true }) as unknown as { engine: { bytesWritten: number } };
  const last = info.engine.bytesWritten - 8;
  bytes[last] = (bytes[last] ?? 0) ^ 1;
  await fs.writeFile(fixture.archive, bytes);
  await expect(inspect(fixture.archive, path.join(root, 'bad-gzip'))).rejects.toThrow();
});

it('bounds extended-header floods independently of the visible file count', async () => {
  const archive = path.join(root, 'metadata-flood.tar.gz');
  const headers = Array.from({ length: 40 }, () => tarMember('PaxHeader', 'x', Buffer.from('11 atime=1\n')));
  await fs.writeFile(archive, gzipSync(Buffer.concat([...headers, tarMember('app-data/file', '0', Buffer.from('data')), Buffer.alloc(1024)])));
  await expect(readTarArchive(archive, true, undefined, { strict: true, maxEntries: 2, maxExpandedBytes: 1024 * 1024 })).rejects.toThrow(
    'Invalid backup archive',
  );
});
