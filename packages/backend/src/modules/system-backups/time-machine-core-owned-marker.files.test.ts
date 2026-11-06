import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createOwnedCoreCaptureMarker, reconcileOwnedCoreCaptureMarker, type OwnedCoreCaptureMarker } from './time-machine-core-owned-marker';

const roots: string[] = [];
const handles: FileHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owned-marker-')));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const parent = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  handles.push(parent);
  const before = await parent.stat({ bigint: true });
  const dir = {
    at: path.join(root, 'source-hold.json'),
    parent,
    binding: [before],
    recheck: async () => {
      const now = await fs.lstat(root, { bigint: true });
      if (!['dev', 'ino', 'uid', 'gid', 'mode'].every((key) => Reflect.get(before, key) === Reflect.get(now, key)))
        throw new Error('directory changed');
    },
  };
  const bytes = Buffer.from('{"expected":"a complete private marker"}');
  return { root, dir, bytes };
}
async function interrupted(prefix: number, syncFailure = false) {
  const f = await fixture();
  let token: OwnedCoreCaptureMarker | undefined;
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === f.dir.at) {
      if (syncFailure) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('injected sync failure'));
      else
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
          if (prefix) await handle.write(f.bytes.subarray(0, prefix));
          throw new Error('injected partial write');
        });
    }
    return handle;
  });
  await expect(
    createOwnedCoreCaptureMarker(f.dir, f.bytes, (owned) => {
      token = owned;
    }),
  ).rejects.toThrow('injected');
  vi.restoreAllMocks();
  if (!token) throw new Error('missing original inode receipt');
  return { ...f, token };
}

it.each([0, 7, 39])('completes its original %i-byte prefix without replacing the inode', async (prefix) => {
  const f = await interrupted(prefix);
  const before = await fs.stat(f.dir.at);
  const result = await reconcileOwnedCoreCaptureMarker(f.dir, f.token, new AbortController().signal);
  expect(result.bytes).toEqual(f.bytes);
  expect(await fs.readFile(f.dir.at)).toEqual(f.bytes);
  expect((await fs.stat(f.dir.at)).ino).toBe(before.ino);
});

it('resyncs an already-complete marker after a failed sync without changing its bytes', async () => {
  const f = await interrupted(0, true);
  const before = await fs.stat(f.dir.at);
  await reconcileOwnedCoreCaptureMarker(f.dir, f.token, new AbortController().signal);
  expect(await fs.readFile(f.dir.at)).toEqual(f.bytes);
  expect((await fs.stat(f.dir.at)).ino).toBe(before.ino);
});

it('refuses altered or oversized contents without overwriting them', async () => {
  for (const value of ['foreign', 'x'.repeat(100)]) {
    const f = await interrupted(7);
    await fs.writeFile(f.dir.at, value);
    await expect(reconcileOwnedCoreCaptureMarker(f.dir, f.token, new AbortController().signal)).rejects.toThrow('review');
    expect(await fs.readFile(f.dir.at, 'utf8')).toBe(value);
  }
});

it('refuses a same-content replacement and preserves the original partial record', async () => {
  const f = await interrupted(7);
  const original = path.join(f.root, 'original');
  await fs.rename(f.dir.at, original);
  await fs.writeFile(f.dir.at, f.bytes.subarray(0, 7), { mode: 0o600 });
  await expect(reconcileOwnedCoreCaptureMarker(f.dir, f.token, new AbortController().signal)).rejects.toThrow();
  expect(await fs.readFile(original)).toEqual(f.bytes.subarray(0, 7));
  expect(await fs.readFile(f.dir.at)).toEqual(f.bytes.subarray(0, 7));
});

it.each(['symlink', 'hardlink', 'permissions'] as const)('refuses a %s and leaves all record bytes untouched', async (mode) => {
  const f = await interrupted(7);
  const other = path.join(f.root, 'other');
  if (mode === 'symlink') {
    await fs.rename(f.dir.at, other);
    await fs.symlink(other, f.dir.at);
  }
  if (mode === 'hardlink') await fs.link(f.dir.at, other);
  if (mode === 'permissions') await fs.chmod(f.dir.at, 0o644);
  await expect(reconcileOwnedCoreCaptureMarker(f.dir, f.token, new AbortController().signal)).rejects.toThrow();
  expect(await fs.readFile(f.dir.at)).toEqual(f.bytes.subarray(0, 7));
});

it('never grants ownership to an existing marker', async () => {
  const f = await fixture();
  await fs.writeFile(f.dir.at, f.bytes, { mode: 0o600 });
  const retain = vi.fn();
  await expect(createOwnedCoreCaptureMarker(f.dir, f.bytes, retain)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(retain).not.toHaveBeenCalled();
});

it('refuses a forged receipt, changed directory binding or cancelled recovery', async () => {
  const f = await interrupted(7);
  await expect(reconcileOwnedCoreCaptureMarker(f.dir, {} as OwnedCoreCaptureMarker, new AbortController().signal)).rejects.toThrow();
  await expect(reconcileOwnedCoreCaptureMarker({ ...f.dir, binding: [] }, f.token, new AbortController().signal)).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(reconcileOwnedCoreCaptureMarker(f.dir, f.token, abort.signal)).rejects.toThrow();
  expect(await fs.readFile(f.dir.at)).toEqual(f.bytes.subarray(0, 7));
});
