import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '@/common/constants';
import { castAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import type { Request } from 'express';

export type BackupUploadFile = { path: string; destination: string; filename: string; originalname: string; mimetype: string; size: number };
type IncomingFile = { stream: Readable };

export class BackupUploadStorage {
  private readonly active = new Set<string>();
  private readonly preparing = new Map<string, Promise<unknown>>();

  constructor(private readonly backupsRoot = path.join(DATA_DIR, 'backups')) {}

  private async prepare(appUrn: string) {
    const { appName, appStoreId } = extractAppUrn(castAppUrn(appUrn));
    const uploadRoot = path.join(this.backupsRoot, appStoreId, appName, '.uploads');
    const previous = this.preparing.get(uploadRoot) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.promises.mkdir(this.backupsRoot, { recursive: true });
        for (const directory of [this.backupsRoot, path.dirname(path.dirname(uploadRoot)), path.dirname(uploadRoot), uploadRoot]) {
          await fs.promises.mkdir(directory, { mode: directory === uploadRoot ? 0o700 : 0o755 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          const entry = await fs.promises.lstat(directory);
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid backup upload directory');
        }
        const stats = await fs.promises.lstat(uploadRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700 || stats.uid !== process.getuid?.()) {
          throw new Error('The backup upload staging directory is not private');
        }
        for (const name of await fs.promises.readdir(uploadRoot)) {
          const entry = path.join(uploadRoot, name);
          if (!name.startsWith('upload-') || this.active.has(entry)) continue;
          const stale = await fs.promises.lstat(entry).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!stale) continue;
          if (!stale.isDirectory() || stale.isSymbolicLink() || stale.uid !== stats.uid || (stale.mode & 0o777) !== 0o700) {
            throw new Error('An upload staging directory needs manual inspection');
          }
          await fs.promises.rm(entry, { recursive: true });
        }
        const directory = await fs.promises.mkdtemp(path.join(uploadRoot, 'upload-'));
        this.active.add(directory);
        return directory;
      });
    this.preparing.set(uploadRoot, operation);
    try {
      return await operation;
    } finally {
      if (this.preparing.get(uploadRoot) === operation) this.preparing.delete(uploadRoot);
    }
  }

  async remove(file: Pick<BackupUploadFile, 'destination'>) {
    const directory = file.destination;
    if (!this.active.has(directory)) throw new Error('Unknown backup upload staging directory');
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
    } finally {
      this.active.delete(directory);
    }
  }

  _handleFile(request: Request, file: IncomingFile, callback: (error?: unknown, info?: Partial<BackupUploadFile>) => void) {
    const receive = async () => {
      const directory = await this.prepare(String(request.params.urn));
      const filename = 'backup.tar.gz';
      const target = path.join(directory, filename);
      const abort = () => file.stream.destroy(new Error('The backup upload was cancelled'));
      request.once('aborted', abort);
      try {
        if (request.aborted) throw new Error('The backup upload was cancelled');
        const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
        await pipeline(file.stream, output);
        return { destination: directory, filename, path: target, size: output.bytesWritten };
      } catch (error) {
        await this.remove({ destination: directory });
        throw error;
      } finally {
        request.removeListener('aborted', abort);
      }
    };
    receive().then((result) => callback(null, result), callback);
  }

  _removeFile(_request: Request, file: BackupUploadFile, callback: (error: Error | null) => void) {
    this.remove(file).then(
      () => callback(null),
      (error) => callback(error),
    );
  }
}

export const backupUploadStorage = new BackupUploadStorage();
