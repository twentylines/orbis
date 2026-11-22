import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fail = () => new Error('The app package contains an unsafe or changed file link.');
export type PackageLinkEntry = { name: string; directory: boolean; symlink?: string };
export function portablePackageLink(value: string) {
  return value.length > 0 && Buffer.byteLength(value) <= 4096 && !path.posix.isAbsolute(value) && !/[\0\r\n\\]/.test(value);
}
const relative = (value: string) => {
  const name = path.posix.normalize(value);
  if (name === '..' || name.startsWith('../') || path.posix.isAbsolute(name) || /[\0\r\n\\]/.test(name)) throw fail();
  return name === '.' ? '' : name;
};
/** Resolves only captured package names. No link is followed into the host filesystem. Safe dangling links remain portable. */
function resolvePackagePath(names: ReadonlyMap<string, PackageLinkEntry>, selected: string) {
  const resolved: string[] = [];
  let pending = selected.split('/');
  let links = 0;
  let steps = 0;
  const seen = new Set<string>();
  while (pending.length) {
    if (++steps > 8192 || pending.join('/').length > 8192) throw fail();
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) throw fail();
      resolved.pop();
      continue;
    }
    const name = [...resolved, part].join('/');
    const row = names.get(name);
    if (row?.symlink !== undefined) {
      if (!portablePackageLink(row.symlink) || ++links > 64) throw fail();
      const key = name + '/' + pending.join('/');
      if (seen.has(key)) throw fail();
      seen.add(key);
      pending = [...row.symlink.split('/'), ...pending];
    } else {
      if (row && !row.directory && pending.length) throw fail();
      resolved.push(part);
    }
  }
  return resolved.join('/');
}
export function resolvePackageLink(entries: readonly PackageLinkEntry[], selected: string) {
  return resolvePackagePath(new Map(entries.map((row) => [row.name, row])), selected);
}
export function assertPackageLinks(entries: readonly PackageLinkEntry[]) {
  const names = new Map(entries.map((row) => [row.name, row]));
  for (const row of entries) {
    if (row.name !== relative(row.name) || Buffer.byteLength(row.name) > 512) throw fail();
    if (row.symlink === undefined) continue;
    if (row.directory || !portablePackageLink(row.symlink)) throw fail();
    resolvePackagePath(names, row.name);
  }
}
const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
const fileIdentity = (stat: fs.Stats) => [identity(stat), stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/** Bounded asset read anchored to the package directory; Linux uses pinned directory descriptors for every component. */
export async function readAppPackageAsset(root: string, selected: string, maximum = 8 * 1024 * 1024) {
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    Buffer.byteLength(root) > 4096 ||
    relative(selected) !== selected ||
    !selected ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 8 * 1024 * 1024
  )
    throw fail();
  const held: { name: string; handle: fs.promises.FileHandle; identity: string }[] = [];
  const links: { name: string; identity: string; target: string }[] = [];
  let input: fs.promises.FileHandle | undefined;
  const close = async () => {
    const results = await Promise.allSettled([...(input ? [input.close()] : []), ...held.map(({ handle }) => handle.close())]);
    if (results.some((result) => result.status === 'rejected')) throw fail();
  };
  try {
    if ((await fs.promises.realpath(root)) !== root) throw fail();
    const handle = await fs.promises.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      await handle.close();
      throw fail();
    }
    held.push({ name: root, handle, identity: identity(stat) });
    const stack = [held[0]];
    let pending = selected.split('/');
    let name = '';
    let expansions = 0;
    let steps = 0;
    while (pending.length) {
      if (++steps > 8192 || pending.join('/').length > 8192) throw fail();
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        if (stack.length <= 1) throw fail();
        stack.pop();
        continue;
      }
      const parent = stack.at(-1);
      if (!parent) throw fail();
      const named = path.join(parent.name, part);
      const pinned = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}/${part}` : named;
      const info = await fs.promises.lstat(pinned);
      if (info.isSymbolicLink()) {
        const target = await fs.promises.readlink(pinned);
        if (!portablePackageLink(target) || ++expansions > 64 || fileIdentity(await fs.promises.lstat(pinned)) !== fileIdentity(info)) throw fail();
        links.push({ name: named, identity: fileIdentity(info), target });
        pending = [...target.split('/'), ...pending];
        continue;
      }
      if (!pending.length) {
        input = await fs.promises.open(pinned, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        if (fileIdentity(await input.stat()) !== fileIdentity(info)) throw fail();
        name = named;
        break;
      }
      const directory = await fs.promises.open(pinned, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const current = await directory.stat();
      if (!current.isDirectory() || identity(current) !== identity(info) || held.length >= 256) {
        await directory.close();
        throw fail();
      }
      const entry = { name: named, handle: directory, identity: identity(current) };
      held.push(entry);
      stack.push(entry);
    }
    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.md': 'text/markdown',
    };
    const contentType = types[path.posix.extname(name).toLowerCase()];
    if (!input || !contentType || (path.posix.extname(selected).toLowerCase() === '.md') !== (contentType === 'text/markdown')) throw fail();
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw fail();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await input.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== before.size || length > maximum || fileIdentity(await input.stat()) !== fileIdentity(before)) throw fail();
    for (const item of held)
      if (identity(await item.handle.stat()) !== item.identity || identity(await fs.promises.lstat(item.name)) !== item.identity) throw fail();
    for (const item of links)
      if (fileIdentity(await fs.promises.lstat(item.name)) !== item.identity || (await fs.promises.readlink(item.name)) !== item.target) throw fail();
    const bytes = Buffer.from(buffer.subarray(0, length));
    return { bytes, contentType, etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"' };
  } finally {
    await close();
  }
}
