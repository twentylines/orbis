import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as commands from '@/common/helpers/exec-helpers';
import { copyStableBackupFile, copyStableBackupTree } from '../stable-backup-copy';

let root: string;
let source: string;
let destination: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(tmpdir(), 'stable-copy-'));
  source = path.join(root, 'source');
  destination = path.join(root, 'copied');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(root, { recursive: true, force: true });
});

it('copies a regular archive into a private single-link file and refuses to overwrite an existing copy', async () => {
  await fs.promises.writeFile(source, 'checked archive');
  await copyStableBackupFile(source, destination);
  expect(await fs.promises.readFile(destination, 'utf8')).toBe('checked archive');
  expect((await fs.promises.stat(destination)).mode & 0o777).toBe(0o600);
  expect((await fs.promises.stat(destination)).nlink).toBe(1);
  await expect(copyStableBackupFile(source, destination)).rejects.toThrow();
  expect(await fs.promises.readFile(destination, 'utf8')).toBe('checked archive');
});

it.each([false, true])('preserves the copy result when closing its read-only input fails, read failure=%s', async (failRead) => {
  await fs.promises.writeFile(source, 'fixture');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === source) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        throw new Error('Read descriptor close failed');
      });
      if (failRead) vi.spyOn(handle, 'read').mockRejectedValue(new Error('Original read failed'));
    }
    return handle;
  });
  if (failRead) {
    await expect(copyStableBackupFile(source, destination)).rejects.toThrow('Original read failed');
    expect(fs.existsSync(destination)).toBe(false);
  } else {
    await copyStableBackupFile(source, destination);
    expect(await fs.promises.readFile(destination, 'utf8')).toBe('fixture');
  }
});

it.each(['link', 'hardlink', 'directory'])('refuses a %s archive input', async (kind) => {
  const target = path.join(root, 'target');
  await fs.promises.writeFile(target, 'fixture');
  if (kind === 'link') await fs.promises.symlink(target, source);
  else if (kind === 'hardlink') await fs.promises.link(target, source);
  else await fs.promises.mkdir(source);
  await expect(copyStableBackupFile(source, destination)).rejects.toThrow('single-link regular file');
  expect(fs.existsSync(destination)).toBe(false);
});

it('enforces the remaining byte budget before creating a destination', async () => {
  await fs.promises.writeFile(source, 'fixture');
  await expect(copyStableBackupFile(source, destination, {}, 2n)).rejects.toThrow('byte limit');
  expect(fs.existsSync(destination)).toBe(false);
});

it('rejects a FIFO without blocking on an open', async () => {
  expect((await commands.spawnAsync('mkfifo', [source])).stderr).toBe('');
  await expect(copyStableBackupFile(source, destination)).rejects.toThrow('regular file');
  expect(fs.existsSync(destination)).toBe(false);
});

it('refuses a leaf replaced by a link after the original file was opened', async () => {
  await fs.promises.writeFile(source, 'original');
  const target = path.join(root, 'other');
  await fs.promises.writeFile(target, 'replacement');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === source) {
      await fs.promises.rename(source, path.join(root, 'retained'));
      await fs.promises.symlink(target, source);
    }
    return handle;
  });
  await expect(copyStableBackupFile(source, destination)).rejects.toThrow('changed');
  expect(fs.existsSync(destination)).toBe(false);
  expect(await fs.promises.readFile(target, 'utf8')).toBe('replacement');
});

it('refuses same-size in-place modification of the opened file', async () => {
  await fs.promises.writeFile(source, 'original');
  const open = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === destination) {
      await fs.promises.writeFile(source, 'modified');
      await fs.promises.utimes(source, new Date(0), new Date(0));
    }
    return handle;
  });
  await expect(copyStableBackupFile(source, destination)).rejects.toThrow('changed');
  expect(fs.existsSync(destination)).toBe(false);
});

