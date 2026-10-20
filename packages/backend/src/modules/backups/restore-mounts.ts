import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Kernel mount metadata must describe this process's namespace, including in filesystem simulations.
const kernelFilesystem = createRequire(import.meta.url)('node:fs') as typeof fs;
const readMounts = async () => (process.platform === 'linux' ? kernelFilesystem.promises.readFile('/proc/self/mountinfo', 'utf8') : null);

export const parseRestoreMounts = (text: string) => {
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length || text.length > 16 * 1024 * 1024) throw new Error('Restore mount boundaries could not be inspected');
  return lines.map((line) => {
    const fields = line.split(' ');
    const mount = fields[4];
    if (!/^\d+$/.test(fields[0] ?? '') || !/^\d+:\d+$/.test(fields[2] ?? '') || !mount?.startsWith('/') || !line.includes(' - '))
      throw new Error('Restore mount boundaries could not be inspected');
    return mount.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
  });
};

export const assertNoRestoreMounts = async (directory: string, read = readMounts) => {
  const text = await read();
  if (text === null) return;
  const root = await fs.promises.realpath(directory);
  for (const mount of parseRestoreMounts(text)) {
    const relative = path.relative(root, mount);
    if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
      throw new Error('Restore destination contains a mount point. The original data has been preserved.');
  }
};
