import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const prefix = '.orbis-restore-';
const maximumNames = 250_000;
const maximumPathBytes = 32 * 1024 * 1024;
const maximumJournalBytes = 64 * 1024 * 1024;
const failed = () => new BackupRequirementError('The restore files need recovery. Keep apps stopped until recovery has completed.');
type Attributes = { uid: number; gid: number; mode: number };
type Plan = {
  version: 1;
  id: string;
  root: string;
  device: string;
  inode: string;
  original: Attributes;
  incoming: string[];
  previous: string[];
  phase: 'staging' | 'prepared' | 'promoting' | 'rolling-back' | 'rolled-back' | 'committed';
};
type FileIdentity = { device: string; inode: string };
type Intent = FileIdentity & { kind: 'backup' | 'promote'; name: string };
const component = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  Buffer.byteLength(name) <= 255 &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !/[\uD800-\uDFFF]/u.test(name) &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const topLevelComponent = (name: unknown): name is string => component(name) && !name.startsWith(prefix);
const inside = (root: string, target: string) => target === root || target.startsWith(`${root}${path.sep}`);

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function directoryNames(directory: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return (await fs.readdir(directory, { encoding: 'buffer' })).map((name) => decoder.decode(name));
  } catch {
    throw failed();
  }
}
async function privateJson(file: string, value: unknown, exclusive = false) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maximumJournalBytes) throw failed();
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const output = await fs.open(temporary, 'wx', 0o600);
    try {
      await output.writeFile(encoded);
      await output.sync();
    } finally {
      await output.close();
    }
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function privateFile(file: string) {
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > maximumJournalBytes || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw failed();
    return await input.readFile();
  } finally {
    await input.close();
  }
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= maximumNames && value.every(topLevelComponent) && new Set(value).size === value.length;
}
function attributes(value: unknown): value is Attributes {
  if (!value || typeof value !== 'object') return false;
  const item = value as Attributes;
  return (
    Object.keys(item).length === 3 &&
    Number.isSafeInteger(item.uid) &&
    item.uid >= 0 &&
    item.uid <= 0xffffffff &&
    Number.isSafeInteger(item.gid) &&
    item.gid >= 0 &&
    item.gid <= 0xffffffff &&
    Number.isSafeInteger(item.mode) &&
    item.mode >= 0 &&
    item.mode <= 0o777
  );
}

// The caller must hold the durable restore lock and stop every writer before preparing or moving files.
export class BackupDirectorySwap {
  private constructor(
    private readonly journal: string,
    private readonly plan: Plan,
  ) {}
  get incomingDirectory() {
    return path.join(this.plan.root, `${prefix}${this.plan.id}.incoming`);
  }
  private get previousDirectory() {
    return path.join(this.plan.root, `${prefix}${this.plan.id}.previous`);
  }
  private get planFile() {
    return path.join(this.journal, 'swap.json');
  }
  private get eventFile() {
    return path.join(this.journal, 'moves.ndjson');
  }