it('copies contained relative links and preserves regular-file and directory metadata', async () => {
  await fs.promises.mkdir(path.join(source, 'data'), { recursive: true });
  const file = path.join(source, 'data', 'record');
  await fs.promises.writeFile(file, 'fixture bytes', { mode: 0o640 });
  await fs.promises.utimes(file, 1000, 1234.125);
  await fs.promises.symlink('data/record', path.join(source, 'link'));
  await fs.promises.chmod(path.join(source, 'data'), 0o750);
  await copyStableBackupTree(source, destination);
  expect(await fs.promises.readFile(path.join(destination, 'link'), 'utf8')).toBe('fixture bytes');
  expect(await fs.promises.readlink(path.join(destination, 'link'))).toBe('data/record');
  for (const relative of ['', 'data', 'data/record', 'link']) {
    const before = await fs.promises.lstat(path.join(source, relative), { bigint: true });
    const after = await fs.promises.lstat(path.join(destination, relative), { bigint: true });
    expect([after.mode, after.uid, after.gid, after.mtimeNs]).toEqual([before.mode, before.uid, before.gid, before.mtimeNs]);
  }
});

it.each(['escape', 'user-config', 'cycle', 'hardlink'])('rejects the unsupported %s tree without leaving a copy', async (kind) => {
  await fs.promises.mkdir(source);
  await fs.promises.writeFile(path.join(source, 'file'), 'fixture');
  if (kind === 'hardlink') await fs.promises.link(path.join(source, 'file'), path.join(source, 'second'));
  else await fs.promises.symlink(kind === 'escape' ? '../outside' : kind === 'cycle' ? '.' : 'file', path.join(source, 'link'));
  await expect(copyStableBackupTree(source, destination, { allowLinks: kind !== 'user-config' })).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false);
});

it('rejects an ancestor replacement while its directory descriptor is still open', async () => {
  const directory = path.join(source, 'data');
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'record'), 'original');
  const open = fs.promises.open.bind(fs.promises);
  let replaced = false;
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!replaced && String(args[0]).endsWith('/data') && !String(args[0]).startsWith(destination)) {
      replaced = true;
      await fs.promises.rename(directory, path.join(root, 'retained'));
      await fs.promises.mkdir(directory);
      await fs.promises.writeFile(path.join(directory, 'record'), 'replacement');
    }
    return handle;
  });
  await expect(copyStableBackupTree(source, destination)).rejects.toThrow('changed');
  expect(replaced).toBe(true);
  expect(fs.existsSync(destination)).toBe(false);
  expect(await fs.promises.readFile(path.join(directory, 'record'), 'utf8')).toBe('replacement');
});

it('cancels during file copying, closes descriptors, and removes only its new destination', async () => {
  await fs.promises.mkdir(source);
  await fs.promises.writeFile(path.join(source, 'record'), Buffer.alloc(2 * 1024 * 1024, 7));
  const controller = new AbortController();
  const open = fs.promises.open.bind(fs.promises);
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    if (String(args[0]) === path.join(destination, 'record')) controller.abort();
    return handle;
  });
  await expect(copyStableBackupTree(source, destination, { signal: controller.signal })).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false);
  expect((await fs.promises.stat(path.join(source, 'record'))).size).toBe(2 * 1024 * 1024);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
});

it('does not remove an existing destination when staging cannot be created', async () => {
  await fs.promises.mkdir(source);
  await fs.promises.mkdir(destination);
  await fs.promises.writeFile(path.join(destination, 'keep'), 'retained');
  await expect(copyStableBackupTree(source, destination)).rejects.toThrow();
  expect(await fs.promises.readFile(path.join(destination, 'keep'), 'utf8')).toBe('retained');
});

it('rejects a tree deeper than the bounded traversal and cleans its staging', async () => {
  let directory = source;
  for (let i = 0; i < 130; i++) {
    await fs.promises.mkdir(directory);
    directory = path.join(directory, 'd');
  }
  await expect(copyStableBackupTree(source, destination)).rejects.toThrow('tree limit');
  expect(fs.existsSync(destination)).toBe(false);
});

