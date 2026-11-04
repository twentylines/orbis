import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, resolveBackupLinkPath } from './backup-files';

export async function createAnchoredBackupLink(options: {
  root: string;
  relative: string;
  target: string;
  uid: number;
  gid: number;
  mtime: number;
  signal?: AbortSignal;
}) {
  const failed = () => new BackupRequirementError('Backup links require verified Linux directory anchoring. No live data was replaced.');
  const parts = options.relative.split('/');
  if (
    process.platform !== 'linux' ||
    !path.isAbsolute(options.root) ||
    path.resolve(options.root) !== options.root ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('\\') ||
        Buffer.byteLength(part) > 255 ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    ) ||
    ![options.uid, options.gid].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) ||
    !Number.isFinite(options.mtime) ||
    Math.abs(options.mtime) > 8.64e15
  )
    throw failed();
  const pins: { handle: FileHandle; at: string; dev: number; ino: number; uid: number; gid: number; mode: number }[] = [];
  const matches = (stat: Stats, pin: (typeof pins)[number]) =>
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.dev === pin.dev &&
    stat.ino === pin.ino &&
    stat.uid === pin.uid &&
    stat.gid === pin.gid &&
    stat.mode === pin.mode &&
    !(stat.mode & 0o077);
  const seal = async () => {
    options.signal?.throwIfAborted();
    for (const pin of pins) if (!matches(await pin.handle.stat(), pin) || !matches(await fs.lstat(pin.at), pin)) throw failed();
    if ((await fs.realpath(parent)) !== parent) throw failed();
  };
  const pinDirectory = async (at: string) => {
    const before = await fs.lstat(at);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !Number.isSafeInteger(before.dev) ||
      !Number.isSafeInteger(before.ino) ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw failed();
    const handle = await fs.open(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pin = { handle, at, dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid, mode: before.mode };
    pins.push(pin);
    const reference = `/proc/self/fd/${handle.fd}`;
    if (!matches(await handle.stat(), pin) || !matches(await fs.stat(reference), pin)) throw failed();
    return reference;
  };
  const parent = path.join(options.root, ...parts.slice(0, -1));
  try {
    options.signal?.throwIfAborted();
    await resolveBackupLinkPath(options.root, parent, options.target);
    if ((await fs.realpath(options.root)) !== options.root) throw failed();
    let reference = await pinDirectory(options.root);
    for (const part of parts.slice(0, -1)) reference = await pinDirectory(`${reference}/${part}`);
    await seal();
    const child = `${reference}/${parts.at(-1)}`;
    await fs.symlink(options.target, child);
    await seal();
    const created = await fs.lstat(child);
    if (
      !created.isSymbolicLink() ||
      !Number.isSafeInteger(created.dev) ||
      !Number.isSafeInteger(created.ino) ||
      (await fs.readlink(child)) !== options.target
    )
      throw failed();
    if (created.uid !== options.uid || created.gid !== options.gid) {
      await seal();
      await fs.lchown(child, options.uid, options.gid);
      await seal();
    }
    await fs.lutimes(child, options.mtime / 1000, options.mtime / 1000);
    await seal();
    const after = await fs.lstat(child);
    if (
      !after.isSymbolicLink() ||
      after.dev !== created.dev ||
      after.ino !== created.ino ||
      after.uid !== options.uid ||
      after.gid !== options.gid ||
      Math.abs(after.mtimeMs - options.mtime) > 1 ||
      (await fs.readlink(child)) !== options.target
    )
      throw failed();
    return after;
  } finally {
    await Promise.all(pins.map((pin) => pin.handle.close()));
  }
}
