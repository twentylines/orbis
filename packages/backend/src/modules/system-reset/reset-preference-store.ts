import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { lookupResetMount } from './reset-authority';

/**
 * Pinned preference erasure for reset.
 *
 * Preference files must live in the legacy `state` tree, and that tree may be a shared directory. Path-based
 * `lstat` followed by `rename` is not safe there: another writer can rename the parent between the check and
 * the move. Every directory this module touches is therefore opened once with `O_DIRECTORY | O_NOFOLLOW` and
 * addressed through the kernel descriptor root (`/proc/self/fd/<fd>` on Linux), so the operations are anchored
 * to the inode that was validated, not to a re-resolved path. On platforms without that descriptor root the
 * module fails closed with `unavailable`; it never silently degrades to path renames.
 *
 * Staging is deliberately placed in the *same directory* as the preference it replaces. A dedicated reset
 * authority mount is a different mount, so moving preferences into it would return `EXDEV` even when the host
 * filesystem is the same. Same-directory staging makes the cross-device case structurally impossible, and the
 * device check below still fails closed if it ever happened.
 *
 * The staging directory is bound to the reset journal id and records the inode identity of every target. A
 * resumed erase therefore proves it continues the same journal, and a swapped or recreated preference fails
 * closed instead of being deleted blindly.
 *
 */

export const STAGE_PREFIX = '.orbis-reset-stage-';
const MAX_TARGETS = 4096;
const MAX_ENTRIES = 12_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BINDING_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARED_STATE_MOUNT = Symbol('verified shared state mount');

export type ResetPreferenceErrorCode =
  | 'unavailable'
  | 'unsafe'
  | 'cross-device'
  | 'identity-changed'
  | 'stage-conflict'
  | 'stage-invalid'
  | 'rename-failed';

