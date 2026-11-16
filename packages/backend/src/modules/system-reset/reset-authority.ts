import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertResetJournalReplacement, resetJournalSchema, type ResetJournal } from './reset-contract';

/**
 * Dedicated reset authority storage.
 *
 * Reset intent keeps an unfinished operation held for recovery review, so it may not live on a writable
 * legacy directory that another process can rename or hide. This module only accepts an authority directory
 * that the kernel reports as its own mount (`/proc/self/mountinfo` exact path match), is private (0700, owned
 * by this process) and canonical. It never creates the directory: an absent or non-mounted path is reported to
 * the caller instead of being materialised on the container overlay (which would be lost on container recreate
 * and silently turn an interrupted reset into an idle one).
 *
 */

export const MAX_MOUNTINFO_BYTES = 16 * 1024 * 1024;
const MAX_MOUNTS = 100_000;
const JOURNAL_LIMIT = 16 * 1024;
const EPHEMERAL_FILE_SYSTEMS = new Set([
  'nsfs',
  'aufs',
  'cgroup',
  'cgroup2',
  'debugfs',
  'devtmpfs',
  'overlay',
  'proc',
  'ramfs',
  'securityfs',
  'sysfs',
  'tmpfs',
]);

export type ResetMount = { path: string; source: string; fsType: string };
type ResetMountRecord = ResetMount & { id: string; device: string; root: string; readOnly: boolean; identity: string };

export type ResetAuthorityErrorCode =
  | 'mounts-unavailable'
  | 'mounts-unreadable'
  | 'not-mounted'
  | 'ephemeral-mount'
  | 'authority-unsafe'
  | 'legacy-journal'
  | 'journal-unsafe'
  | 'journal-invalid';

/** The message stays generic for clients; the code and detail are for server-side logs only. */
export class ResetAuthorityError extends Error {
  constructor(
    readonly code: ResetAuthorityErrorCode,
    readonly detail: Record<string, string | number> = {},
  ) {
    super('Reset storage needs local review.');
    this.name = 'ResetAuthorityError';
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const unescapeMountField = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));

/**
 * Bounded parser for `/proc/self/mountinfo`. Mount points are decoded exactly like the kernel escapes them,
 * and malformed input fails closed instead of producing a usable-looking mount list.
 */
function parseMountRecords(text: string): ResetMountRecord[] {
  if (text.length === 0 || text.length > MAX_MOUNTINFO_BYTES) throw new ResetAuthorityError('mounts-unreadable');
  const lines = text.split('\n').filter((line) => line !== '');
  if (lines.length === 0 || lines.length > MAX_MOUNTS) throw new ResetAuthorityError('mounts-unreadable');
  return lines.map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    const mount = fields[4];
    const id = fields[0] ?? '';
    const device = fields[2] ?? '';
    const root = fields[3] ?? '';
    if (
      !/^\d+$/.test(id) ||
      !/^\d+$/.test(fields[1] ?? '') ||
      !/^\d+:\d+$/.test(device) ||
      !(root?.startsWith('/') || (fields[separator + 1] === 'nsfs' && /^(?:net|mnt|pid|ipc|uts|user|cgroup|time):\[\d+\]$/.test(root ?? ''))) ||
      !mount?.startsWith('/') ||
      separator === -1 ||
      separator + 4 !== fields.length ||
      fields.some((field) => !field)
    )
      throw new ResetAuthorityError('mounts-unreadable');
    const fsType = fields[separator + 1];
    const source = fields[separator + 2];
    if (!fsType || !source) throw new ResetAuthorityError('mounts-unreadable');
    const options = [fields[5], fields[separator + 3]].map((value) => value?.split(',') ?? []);
    if (options.some((values) => values.includes('ro') === values.includes('rw'))) throw new ResetAuthorityError('mounts-unreadable');
    return {
      path: unescapeMountField(mount),
      source: unescapeMountField(source),
      fsType: unescapeMountField(fsType),
      id,
      device,
      root: unescapeMountField(root),
      readOnly: options.some((values) => values.includes('ro')),
      identity: line,
    };
  });
}

export function parseResetMounts(text: string): ResetMount[] {
  return parseMountRecords(text).map(({ path, source, fsType }) => ({ path, source, fsType }));
}

const readKernelMounts = async () => {
  if (process.platform !== 'linux') return null;
  const handle = await fs.open('/proc/self/mountinfo', 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(MAX_MOUNTINFO_BYTES + 1 - total, 1024 * 1024));
      if (buffer.length === 0) throw new ResetAuthorityError('mounts-unreadable');
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_MOUNTINFO_BYTES) throw new ResetAuthorityError('mounts-unreadable');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total === 0) throw new ResetAuthorityError('mounts-unreadable');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new ResetAuthorityError('mounts-unreadable');
    }
  } finally {
    await handle.close();
  }
};

