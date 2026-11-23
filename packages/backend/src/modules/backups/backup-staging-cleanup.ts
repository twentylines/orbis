import { randomUUID } from 'node:crypto';
import fs, { type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { coreCaptureRecoveryRequired, corePreparationRecoveryHeld } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import type { LoggerService } from '@/core/logger/logger.service';
import { arkAppUrn, type AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';

const recordSchema = type({
  version: '1',
  appUrn: arkAppUrn,
  kind: "'snapshot' | 'restore' | 'partial' | 'upload'",
  target: 'string',
  dev: '/^(0|[1-9][0-9]{0,19})$/',
  ino: '/^(0|[1-9][0-9]{0,19})$/',
  birthtimeNs: '/^(0|[1-9][0-9]{0,24})$/',
  uid: 'number.integer >= 0',
}).onUndeclaredKey('reject');
type Record = typeof recordSchema.infer;
type Kind = Record['kind'];
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identity = (entry: BigIntStats) => [entry.dev, entry.ino, entry.mode, entry.uid, entry.gid].join(':');
const fileIdentity = (entry: BigIntStats) => [identity(entry), entry.nlink, entry.size, entry.mtimeNs, entry.ctimeNs].join(':');
const currentUid = () => BigInt(process.geteuid?.() ?? -1);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const pinned = (directory: FileHandle, name: string, fallback: string) =>
  process.platform === 'linux' ? `/proc/self/fd/${directory.fd}/${name}` : path.join(fallback, name);

/** Only failed, already-authorized disposal is recorded. A crash alone never
 * makes an unknown snapshot or recovery journal disposable. */
export class BackupStagingCleanup {
  constructor(
    private readonly dataDir: () => string,
    private readonly logger: LoggerService,
  ) {}

  private warn() {
    try {
      this.logger.warn('Private backup staging could not be removed. Retained staging needs another cleanup check.');
    } catch {
      // A logging failure cannot replace the backup or restore outcome either.
    }
  }

  async closeReadOnly(handle: FileHandle) {
    try {
      await handle.close();
    } catch {
      // Validation and sync failures belong to the caller. Never retry an
      // uncertain descriptor or replace the operation's result with cleanup.
      try {
        this.logger.warn('A read-only backup handle could not be closed.');
      } catch {
        // Logging must preserve the operation's result too.
      }
    }
  }

  private async parent(file: string) {
    let current = path.parse(file).root;
    for (const part of path.dirname(file).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const entry = await fs.promises.lstat(current, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Backup staging parent is not a regular directory');
    }
    const named = await fs.promises.lstat(current, { bigint: true });
    const handle = await fs.promises.open(current, flags | fs.constants.O_DIRECTORY);
    try {
      if (identity(await handle.stat({ bigint: true })) !== identity(named)) throw new Error('Backup staging parent changed');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async directory(create: boolean): Promise<{ name: string; handle: FileHandle } | null> {
    const data = this.dataDir();
    if (!path.isAbsolute(data) || path.resolve(data) !== data || (await fs.promises.realpath(data)) !== data)
      throw new Error('Invalid backup staging storage');
    const name = path.join(data, 'state', 'backup-staging-cleanup');
    let parent = await this.parent(path.join(data, 'entry'));
    let current = data;
    let retained = false;
    try {
      for (const part of ['state', 'backup-staging-cleanup']) {
        const directory = pinned(parent, part, current);
        if (create)
          await fs.promises.mkdir(directory, { mode: 0o700 }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          });
        const entry = await fs.promises.lstat(directory, { bigint: true }).catch((error) => {
          if (!create && absent(error)) return null;
          throw error;
        });
        if (!entry) return null;
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (part === 'backup-staging-cleanup' && (entry.uid !== currentUid() || (entry.mode & 0o777n) !== 0o700n))
        )
          throw new Error('Backup staging records are not private');
        const child = await fs.promises.open(directory, flags | fs.constants.O_DIRECTORY);
        if (identity(await child.stat({ bigint: true })) !== identity(entry)) {
          await child.close();
          throw new Error('Backup staging records changed');
        }
        await parent.close().catch(() => undefined);
        parent = child;
        current = path.join(current, part);
      }
      if (
        (await fs.promises.realpath(name)) !== name ||
        identity(await fs.promises.lstat(name, { bigint: true })) !== identity(await parent.stat({ bigint: true }))
      )
        throw new Error('Backup staging record path changed');
      retained = true;
      return { name, handle: parent };
    } finally {
      if (!retained) await parent.close().catch(() => undefined);
    }
  }

  private async allowed(appUrn: AppUrn, kind: Kind, target: string) {
    if (target.length > 4096 || path.resolve(target) !== target) throw new Error('Invalid disposable backup path');
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const name = path.basename(target);
    if (kind === 'upload') {
      if (path.dirname(target) !== path.join(this.dataDir(), 'backups', appStoreId, appName) || !/^\.orbis-upload-[A-Za-z0-9]{6}$/.test(name))
        throw new Error('Invalid upload backup staging path');
    } else if (kind === 'partial') {
      const parent = path.join(this.dataDir(), 'backups', appStoreId, appName);
      const prefix = `.${appName}-${appStoreId}-`;
      const suffix = name.slice(prefix.length);
      const separator = suffix.indexOf('-');
      if (
        path.dirname(target) !== parent ||
        !name.startsWith(prefix) ||
        separator < 1 ||
        !/^\d{1,16}$/.test(suffix.slice(0, separator)) ||
        !suffix.endsWith('.partial') ||
        !uuid.test(suffix.slice(separator + 1, -'.partial'.length))
      )
        throw new Error('Invalid partial backup path');
    } else {
      const root = await fs.promises.realpath(tmpdir());
      if (!inside(root, target)) throw new Error('Backup staging is outside temporary storage');
      const prefix = `${appUrn}${kind === 'restore' ? '-restore' : ''}-`;
      if (!name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) throw new Error('Invalid backup staging name');
    }
  }

  private matches(record: Record, entry: BigIntStats) {
    return (
      entry.dev.toString() === record.dev &&
      entry.ino.toString() === record.ino &&
      entry.birthtimeNs.toString() === record.birthtimeNs &&
      entry.uid === BigInt(record.uid) &&
      entry.uid === currentUid() &&
      (record.kind === 'partial'
        ? entry.isFile() && entry.nlink === 1n && (entry.mode & 0o777n) === 0o600n
        : entry.isDirectory() && (entry.mode & 0o777n) === 0o700n)
    );
  }

  private async remove(record: Record) {
    await this.allowed(record.appUrn, record.kind, record.target);
    const parent = await this.parent(record.target).catch((error) => {
      if (absent(error)) return null;
      throw error;
    });
    if (!parent) return;
    try {
      const file = pinned(parent, path.basename(record.target), path.dirname(record.target));
      const entry = await fs.promises.lstat(file, { bigint: true }).catch((error) => {
        if (absent(error)) return null;
        throw error;
      });
      if (!entry) return;
      if (!this.matches(record, entry)) throw new Error('Disposable backup staging identity changed');
      await fs.promises.rm(file, { recursive: record.kind !== 'partial', force: true });
    } finally {
      await parent.close();
    }
  }

  private async retain(record: Record) {
    const directory = await this.directory(true);
    if (!directory) throw new Error('Backup cleanup record directory is unavailable');
    try {
      const id = randomUUID();
      const pending = pinned(directory.handle, `.${id}.tmp`, directory.name);
      const handle = await fs.promises.open(
        pending,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(recordSchema.assert(record)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(pending, pinned(directory.handle, `${id}.json`, directory.name));
      await directory.handle.sync();
    } finally {
      await directory.handle.close();
    }
  }

  async dispose(appUrn: AppUrn, kind: Kind, selected: string) {
    try {
      // Resolve only the system temporary alias, never a symlink inside staging.
      const target =
        kind === 'snapshot' || kind === 'restore'
          ? path.join(await fs.promises.realpath(tmpdir()), path.relative(path.resolve(tmpdir()), selected))
          : selected;
      await this.allowed(appUrn, kind, target);
      const entry = await fs.promises.lstat(target, { bigint: true }).catch((error) => {
        if (absent(error)) return null;
        throw error;
      });
      if (!entry) return;
      const record = recordSchema.assert({
        version: 1,
        appUrn,
        kind,
        target,
        dev: entry.dev.toString(),
        ino: entry.ino.toString(),
        birthtimeNs: entry.birthtimeNs.toString(),
        uid: Number(entry.uid),
      });
      if (!this.matches(record, entry)) throw new Error('Backup staging is not privately owned');
      try {
        await this.remove(record);
      } catch {
        await this.retain(record);
        this.warn();
      }
    } catch {
      // Housekeeping must not mask the operation's original error or success.
      this.warn();
    }
  }

  async recover() {
    if (installationMode().phase !== 'normal' || coreCaptureRecoveryRequired() || corePreparationRecoveryHeld()) return;
    try {
      const directory = await this.directory(false);
      if (!directory) return;
      try {
        const names = (await fs.promises.readdir(process.platform === 'linux' ? `/proc/self/fd/${directory.handle.fd}/.` : directory.name)).filter(
          (name) => name.endsWith('.json') && uuid.test(name.slice(0, -5)),
        );
        if (names.length > 1024) this.warn();
        for (const name of names.slice(0, 1024)) {
          try {
            const file = pinned(directory.handle, name, directory.name);
            const handle = await fs.promises.open(file, flags);
            let record: Record;
            try {
              const before = await handle.stat({ bigint: true });
              if (
                !before.isFile() ||
                before.nlink !== 1n ||
                before.uid !== currentUid() ||
                (before.mode & 0o777n) !== 0o600n ||
                before.size < 1n ||
                before.size > 8192n
              )
                throw new Error('Invalid backup cleanup record');
              const bytes = await handle.readFile();
              if (
                BigInt(bytes.length) !== before.size ||
                fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(before) ||
                fileIdentity(await fs.promises.lstat(file, { bigint: true })) !== fileIdentity(before)
              )
                throw new Error('Backup cleanup record changed');
              record = recordSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            } finally {
              await handle.close();
            }
            await this.remove(record);
            await fs.promises.unlink(file);
            await directory.handle.sync();
          } catch {
            this.warn();
          }
        }
      } finally {
        await directory.handle.close();
      }
    } catch {
      this.warn();
    }
  }
}