/** The message stays generic for clients; the code and detail are for server-side logs only. */
export class ResetPreferenceError extends Error {
  constructor(
    readonly code: ResetPreferenceErrorCode,
    readonly detail: Record<string, string | number> = {},
  ) {
    super('Reset preferences need local review.');
    this.name = 'ResetPreferenceError';
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const exists = async (target: string) =>
  fs.lstat(target).then(
    () => true,
    (error: unknown) => {
      if (missing(error)) return false;
      throw error;
    },
  );

const safeName = (name: string) =>
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  name.length <= 255 &&
  !name.includes('/') &&
  !name.includes('\\') &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export type DescriptorRoot = (fd: number, directory: string) => string;
export type RenameOperation = (from: string, to: string) => Promise<void>;

const linuxDescriptorRoot: DescriptorRoot = (fd) => {
  if (process.platform !== 'linux') throw new ResetPreferenceError('unavailable');
  return `/proc/self/fd/${fd}`;
};

export type PinOptions = {
  private?: boolean;
  uid?: number | undefined;
  descriptorRoot?: DescriptorRoot;
  rename?: RenameOperation;
  /** Skip the canonical-path check when the path itself is already anchored to an open descriptor. */
  anchored?: boolean;
  sharedStateMount?: typeof SHARED_STATE_MOUNT;
};

type Identity = { dev: number; ino: number };

/**
 * A directory held open for the duration of the erase. All children are addressed through `reference`, which
 * the kernel resolves from the open file, not from the caller's path.
 */
export class PinnedDirectory {
  private closed = false;
  private constructor(
    private readonly handle: fs.FileHandle,
    readonly identity: Identity,
    readonly reference: string,
    readonly directory: string,
    private readonly rename: RenameOperation,
  ) {}

  static async open(directory: string, options: PinOptions = {}) {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new ResetPreferenceError('unsafe', { reason: 'canonical' });
    const uid = options.uid ?? process.getuid?.();
    const before = await fs.lstat(directory).catch((error: unknown) => {
      if (missing(error)) throw new ResetPreferenceError('unsafe', { reason: 'missing' });
      throw error;
    });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new ResetPreferenceError('unsafe', { reason: 'type' });
    if (!options.anchored && (await fs.realpath(directory)) !== directory) throw new ResetPreferenceError('unsafe', { reason: 'canonical' });
    if ((before.mode & 0o022) !== 0 && options.sharedStateMount !== SHARED_STATE_MOUNT)
      throw new ResetPreferenceError('unsafe', { reason: 'shared' });
    if (options.private && (before.mode & 0o077) !== 0) throw new ResetPreferenceError('unsafe', { reason: 'permissions' });
    if (uid !== undefined && before.uid !== uid) throw new ResetPreferenceError('unsafe', { reason: 'owner' });
    const handle = await fs.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW).catch((error: unknown) => {
      throw new ResetPreferenceError('unsafe', { reason: (error as NodeJS.ErrnoException).code ?? 'open' });
    });
    try {
      const stat = await handle.stat();
      if (
        !stat.isDirectory() ||
        stat.dev !== before.dev ||
        stat.ino !== before.ino ||
        ((stat.mode & 0o022) !== 0 && options.sharedStateMount !== SHARED_STATE_MOUNT) ||
        (uid !== undefined && stat.uid !== uid)
      )
        throw new ResetPreferenceError('unsafe', { reason: 'changed' });
      const reference = (options.descriptorRoot ?? linuxDescriptorRoot)(handle.fd, directory);
      const seen = await fs.stat(reference).catch(() => {
        throw new ResetPreferenceError('unavailable');
      });
      if (!seen.isDirectory() || seen.dev !== stat.dev || seen.ino !== stat.ino) throw new ResetPreferenceError('unavailable');
      return new PinnedDirectory(handle, { dev: stat.dev, ino: stat.ino }, reference, directory, options.rename ?? fs.rename);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  child(name: string) {
    if (!safeName(name)) throw new ResetPreferenceError('unsafe', { reason: 'name' });
    return `${this.reference}/${name}`;
  }

  lstat(name: string) {
    return fs.lstat(this.child(name));
  }

  async list() {
    return fs.readdir(this.reference);
  }

  async sync() {
    await this.handle.sync();
  }

  async assertCurrent() {
    const stat = await fs.lstat(this.directory).catch(() => null);
    if (!stat || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)
      throw new ResetPreferenceError('identity-changed', { directory: this.directory });
  }

  async renameInto(destination: PinnedDirectory, name: string, destinationName: string) {
    if (this.identity.dev !== destination.identity.dev) throw new ResetPreferenceError('cross-device');
    try {
      await this.rename(this.child(name), destination.child(destinationName));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') throw new ResetPreferenceError('cross-device');
      throw new ResetPreferenceError('rename-failed', { code: code ?? 'unknown' });
    }
    await this.sync();
    await destination.sync();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

const bindingSchema = type({
  '+': 'reject',
  version: '1',
  journal: 'string > 0 & string <= 64',
  stage: { dev: 'number', ino: 'number' },
  parent: { path: 'string > 0', dev: 'number', ino: 'number' },
  targets: type({
    '+': 'reject',
    index: 'number.integer >= 0 & number.integer <= 4096',
    name: 'string > 0 & string <= 255',
    type: "'file' | 'directory' | 'absent'",
    dev: 'number',
    ino: 'number',
  }).array(),
});
type Binding = typeof bindingSchema.infer;

export type PreferenceGroup = {
  parent: string;
  pin: PinnedDirectory;
  stage: string;
  stagePin?: PinnedDirectory;
  resumed: boolean;
  binding: Binding;
};

export type ResetPreferencePlan = {
  journal: string;
  groups: PreferenceGroup[];
  close: () => Promise<void>;
};

export type ResetPreferenceStoreOptions = {
  dataDir: string;
  uid?: number | undefined;
  descriptorRoot?: DescriptorRoot;
  rename?: RenameOperation;
  readMounts?: () => Promise<string | null>;
};

const sameBindingTargets = (a: Binding, b: Binding) =>
  a.targets.length === b.targets.length &&
  a.targets.every(
    (target, index) => target.index === b.targets[index]?.index && target.name === b.targets[index]?.name && target.type === b.targets[index]?.type,
  );

/**
 * Journal-bound, same-mount erasure of the reset preference targets supplied by the caller. Targets are absolute
 * paths that already belong to the reset scope; this module only performs the secure storage part.
 */
export class ResetPreferenceStore {
  private readonly dataDir: string;
  private readonly uid: number | undefined;
  private readonly pinOptions: PinOptions;
  private readonly readMounts?: () => Promise<string | null>;

  constructor(options: ResetPreferenceStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.uid = options.uid ?? process.getuid?.();
    this.pinOptions = { uid: this.uid, descriptorRoot: options.descriptorRoot, rename: options.rename };
    this.readMounts = options.readMounts;
  }

  private async directory(target: string) {
    const parent = path.dirname(target);
    const name = path.basename(target);
    if (!path.isAbsolute(target) || path.resolve(target) !== target || !safeName(name))
      throw new ResetPreferenceError('unsafe', { reason: 'target' });
    if (parent !== this.dataDir && !parent.startsWith(`${this.dataDir}${path.sep}`)) throw new ResetPreferenceError('unsafe', { reason: 'outside' });
    const authority = path.join(this.dataDir, 'orbis-reset');
    if (parent === authority || parent.startsWith(`${authority}${path.sep}`)) throw new ResetPreferenceError('unsafe', { reason: 'authority' });
    return { parent, name };
  }

  private async inspect(target: string, count = { value: 0 }): Promise<void> {
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (missing(error)) throw new ResetPreferenceError('identity-changed');
      throw error;
    });
    if (++count.value > MAX_ENTRIES || stat.isSymbolicLink() || (this.uid !== undefined && stat.uid !== this.uid))
      throw new ResetPreferenceError('unsafe', { reason: 'staged' });
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) {
        if (!safeName(name)) throw new ResetPreferenceError('unsafe', { reason: 'staged' });
        await this.inspect(path.join(target, name), count);
      }
    } else if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new ResetPreferenceError('unsafe', { reason: 'staged' });
  }

  /**
   * Read-only secure preflight. Opens and pins each parent directory, rejects old staging from another journal,
   * and records the identity of every target. No directory or file is created here.
   */
  async preflight(journal: string, targets: readonly string[]): Promise<ResetPreferencePlan> {
    if (typeof journal !== 'string' || !UUID.test(journal)) throw new ResetPreferenceError('unsafe', { reason: 'journal' });
    const unique = [...new Set(targets)];
    if (unique.length !== targets.length || unique.length === 0 || unique.length > MAX_TARGETS)
      throw new ResetPreferenceError('unsafe', { reason: 'targets' });
    const grouped = new Map<string, { index: number; name: string }[]>();
    for (const [index, target] of unique.entries()) {
      const { parent, name } = await this.directory(target);
      const list = grouped.get(parent) ?? [];
      list.push({ index, name });
      grouped.set(parent, list);
    }
    const groups: PreferenceGroup[] = [];
    try {
      for (const parent of [...grouped.keys()].sort()) {
        const list = (grouped.get(parent) ?? []).sort((a, b) => a.index - b.index);
        // A missing parent means every target below it is already absent. Nothing to pin or stage.
        if (!(await exists(parent))) continue;
        const sharedStateMount =
          parent === path.join(this.dataDir, 'state') &&
          ((await fs.lstat(parent)).mode & 0o022) !== 0 &&
          (await lookupResetMount({ dataDir: this.dataDir, readMounts: this.readMounts }, parent));
        // Only the kernel-pinned state root can contain the top-level password request.
        // Journal authority and every staging directory remain on private storage.
        const pin = await PinnedDirectory.open(parent, {
          ...this.pinOptions,
          ...(sharedStateMount ? { sharedStateMount: SHARED_STATE_MOUNT } : {}),
        });
        try {
          const stageName = `${STAGE_PREFIX}${journal.toLowerCase()}`;
          const stage = path.join(parent, stageName);
          const stages = (await pin.list()).filter((name) => name.startsWith(STAGE_PREFIX));
          if (stages.some((name) => name !== stageName)) throw new ResetPreferenceError('stage-conflict', { reason: 'journal' });
          let saved: Binding | null = null;
          if (stages.includes(stageName)) {
            const stagePin = await PinnedDirectory.open(stage, { ...this.pinOptions, private: true });
            try {
              saved = await this.readBinding(stagePin).catch(async (error: unknown) => {
                // A crash between staging-directory creation and the first binding write leaves an empty,
                // owner-only directory. It is safe to adopt; anything else needs local review.
                if (error instanceof ResetPreferenceError && error.detail.reason === 'binding-missing' && (await stagePin.list()).length === 0)
                  return null;
                throw error;
              });
              if (
                saved &&
                (saved.journal !== journal.toLowerCase() ||
                  saved.parent.path !== parent ||
                  saved.parent.dev !== pin.identity.dev ||
                  saved.parent.ino !== pin.identity.ino ||
                  saved.stage.dev !== stagePin.identity.dev ||
                  saved.stage.ino !== stagePin.identity.ino ||
                  saved.targets.length !== list.length ||
                  saved.targets.some((target, position) => target.index !== list[position]?.index || target.name !== list[position]?.name))
              )
                throw new ResetPreferenceError('stage-conflict', { reason: 'binding' });
            } finally {
              await stagePin.close();
            }
          }
          let binding: Binding;
          if (saved) binding = saved;
          else {
            const observed = await Promise.all(
              list.map(async ({ index, name }) => {
                const stat = await pin.lstat(name).catch((error: unknown) => {
                  if (missing(error)) return null;
                  throw error;
                });
                if (!stat) return { index, name, type: 'absent' as const, dev: 0, ino: 0 };
                if (stat.isSymbolicLink() || (this.uid !== undefined && stat.uid !== this.uid))
                  throw new ResetPreferenceError('unsafe', { reason: 'target' });
                if (!stat.isDirectory() && !stat.isFile()) throw new ResetPreferenceError('unsafe', { reason: 'target' });
                if (stat.isFile() && (stat.nlink !== 1 || stat.size > MAX_FILE_BYTES)) throw new ResetPreferenceError('unsafe', { reason: 'target' });
                if (stat.isDirectory()) await this.inspect(pin.child(name));
                return {
                  index,
                  name,
                  type: stat.isDirectory() ? ('directory' as const) : ('file' as const),
                  dev: stat.dev,
                  ino: stat.ino,
                };
              }),
            );
            binding = {
              version: 1,
              journal: journal.toLowerCase(),
              stage: { dev: pin.identity.dev, ino: pin.identity.ino },
              parent: { path: parent, dev: pin.identity.dev, ino: pin.identity.ino },
              targets: observed,
            };
          }
          groups.push({ parent, pin, stage, resumed: Boolean(saved), binding });
        } catch (error) {
          await pin.close();
          throw error;
        }
      }
    } catch (error) {
      await Promise.all(groups.map((group) => group.pin.close()));
      throw error;
    }
    return {
      journal: journal.toLowerCase(),
      groups,
      close: async () => {
        await Promise.all(groups.flatMap((group) => [group.pin.close(), group.stagePin?.close() ?? Promise.resolve()]));
      },
    };
  }

  /** Creates (or adopts) the journal-bound staging directory. Call after the journal itself is durable. */
  async begin(plan: ResetPreferencePlan) {
    for (const group of plan.groups) {
      if (!group.stagePin) {
        // Prove the path still names the pinned directory before creating anything inside it.
        await group.pin.assertCurrent();
        const stageName = path.basename(group.stage);
        const anchored = group.pin.child(stageName);
        await fs.mkdir(anchored, { mode: 0o700 }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ResetPreferenceError('unsafe', { reason: 'stage' });
        });
        const stagePin = await PinnedDirectory.open(anchored, { ...this.pinOptions, private: true, anchored: true });
        group.stage = anchored;
        if (stagePin.identity.dev !== group.pin.identity.dev) {
          await stagePin.close();
          throw new ResetPreferenceError('cross-device');
        }
        try {
          if (group.resumed) {
            const saved = await this.readBinding(stagePin);
            if (
              saved.journal !== plan.journal ||
              saved.parent.path !== group.parent ||
              saved.parent.dev !== group.pin.identity.dev ||
              saved.parent.ino !== group.pin.identity.ino ||
              saved.stage.dev !== stagePin.identity.dev ||
              saved.stage.ino !== stagePin.identity.ino ||
              !sameBindingTargets(saved, group.binding)
            )
              throw new ResetPreferenceError('stage-conflict', { reason: 'binding' });
          } else {
            group.binding = { ...group.binding, stage: { dev: stagePin.identity.dev, ino: stagePin.identity.ino } };
            await this.writeBinding(stagePin, group.binding);
          }
        } catch (error) {
          await stagePin.close();
          throw error;
        }
        group.stagePin = stagePin;
      }
    }
  }