export const legacyResetDirectory = (dataDir: string) => path.join(path.resolve(dataDir), 'state', 'orbis-reset');
export const dedicatedResetDirectory = (dataDir: string, name = 'orbis-reset') => path.join(path.resolve(dataDir), name);

export type DedicatedResetAuthority = { readonly mode: 'dedicated'; readonly directory: string; readonly mount: ResetMount };
export type ResetAuthority = DedicatedResetAuthority | { mode: 'legacy'; directory: string };

export type ResetAuthorityOptions = {
  dataDir: string;
  name?: string;
  /** Injectable for tests and filesystem simulations; production reads this process's mount namespace. */
  readMounts?: () => Promise<string | null>;
  /** Injectable for tests; defaults to this process's uid when the platform has one. */
  uid?: number | undefined;
};

const uidOf = (options: { uid?: number | undefined }) => options.uid ?? process.getuid?.();
const rootIdentity = (stat: Awaited<ReturnType<typeof fs.stat>>) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');
const fileIdentity = (stat: Awaited<ReturnType<typeof fs.stat>>) => [rootIdentity(stat), stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const authorities = new WeakMap<DedicatedResetAuthority, { options: ResetAuthorityOptions; mount: ResetMountRecord; root: string }>();

async function mountRecords(options: ResetAuthorityOptions) {
  const text = await (options.readMounts ?? readKernelMounts)();
  if (text === null) throw new ResetAuthorityError('mounts-unavailable');
  return parseMountRecords(text);
}

function selectMount(mounts: ResetMountRecord[], directory: string) {
  const matches = mounts.filter((candidate) => candidate.path === directory);
  if (matches.length > 1) throw new ResetAuthorityError('authority-unsafe', { reason: 'stacked-mount' });
  const mount = matches[0];
  if (mount && EPHEMERAL_FILE_SYSTEMS.has(mount.fsType)) throw new ResetAuthorityError('ephemeral-mount', { fsType: mount.fsType });
  return mount;
}

const within = (target: string, parent: string) => target === parent || target.startsWith(parent === '/' ? '/' : `${parent}/`);

function dedicatedMount(mounts: ResetMountRecord[], directory: string) {
  const mount = selectMount(mounts, directory);
  if (!mount) return undefined;
  if (mount.readOnly) throw new ResetAuthorityError('authority-unsafe', { reason: 'readonly-mount' });
  for (const other of mounts) {
    if (other === mount) continue;
    if (within(other.path, directory)) throw new ResetAuthorityError('authority-unsafe', { reason: 'nested-mount' });
    if (!other.readOnly && other.device === mount.device && (within(mount.root, other.root) || within(other.root, mount.root)))
      throw new ResetAuthorityError('authority-unsafe', { reason: 'writable-alias' });
  }
  return mount;
}

export async function lookupResetMount(options: ResetAuthorityOptions, directory: string) {
  const mount = selectMount(await mountRecords(options), directory);
  return mount && { path: mount.path, source: mount.source, fsType: mount.fsType };
}

async function withVerifiedAuthority<T>(
  authority: DedicatedResetAuthority,
  work: (value: { directory: string; uid: number | undefined; check: () => Promise<void>; sync: () => Promise<void> }) => Promise<T>,
) {
  const admitted = authorities.get(authority);
  if (!admitted) throw new ResetAuthorityError('authority-unsafe', { reason: 'unverified' });
  const { options } = admitted;
  const directory = dedicatedResetDirectory(options.dataDir, options.name);
  const uid = uidOf(options);
  const checkMount = async () => {
    const current = dedicatedMount(await mountRecords(options), directory);
    if (!current) throw new ResetAuthorityError('not-mounted');
    if (current.identity !== admitted.mount.identity || rootIdentity(await assertPrivateMountRoot(directory, uid)) !== admitted.root)
      throw new ResetAuthorityError('authority-unsafe', { reason: 'mount-changed' });
  };
  await checkMount();
  const handle = await fs.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const reference = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory;
    const check = async () => {
      await checkMount();
      if (rootIdentity(await handle.stat()) !== admitted.root) throw new ResetAuthorityError('authority-unsafe', { reason: 'root-changed' });
      if (process.platform === 'linux' && !options.readMounts) {
        const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
        const ids = [...info.matchAll(/^mnt_id:\s+(\d+)$/gm)];
        if (info.length > 4096 || ids.length !== 1 || ids[0]?.[1] !== admitted.mount.id)
          throw new ResetAuthorityError('authority-unsafe', { reason: 'descriptor-mount' });
      }
      await assertNoStrandedLegacyJournal(options.dataDir, uid);
    };
    await check();
    const value = await work({ directory: reference, uid, check, sync: () => handle.sync() });
    await check();
    return value;
  } finally {
    await handle.close();
  }
}

