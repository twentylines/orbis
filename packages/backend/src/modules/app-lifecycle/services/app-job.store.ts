import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { arkAppUrn } from '@runtipi/common/types';

const jobRecordSchema = type({
  version: '1',
  requestId: 'string.uuid',
  appUrn: arkAppUrn,
  command: "'backup' | 'update'",
  appId: 'number.integer > 0',
  appCreatedAt: 'number.integer >= 0',
  appVersion: 'number.integer >= 0',
  previousStatus: "'running' | 'stopped'",
  inputSha256: '/^[a-f0-9]{64}$/',
  state: "'queued' | 'running' | 'cancel-requested' | 'sealed' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'",
  createdAt: 'number.integer >= 0',
  startedAt: 'number.integer >= 0 | null',
  cancelRequestedAt: 'number.integer >= 0 | null',
  updatedAt: 'number.integer >= 0',
}).onUndeclaredKey('reject');
export type AppJobRecord = typeof jobRecordSchema.infer;
export const jobStoreError = () => new Error('The app operation record could not be verified. Review the operation before retrying.');
export function jobInputHash(form: unknown, performBackup?: boolean) {
  const body = JSON.stringify({ form, ...(performBackup === undefined ? {} : { performBackup }) }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  if (!body || Buffer.byteLength(body) > 2 * 1024 * 1024) throw jobStoreError();
  return createHash('sha256').update(body).digest('hex');
}
const identity = (value: import('node:fs').Stats) => [value.dev, value.ino, value.mode, value.uid, value.gid].join(':');
const fileIdentity = (value: import('node:fs').Stats) => [identity(value), value.nlink, value.size, value.mtimeMs, value.ctimeMs].join(':');

export class AppJobStore {
  constructor(private readonly dataDir: string) {}

  private async directory(create: boolean) {
    if (!path.isAbsolute(this.dataDir) || path.resolve(this.dataDir) !== this.dataDir || (await fs.realpath(this.dataDir)) !== this.dataDir)
      throw jobStoreError();
    const directory = path.join(this.dataDir, 'state', 'orbis-app-jobs');
    for (const name of [this.dataDir, path.dirname(directory), directory]) {
      try {
        if (create && name !== this.dataDir)
          await fs.mkdir(name, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
        const info = await fs.lstat(name);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (name === directory && (info.mode & 0o077 || (process.geteuid && info.uid !== process.geteuid())))
        )
          throw jobStoreError();
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
    return directory;
  }

  private filename(directory: string, requestId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) throw jobStoreError();
    return path.join(directory, `${requestId}.json`);
  }

  async read(requestId: string): Promise<AppJobRecord | null> {
    const value = await this.readFile(requestId);
    if (value && value.requestId !== requestId) throw jobStoreError();
    return value;
  }
  async current(appUrn: string): Promise<AppJobRecord | null> {
    const value = await this.readFile(appUrn, true);
    if (value && value.appUrn !== appUrn) throw jobStoreError();
    return value;
  }
  private async readFile(key: string, current = false): Promise<AppJobRecord | null> {
    const directory = await this.directory(false);
    if (!directory) return null;
    const filename = current ? path.join(directory, `app-${createHash('sha256').update(key).digest('hex')}.json`) : this.filename(directory, key);
    const parent = await fs.lstat(directory);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!handle) return null;
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > 8192 ||
        info.mode & 0o077 ||
        (process.geteuid && info.uid !== process.geteuid())
      )
        throw jobStoreError();
      const bytes = await handle.readFile();
      if (
        bytes.length !== info.size ||
        fileIdentity(await handle.stat()) !== fileIdentity(info) ||
        fileIdentity(await fs.lstat(filename)) !== fileIdentity(info) ||
        identity(await fs.lstat(directory)) !== identity(parent)
      )
        throw jobStoreError();
      const value = jobRecordSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      return value;
    } finally {
      await handle.close();
    }
  }

  async write(value: AppJobRecord, expected?: AppJobRecord, current = false) {
    jobRecordSchema.assert(value);
    const directory = await this.directory(true);
    if (!directory) throw jobStoreError();
    const filename = current
      ? path.join(directory, `app-${createHash('sha256').update(value.appUrn).digest('hex')}.json`)
      : this.filename(directory, value.requestId);
    const before = await fs.lstat(directory);
    if (expected && JSON.stringify(current ? await this.current(value.appUrn) : await this.read(value.requestId)) !== JSON.stringify(expected))
      throw jobStoreError();
    const target = expected ? path.join(directory, `.${randomUUID()}.tmp`) : filename;
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      if (identity(await fs.lstat(directory)) !== identity(before)) throw jobStoreError();
      if (expected) await fs.rename(target, filename);
      const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await handle.close().catch(() => undefined);
      if (expected) await fs.rm(target, { force: true });
    }
  }
}