  static async create(options: { id: string; root: string; journal: string }) {
    if (!uuid.test(options.id) || !path.isAbsolute(options.root) || !path.isAbsolute(options.journal)) throw failed();
    const root = path.resolve(options.root);
    const journal = path.resolve(options.journal);
    if (inside(root, journal) || Buffer.byteLength(root) > 4096 || Buffer.byteLength(journal) > 4096) throw failed();
    if ((await fs.realpath(root)) !== root) throw failed();
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failed();
    const previous = await directoryNames(root);
    if (!names(previous)) throw failed();
    const plan: Plan = {
      version: 1,
      id: options.id,
      root,
      device: String(stat.dev),
      inode: String(stat.ino),
      original: { uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode & 0o777n) },
      incoming: [],
      previous,
      phase: 'staging',
    };
    if (
      previous.reduce((bytes, name) => bytes + Buffer.byteLength(name), 0) > maximumPathBytes ||
      Buffer.byteLength(JSON.stringify(plan)) > maximumJournalBytes - 128
    )
      throw failed();
    await fs.lstat(path.dirname(journal));
    await privateBackupDirectory(path.dirname(journal));
    await fs.mkdir(journal, { mode: 0o700 });
    await privateBackupDirectory(journal);
    await syncDirectory(path.dirname(journal));
    const swap = new BackupDirectorySwap(journal, plan);
    await privateJson(swap.planFile, plan, true);
    await fs.mkdir(swap.incomingDirectory, { mode: 0o700 });
    await fs.mkdir(swap.previousDirectory, { mode: 0o700 });
    const events = await fs.open(swap.eventFile, 'wx', 0o600);
    try {
      await events.sync();
    } finally {
      await events.close();
    }
    await syncDirectory(root);
    await syncDirectory(journal);
    return swap;
  }

  static async open(journal: string) {
    await privateBackupDirectory(journal);
    let value: Plan;
    try {
      value = JSON.parse((await privateFile(path.join(journal, 'swap.json'))).toString('utf8'));
    } catch {
      throw failed();
    }
    if (
      !value ||
      Object.keys(value).length !== 9 ||
      value.version !== 1 ||
      !uuid.test(value.id) ||
      !path.isAbsolute(value.root) ||
      Buffer.byteLength(value.root) > 4096 ||
      path.resolve(value.root) !== value.root ||
      inside(value.root, path.resolve(journal)) ||
      !/^[0-9]{1,32}$/.test(value.device) ||
      !/^[0-9]{1,32}$/.test(value.inode) ||
      !attributes(value.original) ||
      !names(value.incoming) ||
      !names(value.previous) ||
      [...value.incoming, ...value.previous].reduce((bytes, name) => bytes + Buffer.byteLength(name), 0) > maximumPathBytes ||
      !['staging', 'prepared', 'promoting', 'rolling-back', 'rolled-back', 'committed'].includes(value.phase)
    )
      throw failed();
    const swap = new BackupDirectorySwap(journal, value);
    await swap.checkRoot();
    return swap;
  }
  private async checkRoot() {
    if ((await fs.realpath(this.plan.root)) !== this.plan.root) throw failed();
    const root = await fs.lstat(this.plan.root, { bigint: true });
    if (!root.isDirectory() || String(root.dev) !== this.plan.device || String(root.ino) !== this.plan.inode) throw failed();
    for (const directory of [this.incomingDirectory, this.previousDirectory]) {
      if (await exists(directory)) await privateBackupDirectory(directory);
      else if (!['staging', 'rolling-back', 'rolled-back', 'committed'].includes(this.plan.phase)) throw failed();
    }
  }
  private async save(phase: Plan['phase']) {
    await privateJson(this.planFile, { ...this.plan, phase });
    this.plan.phase = phase;
  }
  private async refresh() {
    const current = (await BackupDirectorySwap.open(this.journal)).plan;
    const identity = (plan: Plan) => [plan.id, plan.root, plan.device, plan.inode, plan.original, plan.previous];
    if (JSON.stringify(identity(current)) !== JSON.stringify(identity(this.plan))) throw failed();
    this.plan.phase = current.phase;
    this.plan.incoming = current.incoming;
  }
  async seal(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.refresh();
    if (this.plan.phase !== 'staging') throw failed();
    await this.checkRoot();
    if (!(await exists(this.incomingDirectory)) || !(await exists(this.previousDirectory))) throw failed();
    const incoming = await directoryNames(this.incomingDirectory);
    if (!names(incoming) || [...incoming, ...this.plan.previous].reduce((bytes, name) => bytes + Buffer.byteLength(name), 0) > maximumPathBytes)
      throw failed();
    let entries = 0;
    let pathBytes = 0;
    const visit = async (file: string): Promise<void> => {
      signal.throwIfAborted();
      entries++;
      pathBytes += Buffer.byteLength(path.relative(this.incomingDirectory, file));
      if (entries > maximumNames || pathBytes > maximumPathBytes) throw failed();
      const stat = await fs.lstat(file, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        String(stat.dev) !== this.plan.device ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1n)
      )
        throw failed();
      if (stat.isDirectory()) {
        for (const name of await directoryNames(file)) {
          if (!component(name)) throw failed();
          await visit(path.join(file, name));
        }
        await syncDirectory(file);
      } else {
        const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          await input.sync();
        } finally {
          await input.close();
        }
      }
    };
    for (const name of incoming) await visit(path.join(this.incomingDirectory, name));
    await syncDirectory(this.incomingDirectory);
    this.plan.incoming = incoming;
    const estimatedEvents = [...incoming, ...this.plan.previous].reduce(
      (bytes, name) => bytes + Buffer.byteLength(JSON.stringify({ kind: 'promote', name, device: '9'.repeat(32), inode: '9'.repeat(32) })) + 1,
      0,
    );
    if (Buffer.byteLength(JSON.stringify(this.plan)) > maximumJournalBytes - 128 || estimatedEvents > maximumJournalBytes) throw failed();
    signal.throwIfAborted();
    await this.save('prepared');
    signal.throwIfAborted();
  }
  private async readIntents() {
    const bytes = await privateFile(this.eventFile);
    const last = bytes.lastIndexOf(10);
    const complete = last < 0 ? Buffer.alloc(0) : bytes.subarray(0, last + 1);
    if (bytes.length - complete.length > 1024) throw failed();
    const intents: Intent[] = [];
    const seen = new Set<string>();
    const previous = new Set(this.plan.previous);
    const incoming = new Set(this.plan.incoming);
    let promoting = false;
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(complete).split('\n').filter(Boolean)) {
      let item: Intent;
      try {
        item = JSON.parse(line);
      } catch {
        throw failed();
      }
      if (
        !item ||
        Object.keys(item).length !== 4 ||
        !topLevelComponent(item.name) ||
        !['backup', 'promote'].includes(item.kind) ||
        !/^[0-9]{1,32}$/.test(item.device) ||
        !/^[0-9]{1,32}$/.test(item.inode) ||
        !(item.kind === 'backup' ? previous : incoming).has(item.name) ||
        seen.has(`${item.kind}/${item.name}`)
      )
        throw failed();
      if (item.kind === 'promote') {
        if (!promoting && intents.length !== previous.size) throw failed();
        promoting = true;
      } else if (promoting) throw failed();
      seen.add(`${item.kind}/${item.name}`);
      intents.push(item);
    }
    return intents;
  }
  private async intent(kind: Intent['kind'], name: string, source: string) {
    const stat = await fs.lstat(source, { bigint: true });
    const item: Intent = { kind, name, device: String(stat.dev), inode: String(stat.ino) };
    const output = await fs.open(this.eventFile, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      await output.writeFile(`${JSON.stringify(item)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    return item;
  }
  private async matches(file: string, identity: FileIdentity) {
    try {
      const stat = await fs.lstat(file, { bigint: true });
      return String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async move(from: string, to: string, identity: FileIdentity) {
    await this.checkRoot();
    if (!(await this.matches(from, identity)) || (await exists(to))) throw failed();
    await fs.rename(from, to);
    await syncDirectory(path.dirname(from));
    await syncDirectory(path.dirname(to));
  }
  async promote(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.refresh();
    if (this.plan.phase !== 'prepared') throw failed();
    await this.checkRoot();
    if ((await privateFile(this.eventFile)).length) throw failed();
    const current = (await directoryNames(this.plan.root)).filter(
      (name) => name !== path.basename(this.incomingDirectory) && name !== path.basename(this.previousDirectory),
    );
    const previous = new Set(this.plan.previous);
    if (current.length !== previous.size || current.some((name) => !previous.has(name))) throw failed();
    signal.throwIfAborted();
    await this.save('promoting');
    for (const name of this.plan.previous) {
      signal.throwIfAborted();
      const source = path.join(this.plan.root, name);
      const intent = await this.intent('backup', name, source);
      await this.move(source, path.join(this.previousDirectory, name), intent);
    }
    for (const name of this.plan.incoming) {
      signal.throwIfAborted();
      const source = path.join(this.incomingDirectory, name);
      const intent = await this.intent('promote', name, source);
      await this.move(source, path.join(this.plan.root, name), intent);
    }
    signal.throwIfAborted();
  }
  async rollback() {
    await this.refresh();
    if (this.plan.phase === 'committed') throw failed();
    await this.checkRoot();
    if (this.plan.phase === 'rolled-back') return;
    const intents = (await exists(this.eventFile)) ? await this.readIntents() : [];
    const originals = new Map(intents.filter((item) => item.kind === 'backup').map((item) => [item.name, item]));
    await this.save('rolling-back');
    for (const item of intents.filter((item) => item.kind === 'promote').reverse()) {
      const incoming = path.join(this.incomingDirectory, item.name);
      const target = path.join(this.plan.root, item.name);
      const previous = path.join(this.previousDirectory, item.name);
      const hasIncoming = await exists(incoming);
      const hasTarget = await exists(target);
      if (hasIncoming && !(await this.matches(incoming, item))) throw failed();
      if (hasTarget) {
        if (await this.matches(target, item)) {
          if (hasIncoming) throw failed();
          await this.move(target, incoming, item);
        } else {
          const original = originals.get(item.name);
          if (!original || !(await this.matches(target, original)) || (await exists(previous))) throw failed();
        }
      }
    }
    for (const item of intents.filter((item) => item.kind === 'backup').reverse()) {
      const previous = path.join(this.previousDirectory, item.name);
      const target = path.join(this.plan.root, item.name);
      if (await exists(previous)) await this.move(previous, target, item);
      else if (!(await this.matches(target, item))) throw failed();
    }
    const current = await fs.stat(this.plan.root);
    const original = this.plan.original;
    if (current.uid !== original.uid || current.gid !== original.gid) await fs.chown(this.plan.root, original.uid, original.gid);
    await fs.chmod(this.plan.root, original.mode);
    await syncDirectory(this.plan.root);
    await this.save('rolled-back');
  }
  async commit() {
    await this.refresh();
    if (this.plan.phase === 'committed') return;
    if (this.plan.phase !== 'promoting') throw failed();
    await this.checkRoot();
    const intents = await this.readIntents();
    const promoted = new Set(intents.filter((item) => item.kind === 'promote').map((item) => item.name));
    if (
      intents.length !== this.plan.previous.length + this.plan.incoming.length ||
      (await directoryNames(this.incomingDirectory)).length ||
      this.plan.incoming.some((name) => !promoted.has(name))
    )
      throw failed();
    for (const item of intents) {
      if (!(await this.matches(path.join(item.kind === 'backup' ? this.previousDirectory : this.plan.root, item.name), item))) throw failed();
    }
    const current = (await directoryNames(this.plan.root)).filter(
      (name) => name !== path.basename(this.incomingDirectory) && name !== path.basename(this.previousDirectory),
    );
    if (current.length !== promoted.size || current.some((name) => !promoted.has(name))) throw failed();
    await this.save('committed');
  }
  async cleanup() {
    await this.refresh();
    if (!['committed', 'rolled-back'].includes(this.plan.phase)) throw failed();
    await this.checkRoot();
    for (const directory of [this.incomingDirectory, this.previousDirectory]) {
      if (await exists(directory)) {
        await privateBackupDirectory(directory);
        await fs.rm(directory, { recursive: true });
        await syncDirectory(this.plan.root);
      }
    }
  }
  async retainedDirectories() {
    await this.refresh();
    if (!['committed', 'rolled-back'].includes(this.plan.phase)) throw failed();
    await this.checkRoot();
    const directories: string[] = [];
    for (const directory of [this.incomingDirectory, this.previousDirectory]) if (await exists(directory)) directories.push(directory);
    return { id: this.plan.id, root: this.plan.root, directories };
  }
  async discardPrepared() {
    await this.refresh();
    if (this.plan.phase === 'rolled-back') return this.cleanup();
    if (!['staging', 'prepared'].includes(this.plan.phase) || ((await exists(this.eventFile)) && (await this.readIntents()).length)) throw failed();
    // Inert staging never moved target data. Do not reset root attributes while apps may still be running.
    await this.save('rolled-back');
    await this.cleanup();
  }
}