export async function verifyResetAuthority(authority: DedicatedResetAuthority) {
  await withVerifiedAuthority(authority, async () => undefined);
}

const exists = async (target: string) => {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
};

async function assertPrivateMountRoot(directory: string, uid: number | undefined) {
  if (!(await exists(directory))) throw new ResetAuthorityError('authority-unsafe', { reason: 'missing' });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResetAuthorityError('authority-unsafe', { reason: 'type' });
  if ((await fs.realpath(directory)) !== directory) throw new ResetAuthorityError('authority-unsafe', { reason: 'canonical' });
  // A mounted journal root is stricter than the legacy authority directory: owner-only access, no group/world bits.
  if ((stat.mode & 0o077) !== 0) throw new ResetAuthorityError('authority-unsafe', { reason: 'permissions' });
  if (uid !== undefined && stat.uid !== uid) throw new ResetAuthorityError('authority-unsafe', { reason: 'owner' });
  return stat;
}

async function readJournalFile(directory: string, uid: number | undefined): Promise<ResetJournal | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path.join(directory, 'active.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return null;
    throw new ResetAuthorityError('journal-unsafe', { reason: 'open' });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > JOURNAL_LIMIT || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))
      throw new ResetAuthorityError('journal-unsafe', { reason: 'identity' });
    const buffer = Buffer.alloc(JOURNAL_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > JOURNAL_LIMIT) throw new ResetAuthorityError('journal-unsafe', { reason: 'size' });
    if (
      bytesRead !== stat.size ||
      fileIdentity(await handle.stat()) !== fileIdentity(stat) ||
      fileIdentity(await fs.lstat(path.join(directory, 'active.json'))) !== fileIdentity(stat)
    )
      throw new ResetAuthorityError('journal-unsafe', { reason: 'changed' });
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    try {
      return resetJournalSchema.assert(JSON.parse(text));
    } catch {
      throw new ResetAuthorityError('journal-invalid');
    }
  } finally {
    await handle.close();
  }
}

async function readLockFile(directory: string, uid: number | undefined) {
  const target = path.join(directory, 'operation.lock');
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return null;
    throw new ResetAuthorityError('journal-unsafe', { reason: 'lock' });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > JOURNAL_LIMIT || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid))
      throw new ResetAuthorityError('journal-unsafe', { reason: 'lock-identity' });
    return stat;
  } finally {
    await handle.close();
  }
}

export type ResetJournalState = 'absent' | 'complete' | 'recovery' | 'pending';

/**
 * Selects the authority mode without ever changing storage.
 *
 * - A private mount at `<dataDir>/orbis-reset` is the only accepted authority.
 * - No mount and no directory keeps the strict legacy layout: callers keep using `ResetState` unchanged.
 * - No mount but an existing directory fails closed. It is an overlay directory, not durable authority.
 * - A mounted authority also requires that no earlier legacy journal (or legacy staging residue) is
 *   unfinished. Otherwise the old hold would be silently dropped when choosing the new authority.
 */
export async function resolveResetAuthority(options: ResetAuthorityOptions): Promise<ResetAuthority> {
  const uid = uidOf(options);
  const directory = dedicatedResetDirectory(options.dataDir, options.name);
  const mount = dedicatedMount(await mountRecords(options), directory);
  if (!mount) {
    if (await exists(directory)) throw new ResetAuthorityError('not-mounted');
    return { mode: 'legacy', directory: legacyResetDirectory(options.dataDir) };
  }
  const root = rootIdentity(await assertPrivateMountRoot(directory, uid));
  await assertNoStrandedLegacyJournal(options.dataDir, uid);
  const authority = Object.freeze({
    mode: 'dedicated' as const,
    directory,
    mount: Object.freeze({ path: mount.path, source: mount.source, fsType: mount.fsType }),
  });
  authorities.set(authority, { options: { ...options }, mount, root });
  return authority;
}

/**
 * Fails closed when migration to a dedicated authority would hide an unfinished legacy reset. A completed
 * journal is inert and does not block migration, but a lock next to it means recovery is still outstanding.
 */