  /** Moves every target into its same-directory stage, proves identity, then deletes the staged copies. */
  async commit(plan: ResetPreferencePlan) {
    for (const group of plan.groups) {
      const stagePin = group.stagePin;
      if (!stagePin) throw new ResetPreferenceError('stage-invalid');
      await group.pin.assertCurrent();
      await stagePin.assertCurrent();
      for (const target of group.binding.targets) {
        const staged = await stagePin.lstat(target.name).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        const live = await group.pin.lstat(target.name).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        if (staged) {
          if (target.type === 'absent' || live) throw new ResetPreferenceError('stage-conflict', { reason: 'recreated' });
          if (staged.isSymbolicLink() || staged.dev !== target.dev || staged.ino !== target.ino)
            throw new ResetPreferenceError('identity-changed', { name: target.name });
          continue;
        }
        if (!live) continue;
        if (live.isSymbolicLink() || (this.uid !== undefined && live.uid !== this.uid))
          throw new ResetPreferenceError('unsafe', { reason: 'target' });
        if (!live.isDirectory() && !live.isFile()) throw new ResetPreferenceError('unsafe', { reason: 'target' });
        if (live.isFile() && (live.nlink !== 1 || live.size > MAX_FILE_BYTES)) throw new ResetPreferenceError('unsafe', { reason: 'target' });
        const kind = live.isDirectory() ? 'directory' : 'file';
        if (target.type === 'absent') {
          // A preference created after the journal was prepared. Adopt it, durably, before moving it.
          target.type = kind;
          target.dev = live.dev;
          target.ino = live.ino;
          await this.writeBinding(stagePin, group.binding);
        } else if (target.type !== kind || target.dev !== live.dev || target.ino !== live.ino) {
          throw new ResetPreferenceError('identity-changed', { name: target.name });
        }
        await group.pin.renameInto(stagePin, target.name, target.name);
        const moved = await stagePin.lstat(target.name);
        if (moved.isSymbolicLink() || moved.dev !== target.dev || moved.ino !== target.ino)
          throw new ResetPreferenceError('identity-changed', { name: target.name });
      }
      await group.pin.assertCurrent();
      await stagePin.assertCurrent();
      for (const target of group.binding.targets) {
        if (await exists(group.pin.child(target.name))) throw new ResetPreferenceError('stage-conflict', { reason: 'recreated' });
        const staged = await stagePin.lstat(target.name).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        if (!staged) continue;
        if (staged.isSymbolicLink() || staged.dev !== target.dev || staged.ino !== target.ino)
          throw new ResetPreferenceError('identity-changed', { name: target.name });
        await this.inspect(stagePin.child(target.name));
        await fs.rm(stagePin.child(target.name), { recursive: true, force: false }).catch(() => {
          throw new ResetPreferenceError('unsafe', { reason: 'staged' });
        });
      }
      await stagePin.sync();
      await fs.unlink(stagePin.child('binding.json')).catch(() => {
        throw new ResetPreferenceError('stage-invalid', { reason: 'binding' });
      });
      await stagePin.sync();
      if ((await stagePin.list()).length !== 0) throw new ResetPreferenceError('stage-invalid');
      await stagePin.assertCurrent();
      await fs.rmdir(group.stage).catch(() => {
        throw new ResetPreferenceError('stage-invalid', { reason: 'residue' });
      });
      await group.pin.sync();
      await stagePin.close();
      group.stagePin = undefined;
    }
  }

  async erase(journal: string, targets: readonly string[]) {
    const plan = await this.preflight(journal, targets);
    try {
      await this.begin(plan);
      await this.commit(plan);
    } finally {
      await plan.close();
    }
  }

  private async readBinding(pin: PinnedDirectory): Promise<Binding> {
    const handle = await fs.open(pin.child('binding.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error: unknown) => {
      if (missing(error)) throw new ResetPreferenceError('stage-conflict', { reason: 'binding-missing' });
      throw new ResetPreferenceError('stage-conflict', { reason: 'binding-unreadable' });
    });
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MAX_BINDING_BYTES ||
        (stat.mode & 0o077) !== 0 ||
        (this.uid !== undefined && stat.uid !== this.uid)
      )
        throw new ResetPreferenceError('stage-conflict', { reason: 'binding-identity' });
      try {
        return bindingSchema.assert(JSON.parse(await handle.readFile('utf8')));
      } catch {
        throw new ResetPreferenceError('stage-conflict', { reason: 'binding-invalid' });
      }
    } finally {
      await handle.close();
    }
  }

  private async writeBinding(pin: PinnedDirectory, binding: Binding) {
    const temporary = pin.child(`.binding-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(binding)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, pin.child('binding.json'));
      await pin.sync();
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
