import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveEntry } from '@/core/archive/archive.service';

const unsupported = () => new Error('Backup contains unsupported file types');
const hasControls = (value: string) => {
  for (const character of value) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  return false;
};
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function validateBackupTree(root: string, allowLinks = true): Promise<void> {
  const canonical = await fs.promises.realpath(root);
  const entries: ArchiveEntry[] = [];
  const visit = async (file: string): Promise<void> => {
    const entry = await fs.promises.lstat(file);
    const relative = path.relative(root, file).split(path.sep).join('/');
    entries.push({
      path: relative ? `app-data/${relative}` : 'app-data',
      type: entry.isDirectory() ? 'd' : entry.isFile() ? '-' : entry.isSymbolicLink() ? 'l' : 'unsupported',
      ...(entry.isSymbolicLink() ? { linkTarget: await fs.promises.readlink(file) } : {}),
    });
    if (entry.isDirectory()) {
      for (const name of await fs.promises.readdir(file)) await visit(path.join(file, name));
    } else if (entry.isSymbolicLink()) {
      const target = await fs.promises.readlink(file);
      if (!allowLinks || file === root || !target || path.isAbsolute(target) || !inside(root, path.resolve(path.dirname(file), target)))
        throw unsupported();
      try {
        if (!inside(canonical, await fs.promises.realpath(file))) throw unsupported();
        const resolved = await fs.promises.stat(file);
        if (!resolved.isFile() && !resolved.isDirectory()) throw unsupported();
      } catch {
        throw unsupported();
      }
    } else if (!entry.isFile()) throw unsupported();
  };
  await visit(root);
  validateArchiveLinks(entries, (value) => value);
}

export function validateArchiveLinks(entries: ArchiveEntry[], normalize: (entry: string) => string): void {
  const paths = new Map<string, ArchiveEntry>();
  const directories = new Map<string, Set<string>>();
  const connect = (parent: string, target: string) => {
    if (!directories.has(parent)) directories.set(parent, new Set());
    directories.get(parent)?.add(target);
  };
  for (const entry of entries) {
    const name = normalize(entry.path).replace(/\/$/, '');
    if (paths.has(name)) throw unsupported();
    paths.set(name, entry);
  }
  for (const [name, entry] of paths) {
    if (!['-', 'd', 'l'].includes(entry.type) || hasControls(name)) throw unsupported();
    if (name === '.') {
      if (entry.type !== 'd') throw unsupported();
      continue;
    }
    if (entry.type === 'd') connect(path.posix.dirname(name), name);
    const group = name.split('/')[0];
    if (['app-data', 'app', 'user-config'].includes(group ?? '') && name === group && entry.type !== 'd') throw unsupported();
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      const ancestor = paths.get(parent);
      if (ancestor && ancestor.type !== 'd') throw unsupported();
      parent = path.posix.dirname(parent);
    }
    if (entry.type !== 'l') continue;
    if (!['app-data', 'app'].includes(group ?? '')) throw unsupported();
    const visited = new Set<string>();
    let current = name;
    while (paths.get(current)?.type === 'l') {
      if (group === 'user-config' || visited.has(current)) throw unsupported();
      visited.add(current);
      const target = paths.get(current)?.linkTarget;
      if (!target || path.posix.isAbsolute(target) || hasControls(target) || target.includes('\\')) throw unsupported();
      current = path.posix.normalize(path.posix.join(path.posix.dirname(current), target));
      if (current.split('/')[0] !== group || !paths.has(current)) throw unsupported();
    }
    if (!['-', 'd'].includes(paths.get(current)?.type ?? '')) throw unsupported();
    if (paths.get(current)?.type === 'd') connect(path.posix.dirname(name), current);
  }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (directory: string) => {
    if (active.has(directory)) throw unsupported();
    if (done.has(directory)) return;
    active.add(directory);
    for (const target of directories.get(directory) ?? []) visit(target);
    active.delete(directory);
    done.add(directory);
  };
  for (const directory of directories.keys()) visit(directory);
}
