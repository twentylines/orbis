import fs from 'node:fs/promises';
import { vi } from 'vitest';

/** Darwin-only model for actual fixture handles; native Linux runs use the kernel paths unchanged. */
export function modelLinuxProcFiles(identityAliases = new Map<string, string>()) {
  if (process.platform === 'linux') return () => undefined;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const opened = new Map<number, string>();
  const original = {
    open: fs.open.bind(fs),
    stat: fs.stat.bind(fs),
    lstat: fs.lstat.bind(fs),
    opendir: fs.opendir.bind(fs),
    readFile: fs.readFile.bind(fs),
    rename: fs.rename.bind(fs),
  };
  const translate = (file: unknown) => {
    const value = String(file);
    const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(value);
    if (!match) return value;
    const root = opened.get(Number(match[1]));
    if (!root) throw new Error('Unknown modeled source descriptor');
    return root + (match[2] ?? '');
  };
  const masked = async (name: string, stat: Awaited<ReturnType<typeof original.lstat>>) => {
    const alias = identityAliases.get(name);
    if (!alias) return stat;
    const identity = await original.lstat(alias);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: identity.dev, ino: identity.ino });
  };
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const name = translate(file);
    const handle = await original.open(name, flags, mode);
    opened.set(handle.fd, name);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, 'stat').mockImplementation((async (options) => masked(name, await stat(options))) as typeof handle.stat);
    return handle;
  });
  vi.spyOn(fs, 'stat').mockImplementation((async (file, options) =>
    masked(translate(file), await original.stat(translate(file), options))) as typeof fs.stat);
  vi.spyOn(fs, 'lstat').mockImplementation((async (file, options) =>
    masked(translate(file), await original.lstat(translate(file), options))) as typeof fs.lstat);
  vi.spyOn(fs, 'opendir').mockImplementation(((file, options) => original.opendir(translate(file), options)) as typeof fs.opendir);
  vi.spyOn(fs, 'readFile').mockImplementation(((file, options) =>
    /^\/proc\/self\/fdinfo\/\d+$/.test(String(file))
      ? Promise.resolve('mnt_id:\t1\n')
      : original.readFile(translate(file), options)) as typeof fs.readFile);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const source = translate(from);
    const destination = translate(to);
    await original.rename(source, destination);
    for (const [fd, name] of opened)
      if (name === source || name.startsWith(`${source}/`)) opened.set(fd, `${destination}${name.slice(source.length)}`);
  });
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  return () => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  };
}