export async function assertNoStrandedLegacyJournal(dataDir: string, uid: number | undefined = process.getuid?.()) {
  const directory = legacyResetDirectory(dataDir);
  let names: string[];
  try {
    await assertPrivateMountRoot(directory, uid);
    names = await fs.readdir(directory);
  } catch (error) {
    if (missing(error) || (error instanceof ResetAuthorityError && error.detail.reason === 'missing')) return;
    throw new ResetAuthorityError('journal-unsafe', { reason: 'legacy-directory' });
  }
  const journal = await readJournalFile(directory, uid);
  for (const name of names.filter((name) => name !== 'active.json' && name !== 'operation.lock')) {
    // Successful legacy resets leave their empty staging directory behind.
    if (!journal || journal.phase !== 'complete' || name !== journal.id) throw new ResetAuthorityError('legacy-journal', { reason: 'residue' });
    const stage = path.join(directory, name);
    await assertPrivateMountRoot(stage, uid);
    if ((await fs.readdir(stage)).length) throw new ResetAuthorityError('legacy-journal', { reason: 'residue' });
  }
  if (!journal) {
    if (names.includes('operation.lock')) throw new ResetAuthorityError('legacy-journal', { reason: 'orphan-lock' });
    return;
  }
  if (journal.phase !== 'complete') throw new ResetAuthorityError('legacy-journal', { reason: journal.phase, journal: journal.id });
  if (await readLockFile(directory, uid)) throw new ResetAuthorityError('legacy-journal', { reason: 'recovery', journal: journal.id });
}

/** Reads the dedicated journal. `null` only means no journal file exists, never "the directory is missing". */
export async function readAuthorityJournal(authority: DedicatedResetAuthority) {
  return withVerifiedAuthority(authority, async ({ directory, uid }) => {
    const journal = await readJournalFile(directory, uid);
    if (!journal && (await readLockFile(directory, uid))) throw new ResetAuthorityError('journal-unsafe', { reason: 'orphan-lock' });
    return journal;
  });
}

/**
 * Full journal state for startup holding. A journal from another controller is `pending`: imported intent never
 * grants replay permission, and it must keep the recovery hold until its original receipt is proven.
 */
export async function authorityJournalState(authority: DedicatedResetAuthority): Promise<{ journal: ResetJournal | null; state: ResetJournalState }> {
  return withVerifiedAuthority(authority, async ({ directory, uid }) => {
    const journal = await readJournalFile(directory, uid);
    if (!journal) {
      if (await readLockFile(directory, uid)) throw new ResetAuthorityError('journal-unsafe', { reason: 'orphan-lock' });
      return { journal: null, state: 'absent' };
    }
    if (journal.phase !== 'complete') return { journal, state: 'pending' };
    const lock = await readLockFile(directory, uid);
    if (!lock) return { journal, state: 'complete' };
    return { journal: { ...journal, phase: 'recovery' }, state: 'recovery' };
  });
}

/** Writes the journal inside the already-verified authority mount. It never creates that mount. */
export async function saveAuthorityJournal(authority: DedicatedResetAuthority, value: ResetJournal) {
  const captured = resetJournalSchema.assert(structuredClone(value));
  return withVerifiedAuthority(authority, async ({ directory, uid, check, sync }) => {
    assertResetJournalReplacement(await readJournalFile(directory, uid), captured);
    const temporary = path.join(directory, `.journal-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    const identity = await handle.stat();
    try {
      await handle.writeFile(`${JSON.stringify(captured)}\n`);
      await handle.sync();
      await check();
      const current = await fs.lstat(temporary);
      const pinned = await handle.stat();
      if (
        !current.isFile() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        pinned.nlink !== 1 ||
        rootIdentity(current) !== rootIdentity(pinned)
      )
        throw new ResetAuthorityError('journal-unsafe', { reason: 'staging-changed' });
      await fs.rename(temporary, path.join(directory, 'active.json'));
      await sync();
    } finally {
      try {
        const current = await fs.lstat(temporary).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
        if (current?.dev === identity.dev && current.ino === identity.ino) await fs.unlink(temporary);
      } finally {
        await handle.close();
      }
    }
  });
}

/** Exclusive lease with the same interrupted-process semantics as the legacy journal store. */
export async function acquireAuthorityLease(authority: DedicatedResetAuthority) {
  let opened: fs.FileHandle | undefined;
  try {
    return await withVerifiedAuthority(authority, async ({ directory, sync }) => {
      const file = path.join(directory, 'operation.lock');
      const handle = await fs.open(file, 'wx', 0o600).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ResetAuthorityError('journal-unsafe', { reason: 'locked' });
        throw error;
      });
      opened = handle;
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() })}\n`);
      await handle.sync();
      await sync();
      const identity = await handle.stat();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await withVerifiedAuthority(authority, async ({ directory, check, sync }) => {
            const file = path.join(directory, 'operation.lock');
            const current = await fs.lstat(file);
            const pinned = await handle.stat();
            if (
              !current.isFile() ||
              current.isSymbolicLink() ||
              fileIdentity(current) !== fileIdentity(identity) ||
              fileIdentity(pinned) !== fileIdentity(identity) ||
              pinned.nlink !== 1 ||
              current.nlink !== 1
            )
              throw new ResetAuthorityError('journal-unsafe', { reason: 'lock-changed' });
            await check();
            await fs.unlink(file);
            await sync();
          });
        } finally {
          await handle.close();
        }
      };
    });
  } catch (error) {
    await opened?.close();
    throw error;
  }
}

export async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