it('refuses source mutation during the metadata pass', async () => {
  await fs.promises.mkdir(source);
  const file = path.join(source, 'record');
  await fs.promises.writeFile(file, 'fixture');
  const run = commands.spawnAsync;
  let mutated = false;
  vi.spyOn(commands, 'spawnAsync').mockImplementation(async (...args) => {
    if (!mutated) {
      mutated = true;
      await fs.promises.utimes(file, new Date(0), new Date(0));
    }
    return run(...args);
  });
  await expect(copyStableBackupTree(source, destination)).rejects.toThrow();
  expect(mutated).toBe(true);
  expect(fs.existsSync(destination)).toBe(false);
});

it.skipIf(process.platform !== 'linux')('preserves nanoseconds and uses one bulk metadata process for a tree', async () => {
  await fs.promises.mkdir(source);
  for (let i = 0; i < 64; i++) await fs.promises.writeFile(path.join(source, `record-${i}`), 'fixture');
  const original = path.join(source, 'record-0');
  expect((await commands.spawnAsync('touch', ['-d', '@1234.123456789', '--', original])).stderr).toBe('');
  const run = vi.spyOn(commands, 'spawnAsync');
  await copyStableBackupTree(source, destination);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]).toBe('cp');
  expect(run.mock.calls[0]?.[1]).toContain('--attributes-only');
  expect((await fs.promises.stat(path.join(destination, 'record-0'), { bigint: true })).mtimeNs).toBe(1234123456789n);
});

it.skipIf(process.platform !== 'linux')('uses descriptor-relative paths for nested file opens on Linux', async () => {
  await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.promises.writeFile(path.join(source, 'nested', 'record'), 'fixture');
  const open = vi.spyOn(fs.promises, 'open');
  await copyStableBackupTree(source, destination);
  expect(open.mock.calls.some(([file]) => /^\/proc\/\d+\/fd\/\d+\/record$/.test(String(file)))).toBe(true);
});

it('preserves inert container links and their metadata without opening or modifying the linked targets', async () => {
  await fs.promises.mkdir(source);
  const outside = path.join(root, 'outside');
  await fs.promises.writeFile(outside, 'untouched external bytes', { mode: 0o600 });
  const targets = { absolute: outside, external: '../outside', dangling: 'missing', loop: 'loop' };
  for (const [name, target] of Object.entries(targets)) await fs.promises.symlink(target, path.join(source, name));
  const before = await fs.promises.lstat(outside, { bigint: true });
  const metadata = async (file: string) => {
    const value = await fs.promises.lstat(file, { bigint: true });
    return { uid: value.uid, gid: value.gid, mode: value.mode, modified: value.mtimeNs };
  };
  await copyStableBackupTree(source, destination, { allowLinks: 'verbatim' });
  for (const [name, target] of Object.entries(targets)) {
    expect(await fs.promises.readlink(path.join(destination, name))).toBe(target);
    expect(await metadata(path.join(destination, name))).toEqual(await metadata(path.join(source, name)));
  }
  const after = await fs.promises.lstat(outside, { bigint: true });
  expect([after.ino, after.mode, after.mtimeNs, after.ctimeNs, after.atimeNs]).toEqual([
    before.ino,
    before.mode,
    before.mtimeNs,
    before.ctimeNs,
    before.atimeNs,
  ]);
  expect(await fs.promises.readFile(outside, 'utf8')).toBe('untouched external bytes');
});

it('still refuses hardlinked files and root symlinks in verbatim mode', async () => {
  await fs.promises.mkdir(source);
  const outside = path.join(root, 'outside');
  await fs.promises.writeFile(outside, 'external fixture');
  await fs.promises.link(outside, path.join(source, 'hard'));
  await expect(copyStableBackupTree(source, destination, { allowLinks: 'verbatim' })).rejects.toThrow('single-link regular file');
  expect(fs.existsSync(destination)).toBe(false);
  await fs.promises.rename(source, path.join(root, 'original'));
  await fs.promises.symlink(path.join(root, 'original'), source);
  await expect(copyStableBackupTree(source, destination, { allowLinks: 'verbatim' })).rejects.toThrow('regular directory');
});
