import { randomUUID } from 'node:crypto';
import { readLatestTerminalPointer } from './backup-restore-terminal-record';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { withRestoreLease } from './backup-restore-lease';
import { BackupDirectorySwap } from './backup-directory-swap';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const containerId = /^[a-f0-9]{64}$/;
const phases = [
  'staging',
  'preparing',
  'discarded',
  'prepared',
  'quiescing',
  'promoting',
  'verifying',
  'committing',
  'completed',
  'rolling-back',
  'rolled-back',
] as const;
export type RestorePhase = (typeof phases)[number];
export type RestoreJournal = {
  version: 1;
  id: string;
  nonce: string;
  originalController: string;
  candidateController: string;
  verifierController?: string;
  worker: string;
  phase: RestorePhase;
  decision: 'commit' | 'rollback' | null;
  roots: string[];
};
const failed = () => new BackupRequirementError('The restore journal needs recovery. Server data has been preserved.');
const inside = (root: string, target: string) => target === root || target.startsWith(`${root}${path.sep}`);

function identity(value: unknown): value is { id: string; nonce: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.id === 'string' &&
    uuid.test(record.id) &&
    typeof record.nonce === 'string' &&
    uuid.test(record.nonce)
  );
}
function validate(value: unknown): asserts value is RestoreJournal {
  if (!value || typeof value !== 'object') throw failed();
  const item = value as RestoreJournal;
  if (
    Object.keys(item).length !== (item.verifierController === undefined ? 9 : 10) ||
    item.version !== 1 ||
    !uuid.test(item.id) ||
    !uuid.test(item.nonce) ||
    !containerId.test(item.originalController) ||
    !containerId.test(item.candidateController) ||
    !containerId.test(item.worker) ||
    (item.verifierController !== undefined &&
      (!containerId.test(item.verifierController) ||
        [item.originalController, item.candidateController, item.worker].includes(item.verifierController))) ||
    [item.originalController, item.candidateController].includes(item.worker) ||
    !phases.includes(item.phase) ||
    ![null, 'commit', 'rollback'].includes(item.decision) ||
    !Array.isArray(item.roots) ||
    !item.roots.length ||
    item.roots.length > 8 ||
    item.roots.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) ||
    new Set(item.roots).size !== item.roots.length ||
    (['staging', 'preparing', 'prepared', 'quiescing', 'promoting', 'verifying'].includes(item.phase) && item.decision !== null) ||
    (['committing', 'completed'].includes(item.phase) && item.decision !== 'commit') ||
    (['discarded', 'rolling-back', 'rolled-back'].includes(item.phase) && item.decision !== 'rollback')
  )
    throw failed();
}
async function readPrivate(file: string, limit = 16 * 1024) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writePrivate(file: string, value: unknown, exclusive = false) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
    // Remove the temporary hard link before readers enforce the one-link invariant.
    await fs.rm(temporary, { force: true });
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class BackupRestoreJournal {
  private constructor(
    readonly directory: string,
    private current: RestoreJournal,
  ) {}
  get state(): Readonly<RestoreJournal> {
    return structuredClone(this.current);
  }
  rootJournal(name: string) {
    if (!this.current.roots.includes(name)) throw failed();
    return path.join(this.directory, 'roots', name);
  }
  static async create(store: string, value: Omit<RestoreJournal, 'version' | 'phase' | 'decision'>) {
    const journal: RestoreJournal = { ...value, version: 1, phase: 'staging', decision: null };
    validate(journal);
    return withRestoreLease(store, async () => {
      const directory = path.join(store, journal.id);
      try {
        await fs.lstat(directory);
        throw failed();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const active = await BackupRestoreJournal.active(store);
      const retired = await retiredControllers(store);
      if ([journal.originalController, journal.candidateController, journal.worker].some((id) => retired.includes(id))) throw failed();
      if (active) {
        const previous = active.state;
        if (!['completed', 'rolled-back', 'discarded'].includes(previous.phase)) throw failed();
        const survivor = previous.phase === 'completed' ? previous.candidateController : previous.originalController;
        if (survivor !== journal.originalController) throw failed();
        await active.retireRootFiles(previous.phase === 'discarded');
        const removed = previous.phase === 'completed' ? previous.originalController : previous.candidateController;
        if (removed !== survivor && !retired.includes(removed)) retired.push(removed);
        if (retired.length > 4096) throw failed();
        await writePrivate(path.join(store, 'retired.json'), retired);
      }
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.mkdir(path.join(directory, 'roots'), { mode: 0o700 });
      await writePrivate(path.join(directory, 'restore.json'), journal, true);
      await syncDirectory(directory);
      await syncDirectory(store);
      // A failed exclusive claim leaves an inert private preparation; it never replaces an active restore.
      await writePrivate(path.join(store, 'active.json'), { id: journal.id, nonce: journal.nonce }, !active);
      return new BackupRestoreJournal(directory, journal);
    });
  }
  static async active(store: string) {
    try {
      await fs.lstat(store);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw failed();
    }
    try {
      await privateBackupDirectory(store);
      let pointer: unknown;
      try {
        pointer = await readPrivate(path.join(store, 'active.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (!identity(pointer)) throw failed();
      const directory = path.join(store, pointer.id);
      await privateBackupDirectory(directory);
      const state = await readPrivate(path.join(directory, 'restore.json'));
      validate(state);
      if (state.id !== pointer.id || state.nonce !== pointer.nonce) throw failed();
      return new BackupRestoreJournal(directory, state);
    } catch {
      throw failed();
    }
  }
  static async latest(store: string) {
    const active = await BackupRestoreJournal.active(store);
    if (active) return active;
    const pointer = await readLatestTerminalPointer(store);
    if (!pointer) return undefined;
    const directory = path.join(store, pointer.id);
    await privateBackupDirectory(directory);
    const state = await readPrivate(path.join(directory, 'restore.json'));
    validate(state);
    if (state.id !== pointer.id || state.nonce !== pointer.nonce || state.phase !== pointer.phase) throw failed();
    return new BackupRestoreJournal(directory, state);
  }
  async refresh() {
    const active = await BackupRestoreJournal.active(path.dirname(this.directory));
    if (!active || active.directory !== this.directory || active.current.nonce !== this.current.nonce) throw failed();
    const immutable = (value: RestoreJournal) => [
      value.id,
      value.nonce,
      value.originalController,
      value.candidateController,
      value.worker,
      value.verifierController,
      value.roots,
    ];
    if (JSON.stringify(immutable(active.current)) !== JSON.stringify(immutable(this.current))) throw failed();
    this.current = active.current;
    return this.state;
  }
  async advance(phase: RestorePhase) {
    await this.refresh();
    const previous = this.current.phase;
    const legal: Record<RestorePhase, RestorePhase[]> = {
      staging: ['preparing', 'prepared', 'discarded'],
      preparing: ['prepared', 'discarded'],
      discarded: [],
      prepared: ['quiescing', 'rolling-back'],
      quiescing: ['promoting', 'rolling-back'],
      promoting: ['verifying', 'rolling-back'],
      verifying: ['committing', 'rolling-back'],
      committing: ['completed'],
      completed: [],
      'rolling-back': ['rolled-back'],
      'rolled-back': [],
    };
    if (phase === previous) return;
    if (!legal[previous].includes(phase)) throw failed();
    if (phase === 'prepared') await this.verifyRootLocations(true);
    const decision = phase === 'committing' ? 'commit' : ['rolling-back', 'discarded'].includes(phase) ? 'rollback' : this.current.decision;
    const next = { ...this.current, phase, decision } as RestoreJournal;
    validate(next);
    await writePrivate(path.join(this.directory, 'restore.json'), next);
    this.current = next;
  }
  async verifyRootLocations(prepared = false) {
    const root = path.join(this.directory, 'roots');
    await privateBackupDirectory(root);
    const locations: string[] = [];
    for (const name of this.current.roots) {
      const file = path.join(root, name, 'swap.json');
      const swap = (await readPrivate(file, 64 * 1024 * 1024)) as { id?: unknown; root?: unknown; phase?: unknown };
      if (
        swap.id !== this.current.id ||
        typeof swap.root !== 'string' ||
        !path.isAbsolute(swap.root) ||
        path.resolve(swap.root) !== swap.root ||
        inside(swap.root, this.directory) ||
        (prepared && swap.phase !== 'prepared') ||
        locations.some((other) => inside(other, swap.root as string) || inside(swap.root as string, other))
      )
        throw failed();
      locations.push(swap.root);
    }
  }
  private async retireRootFiles(inert = false) {
    for (const name of this.current.roots) {
      const file = path.join(this.rootJournal(name), 'swap.json');
      let value: { id?: unknown; root?: unknown };
      try {
        value = (await readPrivate(file, 64 * 1024 * 1024)) as typeof value;
      } catch (error) {
        // Generation folders are created only after the durable per-root plan.
        if (inert && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw failed();
      }
      if (value.id !== this.current.id || typeof value.root !== 'string' || inside(value.root, this.directory)) throw failed();
      const swap = await BackupDirectorySwap.open(this.rootJournal(name));
      if (inert) await swap.discardPrepared();
      else await swap.cleanup();
    }
  }
  async discardStaging() {
    return withRestoreLease(path.dirname(this.directory), async () => {
      await this.refresh();
      if (this.current.phase === 'discarded') return;
      if (this.current.phase !== 'staging') throw failed();
      await this.retireRootFiles(true);
      await this.advance('discarded');
    });
  }
  // The caller holds the restore lease while planning and copying the backup.
  async backupExclusions(expectedRoots: Record<string, string>) {
    await this.refresh();
    if (!['completed', 'rolled-back', 'discarded'].includes(this.current.phase))
      throw new BackupRequirementError('Finish or discard the current restore before creating a full backup.');
    if (this.current.phase === 'discarded') return [];
    await this.verifyRootLocations();
    const directories: string[] = [];
    for (const name of this.current.roots) {
      if (!Object.hasOwn(expectedRoots, name)) throw failed();
      const swap = await BackupDirectorySwap.open(this.rootJournal(name));
      const retained = await swap.retainedDirectories();
      if (retained.id !== this.current.id || retained.root !== expectedRoots[name]) throw failed();
      directories.push(...retained.directories);
    }
    return directories;
  }
}

async function retiredControllers(store: string): Promise<string[]> {
  let value: unknown;
  try {
    value = await readPrivate(path.join(store, 'retired.json'), 512 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw failed();
  }
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    !value.every((id) => typeof id === 'string' && containerId.test(id)) ||
    new Set(value).size !== value.length
  )
    throw failed();
  return value;
}

export async function restoreControllerRetired(store: string, hostname: string) {
  try {
    await fs.lstat(store);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw failed();
  }
  await privateBackupDirectory(store);
  return (await retiredControllers(store)).some((id) => /^[a-f0-9]{12,64}$/.test(hostname) && id.startsWith(hostname));
}

export const restoreStartupAllowed = (state: RestoreJournal, hostname: string, installation?: { phase: string; transactionId: string | null }) => {
  if (!/^[a-f0-9]{12,64}$/.test(hostname)) return false;
  if (
    state.phase === 'verifying' &&
    state.verifierController?.startsWith(hostname) &&
    installation?.phase === 'hold' &&
    installation.transactionId === state.id
  )
    return true;
  if (state.phase === 'staging') return state.originalController.startsWith(hostname);
  if (state.decision === 'commit') return state.candidateController.startsWith(hostname);
  return ['rolled-back', 'discarded'].includes(state.phase) && state.originalController.startsWith(hostname);
};
