import fs from 'node:fs/promises';
import path from 'node:path';
import { appUpdateStorage, type MetadataEntry } from '../docker/app-image-pins';
const fail = () => new Error('The app package could not be copied safely. Existing installed files were kept.');
const content = (entries: readonly MetadataEntry[]) => entries.map(({ mode: _mode, gid: _gid, ...row }) => row);

/** Capture bounded regular bytes and portable links before publishing. Catalogue-generated Compose is never an input. */
export async function copyAppPackage(source: string, destination: string) {
  await appUpdateStorage.noSymlinkParents(path.dirname(destination));
  const parent = await fs.mkdtemp(path.join(path.dirname(destination), '.app-package-'));
  const own = await fs.lstat(parent);
  const env = path.join(parent, 'absent.env');
  const cleanup = async () => {
    const current = await fs.lstat(parent);
    if (!current.isDirectory() || current.dev !== own.dev || current.ino !== own.ino) throw fail();
    await fs.rm(parent, { recursive: true });
  };
  try {
    if (
      await fs.lstat(destination).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      throw fail();
    const captured = await appUpdateStorage.metadataState(source, env, parent, { omitGenerated: true });
    const again = await appUpdateStorage.metadataState(source, env, undefined, { omitGenerated: true });
    if (JSON.stringify(captured) !== JSON.stringify(again)) throw fail();
    const snapshot = path.join(parent, 'metadata');
    const copied = await appUpdateStorage.metadataState(snapshot, env);
    if (JSON.stringify(content(captured.entries)) !== JSON.stringify(content(copied.entries))) throw fail();
    for (const row of [...captured.entries].reverse()) {
      if (row.symlink === undefined) {
        const file = await fs.open(path.join(snapshot, row.name), 'r');
        try {
          await file.chmod(row.mode);
          await file.sync();
        } finally {
          await file.close();
        }
      }
    }
    await fs.rename(snapshot, destination);
    await appUpdateStorage.syncDirectory(path.dirname(destination));
  } catch {
    throw fail();
  } finally {
    await cleanup();
  }
}
