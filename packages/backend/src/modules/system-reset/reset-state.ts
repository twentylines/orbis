import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type } from 'arktype';

export type ResetAccounts = 'keep' | 'remove';
export const resetJournalSchema = type({
  '+': 'reject',
  version: '1',
  id: 'string.uuid',
  controller: 'string > 0 & string <= 253',
  accounts: "'keep' | 'remove'",
  users: 'number.integer > 0[]',
  phase: "'prepared' | 'preferences' | 'accounts' | 'complete' | 'recovery'",
  createdAt: 'number.integer > 0',
}).narrow((value) => value.users.length <= 256 && new Set(value.users).size === value.users.length && value.users.every(Number.isSafeInteger));
export type ResetJournal = typeof resetJournalSchema.infer;
const scopes = ['desktop', 'onboarding', 'theme-settings', 'theme-packs', 'wallpapers'] as const;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class ResetState {
  constructor(private readonly dataDir: string) {}
  private root() {
    return path.join(path.resolve(this.dataDir), 'state', 'orbis-reset');
  }
  async acquireLease() {
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
  async read(): Promise<ResetJournal | null> {
    try {
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
  async active() {
    const journal = await this.read();
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
  async save(value: ResetJournal) {
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
  targets(value: ResetJournal) {
    resetJournalSchema.assert(value);
    return [
      ...value.users.flatMap((id) => [
        ...scopes.map((scope) => `${scope}/${id}${scope === 'theme-packs' ? '' : scope === 'wallpapers' ? '.image' : '.json'}`),
        `wallpapers/${id}.image.saved`,
      ]),
      '.orbis-onboarding-origin.json',
      ...(value.accounts === 'remove' ? ['password-change-request'] : []),
    ];
  }
  private target(relative: string) {
    return relative === '.orbis-onboarding-origin.json'
      ? path.join(path.resolve(this.dataDir), relative)
      : path.join(path.resolve(this.dataDir), 'state', relative);
  }
  private async inspect(target: string, count = { value: 0 }) {
    const stat = await fs.lstat(target);
    if (++count.value > 12000 || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Reset preferences need local review.');
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await this.inspect(path.join(target, name), count);
    } else if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('Reset preferences need local review.');
  }
  async preflight(value: ResetJournal) {
    await this.directory(path.join(path.resolve(this.dataDir), 'state'));
    for (const relative of this.targets(value)) {
      const target = this.target(relative);
      try {
        await this.directory(path.dirname(target));
        await this.inspect(target);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
  async erasePreferences(value: ResetJournal) {
    await this.preflight(value);
    const staging = path.join(this.root(), value.id);
    await this.directory(staging, true);
    for (const [index, relative] of this.targets(value).entries()) {
      const target = this.target(relative);
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
