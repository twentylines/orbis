import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetJournalSchema, resetTargetNames, resetTargetPath, resetTargetPaths, type ResetAccounts, type ResetJournal } from './reset-contract';
import {
  acquireAuthorityLease,
  authorityJournalState,
  type DedicatedResetAuthority,
  readAuthorityJournal,
  resolveResetAuthority,
  saveAuthorityJournal,
} from './reset-authority';
import { type DescriptorRoot, ResetPreferenceStore, type RenameOperation } from './reset-preference-store';

export { resetJournalSchema };
export type { ResetAccounts, ResetJournal };

/**
 * Storage seams for tests and filesystem simulations. Production always constructs the facade with the data
 * directory only, so authority discovery uses this process's kernel mount table and preference moves use the
 * descriptor root. Nothing here is read from user configuration.
 */
export type ResetStateOptions = {
  readMounts?: () => Promise<string | null>;
  uid?: number | undefined;
  descriptorRoot?: DescriptorRoot;
  rename?: RenameOperation;
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Reset storage facade.
 *
 * A reset journal is only authoritative when it lives on a verified dedicated mount: an exact kernel mount
 * point at `<dataDir>/orbis-reset`, private, canonical, persistent and without an unfinished legacy journal.
 * Every other outcome keeps the strict legacy behavior, which owns `<dataDir>/state/orbis-reset` and rejects
 * group/world-writable ancestors. A Linux mount lookup that cannot answer fails closed instead of silently
 * hiding a present authority behind the legacy path.
 */
export class ResetState {
  private readonly preferences: ResetPreferenceStore;

  constructor(
    private readonly dataDir: string,
    private readonly options: ResetStateOptions = {},
  ) {
    this.preferences = new ResetPreferenceStore({
      dataDir: this.dataDir,
      uid: options.uid,
      descriptorRoot: options.descriptorRoot,
      rename: options.rename,
      readMounts: options.readMounts,
    });
  }

  /**
   * `null` means the legacy layout. On Linux an unreadable mount table, a present but unmounted directory,
   * an ephemeral mount or an unsafe mount root all throw: none of them may turn an interrupted reset into
   * an idle legacy one.
   */
  private async authority(): Promise<DedicatedResetAuthority | null> {
    // Development hosts and existing non-Linux tests have no reset mount namespace; keep their storage strict legacy.
    if (!this.options.readMounts && process.platform !== 'linux') return null;
    const resolved = await resolveResetAuthority({ dataDir: this.dataDir, ...this.options });
    return resolved.mode === 'dedicated' ? resolved : null;
  }

  async read(): Promise<ResetJournal | null> {
    const authority = await this.authority();
    if (authority) return readAuthorityJournal(authority);
    return this.legacyRead();
  }

  async active() {
    const authority = await this.authority();
    if (authority) return (await authorityJournalState(authority)).journal;
    return this.legacyActive();
  }

  async save(value: ResetJournal) {
    resetJournalSchema.assert(value);
    const authority = await this.authority();
    if (authority) return saveAuthorityJournal(authority, value);
    return this.legacySave(value);
  }

  async acquireLease() {
    const authority = await this.authority();
    if (authority) return acquireAuthorityLease(authority);
    return this.legacyAcquireLease();
  }

  async preflight(value: ResetJournal) {
    resetJournalSchema.assert(value);
    const authority = await this.authority();
    if (!authority) return this.legacyPreflight(value);
    const plan = await this.preferences.preflight(value.id, resetTargetPaths(this.dataDir, value));
    await plan.close();
  }

  async erasePreferences(value: ResetJournal) {
    resetJournalSchema.assert(value);
    const authority = await this.authority();
    if (!authority) return this.legacyErasePreferences(value);
    const stored = await readAuthorityJournal(authority);
    // Staging may only begin once this journal is durable on the authority mount. A missing or different
    // journal means no intent has been recorded, so the request fails closed instead of inventing one.
    if (
      !stored ||
      stored.id !== value.id ||
      stored.controller !== value.controller ||
      stored.accounts !== value.accounts ||
      stored.users.length !== value.users.length ||
      stored.users.some((id, index) => id !== value.users[index]) ||
      stored.phase === 'complete'
    )
      throw new Error('Reset storage needs local review.');
    return this.preferences.erase(value.id, resetTargetPaths(this.dataDir, value));
  }

  targets(value: ResetJournal) {
    return resetTargetNames(value);
  }

  private root() {
    return path.join(path.resolve(this.dataDir), 'state', 'orbis-reset');
  }

  private async legacyAcquireLease() {
    await this.directory(this.root(), true);
    const file = path.join(this.root(), 'operation.lock');
    const handle = await fs.open(file, 'wx', 0o600).catch(() => {
      throw new Error('Reset storage is locked. An interrupted process needs local recovery review.');
    });
    const identity = await handle.stat();
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.sync(this.root());
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const current = await fs.lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error('Reset lock changed. Local recovery review is required.');
      await fs.unlink(file);
      await this.sync(this.root());
    };
  }

  private async directory(directory: string, create = false) {
    const base = path.resolve(this.dataDir);
    if (directory !== base && !directory.startsWith(`${base}${path.sep}`)) throw new Error('Reset storage is outside Orbis state.');
    const relative = path.relative(base, directory).split(path.sep).filter(Boolean);
    let current = base;
    for (const segment of ['', ...relative]) {
      if (segment) current = path.join(current, segment);
      if (create)
        await fs.mkdir(current, { mode: 0o700 }).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      const stat = await fs.lstat(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(current)) !== current ||
        stat.mode & 0o022 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('Reset storage needs local review.');
    }
  }

  private async legacyRead(): Promise<ResetJournal | null> {
    try {
      // Existing Runtipi state directories may be writable by other services.
      // With no reset directory there is no reset journal to validate.
      await fs.lstat(this.root());
      await this.directory(this.root());
      const file = await fs.open(path.join(this.root(), 'active.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
          throw new Error('Invalid reset journal.');
        return resetJournalSchema.assert(JSON.parse(await file.readFile('utf8')));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private async legacyActive() {
    const journal = await this.legacyRead();
    if (journal?.phase === 'complete') {
      try {
        const lock = await fs.lstat(path.join(this.root(), 'operation.lock'));
        if (!lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1 || lock.mode & 0o077) throw new Error('Reset lock needs local review.');
        return { ...journal, phase: 'recovery' as const };
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    return journal;
  }

  private async legacySave(value: ResetJournal) {
    resetJournalSchema.assert(value);
    await this.directory(this.root(), true);
    const temporary = path.join(this.root(), `.journal-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, path.join(this.root(), 'active.json'));
      await this.sync(this.root());
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async sync(directory: string) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async inspect(target: string, count = { value: 0 }) {
    const stat = await fs.lstat(target);
    if (++count.value > 12000 || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Reset preferences need local review.');
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await this.inspect(path.join(target, name), count);
    } else if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('Reset preferences need local review.');
  }

  private async legacyPreflight(value: ResetJournal) {
    await this.directory(path.join(path.resolve(this.dataDir), 'state'));
    for (const relative of this.targets(value)) {
      const target = resetTargetPath(this.dataDir, relative);
      try {
        await this.directory(path.dirname(target));
        await this.inspect(target);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  private async legacyErasePreferences(value: ResetJournal) {
    await this.legacyPreflight(value);
    const staging = path.join(this.root(), value.id);
    await this.directory(staging, true);
    for (const [index, relative] of this.targets(value).entries()) {
      const target = resetTargetPath(this.dataDir, relative);
      const staged = path.join(staging, String(index));
      try {
        await this.directory(path.dirname(target));
        await this.inspect(target);
        try {
          await fs.lstat(staged);
          throw new Error('Reset preference was recreated during recovery.');
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await fs.rename(target, staged);
        await this.sync(path.dirname(target));
        await this.sync(staging);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    for (const name of await fs.readdir(staging)) {
      if (!/^\d+$/.test(name) || Number(name) >= this.targets(value).length) throw new Error('Reset staging needs local review.');
      await this.inspect(path.join(staging, name));
      await fs.rm(path.join(staging, name), { recursive: true });
    }
    await this.sync(staging);
  }
}
