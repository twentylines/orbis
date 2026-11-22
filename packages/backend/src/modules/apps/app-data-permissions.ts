import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Do not follow app-controlled links or open devices while preparing seeded data. */
export async function makeAppDataWritable(root: string): Promise<void> {
  const visit = async (entryPath: string, rootEntry = false): Promise<void> => {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!rootEntry && ['ENOENT', 'ELOOP', 'ENXIO'].includes(code ?? '')) return;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (rootEntry && !info.isDirectory()) throw new Error('App data must be a directory.');
      if (!info.isFile() && !info.isDirectory()) return;
      if (info.isFile() && info.nlink !== 1) return;
      // The generated interpolation file contains app credentials, not seeded data.
      if (info.isFile() && entryPath === path.join(root, 'app.env')) return;
      await handle.chmod(info.mode | 0o777);
      if (!info.isDirectory()) return;
      // Linux walks through the open directory, so replacing its pathname cannot
      // redirect subsequent chmod calls. Other platforms recheck the same inode.
      const directoryPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : entryPath;
      if (process.platform !== 'linux') {
        const current = await fs.lstat(entryPath);
        if (!current.isDirectory() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('App data changed during preparation.');
      }
      for (const name of await fs.readdir(directoryPath)) {
        if (rootEntry && name === 'app.env') continue;
        await visit(path.join(directoryPath, name));
      }
    } finally {
      await handle.close();
    }
  };
  await visit(root, true);
}
