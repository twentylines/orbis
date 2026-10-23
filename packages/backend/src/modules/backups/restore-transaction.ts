import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateAppUrn } from '@/common/helpers/app-helpers';
import { spawnAsync } from '@/common/helpers/exec-helpers';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import { assertNoRestoreMounts } from './restore-mounts';
import { validateBackupTree } from './backup-links';

const groups = ['app-data', 'app', 'user-config'] as const;
type Group = (typeof groups)[number];
type Entry = { name: Group; target: string; parent: string; existed: boolean };
type Journal = { version: 1; appUrn: AppUrn; id: string; phase: 'preparing' | 'swapping' | 'committed'; entries: Entry[] };
type Locations = Record<Group, string>;
type Sources = Record<Group, string | null>;

const stat = async (file: string) =>
  fs.promises.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

const syncDirectory = async (directory: string) => {
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const requireDirectory = async (directory: string) => {
  const value = await stat(directory);
  if (!value?.isDirectory()) throw new Error('Restore directory is missing or is not a regular directory');
};

const ensureDirectory = async (directory: string) => {
  if (!(await stat(directory))) await fs.promises.mkdir(directory, { mode: 0o700 });
  await requireDirectory(directory);
};

const visitCopiedTree = async (source: string, destination: string, apply: boolean) => {
  const original = await fs.promises.lstat(source, { bigint: true });
  const copied = await fs.promises.lstat(destination, { bigint: true });
  if (!original.isFile() && !original.isDirectory() && !original.isSymbolicLink()) throw new Error('Backup contains unsupported file types');
  if (
    original.isDirectory() !== copied.isDirectory() ||
    original.isFile() !== copied.isFile() ||
    original.isSymbolicLink() !== copied.isSymbolicLink()
  )
    throw new Error('Backup copy is incomplete');
  if (original.isSymbolicLink() && (await fs.promises.readlink(source)) !== (await fs.promises.readlink(destination)))
    throw new Error('Backup copy changed a symbolic link');
  if (original.isSymbolicLink() && !apply) {
    // GNU cp must recreate copied links to preserve their ownership and nanosecond timestamps.
    await fs.promises.unlink(destination);
    return;
  }
  if (original.isDirectory()) {
    for (const name of await fs.promises.readdir(source)) await visitCopiedTree(path.join(source, name), path.join(destination, name), apply);
  }
  if (apply) {
    if (original.isSymbolicLink()) {
      await fs.promises.unlink(destination);
      const result = await spawnAsync('cp', ['-pP', '--', source, destination]);
      if (result.stderr.trim()) throw new Error('Backup symbolic link metadata could not be preserved');
      return;
    }
    if (original.uid !== copied.uid || original.gid !== copied.gid) await fs.promises.chown(destination, Number(original.uid), Number(original.gid));
    await fs.promises.chmod(destination, Number(original.mode & 0o7777n));
    const result = await spawnAsync('touch', ['-r', source, '--', destination]);
    if (result.stderr.trim()) throw new Error('Backup timestamps could not be preserved');
  }
};

const verifyCopiedMetadata = async (source: string, destination: string): Promise<void> => {
  const original = await fs.promises.lstat(source, { bigint: true });
  const copied = await fs.promises.lstat(destination, { bigint: true });
  if (original.uid !== copied.uid || original.gid !== copied.gid || original.mode !== copied.mode || original.mtimeNs !== copied.mtimeNs)
    throw new Error('Backup copy did not preserve file metadata');
  if (original.isDirectory())
    for (const name of await fs.promises.readdir(source)) await verifyCopiedMetadata(path.join(source, name), path.join(destination, name));
};

export const preserveTreeMetadata = async (source: string, destination: string, allowLinks = true) => {
  await validateBackupTree(source, allowLinks);
  await visitCopiedTree(source, destination, process.platform !== 'linux');
  if (process.platform === 'linux') {
    // One metadata pass per tree avoids a process per file and does not recopy data.
    const reference = (await fs.promises.lstat(source)).isDirectory() ? `${source}/.` : source;
    const result = await spawnAsync('cp', [
      '--attributes-only',
      '--preserve=mode,ownership,timestamps',
      '--recursive',
      '--no-dereference',
      '--',
      reference,
      destination,
    ]);
    if (result.stderr.trim()) throw new Error('Backup file metadata could not be preserved');
  }
  await verifyCopiedMetadata(source, destination);
};

const syncTree = async (directory: string) => {
  await requireDirectory(directory);
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(file);
    else if (entry.isFile()) {
      const handle = await fs.promises.open(file, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else if (!entry.isSymbolicLink()) throw new Error('Backup contains unsupported file types');
  }
  await syncDirectory(directory);
};

export class RestoreTransaction {
  private readonly active = new Set<AppUrn>();

  constructor(
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
    private readonly root: () => string,
    private readonly locations: (appUrn: AppUrn) => Locations,
    private readonly reconcile: (appUrn: AppUrn) => Promise<void> = async () => undefined,
    private readonly checkMounts: (directory: string) => Promise<void> = assertNoRestoreMounts,
  ) {}

  private directory(appUrn: AppUrn) {
    validateAppUrn(appUrn);
    return this.filesystem.getSafeFilePath(path.join(this.root(), appUrn));
  }

  private workspace(journal: Journal, entry: Entry) {
    return path.join(path.dirname(entry.target), `.${path.basename(entry.target)}.orbis-restore-${journal.id}`);
  }

  public async pendingApps(): Promise<AppUrn[]> {
    if (!(await stat(this.root()))) return [];
    await requireDirectory(path.dirname(this.root()));
    await requireDirectory(this.root());
    const pending: AppUrn[] = [];
    for (const entry of await fs.promises.readdir(this.root(), { withFileTypes: true })) {
      if (!entry.isDirectory()) throw new Error('Restore recovery journal is not a regular directory');
      pending.push(validateAppUrn(entry.name));
    }
    return pending;
  }

  public async isPending(appUrn: AppUrn) {
    if (await stat(path.dirname(this.root()))) await requireDirectory(path.dirname(this.root()));
    if (await stat(this.root())) await requireDirectory(this.root());
    const directory = this.directory(appUrn);
    if (!(await stat(directory))) return false;
    await requireDirectory(directory);
    return true;
  }

  private async write(journal: Journal) {
    const directory = this.directory(journal.appUrn);
    const temporary = path.join(directory, `journal-${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(temporary, path.join(directory, 'journal.json'));
      await syncDirectory(directory);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  private async read(appUrn: AppUrn): Promise<Journal | null> {
    const file = path.join(this.directory(appUrn), 'journal.json');
    const value = await stat(file);
    if (!value) return null;
    if (!value.isFile() || value.nlink !== 1 || value.size > 65536) throw new Error('Invalid restore recovery journal');
    const record = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Journal;
    const locations = this.locations(appUrn);
    if (
      record?.version !== 1 ||
      record.appUrn !== appUrn ||
      typeof record.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.id) ||
      !['preparing', 'swapping', 'committed'].includes(record.phase) ||
      !Array.isArray(record.entries) ||
      record.entries.length !== groups.length
    )
      throw new Error('Invalid restore recovery journal');
    for (const [index, name] of groups.entries()) {
      const entry = record.entries[index];
      if (entry?.name !== name || entry.target !== locations[name] || typeof entry.existed !== 'boolean' || typeof entry.parent !== 'string')
        throw new Error('Restore locations changed; the recovery journal has been preserved');
      await this.checkParent(entry);
      const workspace = this.workspace(record, entry);
      if (await stat(workspace)) {
        await requireDirectory(workspace);
        await this.checkMounts(workspace);
      }
      if (await stat(entry.target)) await this.checkMounts(entry.target);
    }
    return record;
  }

  private async checkParent(entry: Entry) {
    await requireDirectory(path.dirname(entry.target));
    if ((await fs.promises.realpath(path.dirname(entry.target))) !== entry.parent)
      throw new Error('Restore locations changed; the recovery journal has been preserved');
  }

  private async rename(source: string, destination: string) {
    await fs.promises.rename(source, destination);
    await syncDirectory(path.dirname(source));
    if (path.dirname(source) !== path.dirname(destination)) await syncDirectory(path.dirname(destination));
  }

  private async cleanup(journal: Journal) {
    for (const entry of journal.entries) {
      await this.checkParent(entry);
      const workspace = this.workspace(journal, entry);
      if (await stat(workspace)) await this.checkMounts(workspace);
      await fs.promises.rm(workspace, { recursive: true, force: true });
      await syncDirectory(path.dirname(entry.target));
    }
    await fs.promises.rm(this.directory(journal.appUrn), { recursive: true });
    await syncDirectory(this.root());
  }

  private async recoverUnlocked(appUrn: AppUrn) {
    if (!(await this.isPending(appUrn))) return;
    const journal = await this.read(appUrn);
    if (!journal) {
      // No live rename can precede the first durable journal, or follow its final removal.
      await fs.promises.rm(this.directory(appUrn), { recursive: true });
      await syncDirectory(this.root());
      return;
    }
    if (journal.phase === 'swapping') {
      for (const entry of [...journal.entries].reverse()) {
        await this.checkParent(entry);
        const workspace = this.workspace(journal, entry);
        const previous = path.join(workspace, 'previous');
        const incoming = path.join(workspace, 'incoming');
        const discarded = path.join(workspace, 'discarded');
        const original = await stat(previous);
        const target = await stat(entry.target);
        if (original) {
          await requireDirectory(previous);
          if (target) {
            await requireDirectory(entry.target);
            await this.rename(entry.target, discarded);
          }
          await this.rename(previous, entry.target);
        } else if (entry.existed) {
          await requireDirectory(entry.target);
        } else if (target && !(await stat(incoming))) {
          await requireDirectory(entry.target);
          await this.rename(entry.target, discarded);
        }
      }
    } else if (journal.phase === 'committed') {
      for (const entry of journal.entries) await requireDirectory(entry.target);
    }
    await this.reconcile(appUrn);
    await this.cleanup(journal);
  }

  public async recover(appUrn: AppUrn) {
    if (this.active.has(appUrn)) throw new Error('An app restore is already in progress');
    this.active.add(appUrn);
    try {
      await this.recoverUnlocked(appUrn);
    } finally {
      this.active.delete(appUrn);
    }
  }

  public async replace(appUrn: AppUrn, prepare: Sources | ((directory: string) => Promise<Sources>)) {
    if (this.active.has(appUrn)) throw new Error('An app restore is already in progress');
    this.active.add(appUrn);
    try {
      await this.recoverUnlocked(appUrn);
      const root = this.filesystem.getSafeFilePath(this.root());
      await ensureDirectory(path.dirname(root));
      await ensureDirectory(root);
      await syncDirectory(path.dirname(root));
      const locations = this.locations(appUrn);
      const entries: Entry[] = [];
      for (const name of groups) {
        const target = this.filesystem.getSafeFilePath(locations[name]);
        await fs.promises.mkdir(path.dirname(path.dirname(target)), { recursive: true });
        await ensureDirectory(path.dirname(target));
        const current = await stat(target);
        if (current && !current.isDirectory()) throw new Error('Live restore destination is not a regular directory');
        if (current) await this.checkMounts(target);
        entries.push({ name, target, parent: await fs.promises.realpath(path.dirname(target)), existed: Boolean(current) });
      }
      const journal: Journal = { version: 1, appUrn, id: randomUUID(), phase: 'preparing', entries };
      await fs.promises.mkdir(this.directory(appUrn), { mode: 0o700 });
      await syncDirectory(root);
      try {
        await this.write(journal);
        for (const entry of entries) {
          const workspace = this.workspace(journal, entry);
          await fs.promises.mkdir(workspace, { mode: 0o700 });
          await syncDirectory(path.dirname(workspace));
        }
        let sources: Sources;
        let extraction: string | undefined;
        if (typeof prepare === 'function') {
          const dataEntry = entries[0];
          if (!dataEntry) throw new Error('Missing app data restore location');
          extraction = path.join(this.workspace(journal, dataEntry), 'extracted');
          await fs.promises.mkdir(extraction, { mode: 0o700 });
          sources = await prepare(extraction);
        } else sources = prepare;
        for (const entry of entries) {
          const workspace = this.workspace(journal, entry);
          const incoming = path.join(workspace, 'incoming');
          const source = sources[entry.name];
          if (source) {
            let moved = false;
            if (extraction) {
              const relative = path.relative(extraction, source);
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid restore staging location');
              await requireDirectory(source);
              try {
                await fs.promises.rename(source, incoming);
                await syncDirectory(path.dirname(source));
                moved = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
              }
            }
            if (!moved) {
              if (!(await this.filesystem.copyDirectory(source, incoming, { preserveTimestamps: true, verbatimSymlinks: true, dereference: false })))
                throw new Error('App files could not be staged for restore');
              await preserveTreeMetadata(source, incoming);
            }
          } else await fs.promises.mkdir(incoming);
          await validateBackupTree(incoming);
          await syncTree(incoming);
          await syncDirectory(workspace);
          await syncDirectory(path.dirname(workspace));
        }
        journal.phase = 'swapping';
        await this.write(journal);
        for (const entry of entries) {
          await this.checkParent(entry);
          if (await stat(entry.target)) await this.checkMounts(entry.target);
          const workspace = this.workspace(journal, entry);
          if (entry.existed) await this.rename(entry.target, path.join(workspace, 'previous'));
          else if (await stat(entry.target)) throw new Error('Restore destination changed while staging');
          await this.rename(path.join(workspace, 'incoming'), entry.target);
        }
        journal.phase = 'committed';
        await this.write(journal);
      } catch (error) {
        try {
          await this.recoverUnlocked(appUrn);
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            'Restore recovery is incomplete. Original directories and the recovery journal were preserved.',
          );
        }
        throw error;
      }
      await this.reconcile(appUrn);
      try {
        await this.cleanup(journal);
      } catch (error) {
        this.logger.warn('Restore completed; previous-directory cleanup will be retried before the next app operation', error);
      }
    } finally {
      this.active.delete(appUrn);
    }
  }
}
