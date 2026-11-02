import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs, { constants, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const fail = () => new Error('Retained app image pins could not be verified.');
const id = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const service = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const maximum = 128 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join('\0') === expected.sort().join('\0');
export type AppImagePinSource = { appUrn: string; project: string; sourceSha256: string };
export type AppImagePins = AppImagePinSource & { version: 1; pointId: string; services: Record<string, string> };
export type AppImagePinInput = Pick<AppImagePins, 'version' | 'pointId' | 'sourceSha256' | 'services'>;

export function appImagePinSourceSha256(source: unknown, userCompose: string | null) {
  if (!record(source) || (userCompose !== null && typeof userCompose !== 'string')) throw fail();
  const canonical = JSON.stringify({ source, userCompose }, (_key, value) =>
    record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value,
  );
  if (Buffer.byteLength(canonical) > 2 * 1024 * 1024) throw fail();
  return createHash('sha256').update(canonical).digest('hex');
}

function validate(value: unknown): AppImagePins {
  if (
    !record(value) ||
    !keys(value, ['version', 'pointId', 'appUrn', 'project', 'sourceSha256', 'services']) ||
    value.version !== 1 ||
    typeof value.pointId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.pointId) ||
    typeof value.appUrn !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}:[a-z0-9][a-z0-9._-]{0,127}$/.test(value.appUrn) ||
    value.project !== value.appUrn.replace(':', '_') ||
    typeof value.sourceSha256 !== 'string' ||
    !hash.test(value.sourceSha256) ||
    !record(value.services) ||
    Object.keys(value.services).length < 1 ||
    Object.keys(value.services).length > 256 ||
    Object.entries(value.services).some(([name, image]) => !service.test(name) || typeof image !== 'string' || !id.test(image))
  )
    throw fail();
  return value as AppImagePins;
}

function location(directory: string, appUrn: string) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw fail();
  return path.join(directory, `${createHash('sha256').update(appUrn).digest('hex')}.json`);
}

async function directorySafe(directory: string, create: boolean) {
  const parents = [];
  for (let current = directory; ; current = path.dirname(current)) {
    parents.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of parents) {
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    if (current === directory && (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)) throw fail();
  }
  return true;
}

export async function readAppImagePins(
  directory: string,
  source: Pick<AppImagePinSource, 'appUrn' | 'project'> & Partial<Pick<AppImagePinSource, 'sourceSha256'>>,
): Promise<{ pins: AppImagePins; path: string } | null> {
  const file = location(directory, source.appUrn);
  if (!(await directorySafe(directory, false))) return null;
  let handle: FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maximum) throw fail();
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      bytesRead !== stat.size ||
      bytesRead > maximum ||
      [after, current].some((value) =>
        ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(value, key) !== Reflect.get(stat, key)),
      )
    )
      throw fail();
    const pins = decodeAppImagePins(bytes.subarray(0, bytesRead));
    if (
      pins.appUrn !== source.appUrn ||
      pins.project !== source.project ||
      (source.sourceSha256 !== undefined && pins.sourceSha256 !== source.sourceSha256)
    )
      throw fail();
    return { pins, path: file };
  } finally {
    await handle.close();
  }
}

export function decodeAppImagePins(bytes: Uint8Array): AppImagePins {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maximum) throw fail();
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !record(raw) ||
    !keys(raw, ['x-orbis-image-pin', 'services']) ||
    !record(raw['x-orbis-image-pin']) ||
    !keys(raw['x-orbis-image-pin'], ['version', 'pointId', 'appUrn', 'project', 'sourceSha256']) ||
    !record(raw.services)
  )
    throw fail();
  const images = Object.fromEntries(
    Object.entries(raw.services).map(([name, value]) => {
      if (!record(value) || !keys(value, ['image', 'pull_policy']) || value.pull_policy !== 'never') throw fail();
      return [name, value.image];
    }),
  );
  return validate({ ...raw['x-orbis-image-pin'], services: images });
}

export function encodeAppImagePins(source: AppImagePinSource, input: AppImagePinInput) {
  const pins = validate({ ...input, appUrn: source.appUrn, project: source.project });
  if (source.sourceSha256 !== undefined && pins.sourceSha256 !== source.sourceSha256) throw fail();
  const { services, ...metadata } = pins;
  const data = JSON.stringify({
    'x-orbis-image-pin': metadata,
    services: Object.fromEntries(
      Object.entries(services)
        .sort()
        .map(([name, image]) => [name, { image, pull_policy: 'never' }]),
    ),
  });
  if (Buffer.byteLength(data) > maximum) throw fail();
  return { pins, data: Buffer.from(data) };
}

export async function writeAppImagePins(directory: string, source: AppImagePinSource, input: AppImagePinInput) {
  const { pins, data } = encodeAppImagePins(source, input);
  const file = location(directory, source.appUrn);
  await directorySafe(directory, true);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    const parent = await fs.open(directory, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
  return { pins, path: file };
}

export async function removeAppImagePins(directory: string, appUrn: string) {
  const file = location(directory, appUrn);
  if (!(await directorySafe(directory, false))) return;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) throw fail();
    await fs.unlink(file);
    const parent = await fs.open(directory, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export type AppImagePinUpdate = {
  id: string;
  prepare: () => Promise<void>;
  activationAttempted: () => Promise<void>;
  restoreMetadata: () => Promise<void>;
  commit: (retire: () => Promise<void>) => Promise<void>;
};
type MetadataEntry = { name: string; directory: boolean; mode: number; uid: number; gid: number; sha256?: string; bytes?: number };
type MetadataState = { entries: MetadataEntry[]; envSha256: string | null; envMode: number | null; envGid: number | null };
const recovery = () => new Error('Retained app update requires explicit recovery. Its metadata and any new app writes were preserved.');
const updatePath = (directory: string, appUrn: string) => location(directory, appUrn).replace(/\.json$/, '.update.json');

async function privateJson(file: string, value?: unknown) {
  if (value !== undefined) {
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw recovery();
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
      await handle.close();
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true });
    }
    return value;
  }
  if (((await fs.lstat(file)).mode & 0o077) !== 0) throw recovery();
  return JSON.parse((await readOwned(file, 4 * 1024 * 1024)).toString('utf8')) as unknown;
}

async function readOwned(file: string, maximumBytes: number) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid?.() || before.size > maximumBytes) throw recovery();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximumBytes) throw recovery();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      size !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw recovery();
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

async function noSymlinkParents(directory: string) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw recovery();
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recovery();
    if (path.dirname(current) === current) break;
  }
}

async function metadataState(metadata: string, env: string, copyTo?: string): Promise<MetadataState> {
  await noSymlinkParents(metadata);
  await noSymlinkParents(path.dirname(env));
  const entries: MetadataEntry[] = [];
  let total = 0;
  const visit = async (name: string) => {
    if (entries.length >= 4096 || Buffer.byteLength(name) > 512) throw recovery();
    const source = path.join(metadata, name);
    const stat = await fs.lstat(source);
    if (stat.uid !== process.geteuid?.() || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw recovery();
    const entry: MetadataEntry = { name, directory: stat.isDirectory(), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
    entries.push(entry);
    const destination = copyTo ? path.join(copyTo, 'metadata', name) : null;
    if (stat.isDirectory()) {
      if (destination) await fs.mkdir(destination, { mode: 0o700 });
      for (const child of (await fs.readdir(source)).sort()) await visit(name ? path.join(name, child) : child);
    } else {
      const bytes = await readOwned(source, 8 * 1024 * 1024);
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw recovery();
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      entry.bytes = bytes.length;
      if (destination) await fs.writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
    }
  };
  await visit('');
  let envBytes: Buffer | null;
  let envMode: number | null = null;
  let envGid: number | null = null;
  try {
    envBytes = await readOwned(env, 1024 * 1024);
    const stat = await fs.lstat(env);
    envMode = stat.mode & 0o777;
    envGid = stat.gid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    envBytes = null;
  }
  if (copyTo && envBytes !== null) await fs.writeFile(path.join(copyTo, 'app.env'), envBytes, { mode: 0o600, flag: 'wx' });
  return { entries, envSha256: envBytes === null ? null : createHash('sha256').update(envBytes).digest('hex'), envMode, envGid };
}

async function updateGuard(directory: string, appUrn: string) {
  if (!(await directorySafe(directory, false))) return null;
  try {
    const guard = await privateJson(updatePath(directory, appUrn));
    if (
      !record(guard) ||
      !keys(guard, ['version', 'appUrn', 'id', 'phase']) ||
      guard.version !== 1 ||
      guard.appUrn !== appUrn ||
      typeof guard.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(guard.id) ||
      !['staged', 'prepared', 'activation-attempted', 'committing'].includes(String(guard.phase))
    )
      throw recovery();
    return guard as { version: 1; appUrn: string; id: string; phase: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function requireAppImagePinUpdate(directory: string, appUrn: string, transactionId?: string) {
  const guard = await updateGuard(directory, appUrn);
  if (guard ? guard.id !== transactionId : transactionId !== undefined) throw recovery();
  return guard;
}

export async function requireNoAppImagePinUpdates(directory: string) {
  if (!(await directorySafe(directory, false))) return;
  if ((await fs.readdir(directory)).some((name) => name.endsWith('.update.json'))) throw recovery();
}

export async function beginAppImagePinUpdate(directory: string, appUrn: string, metadata: string, env: string): Promise<AppImagePinUpdate> {
  await directorySafe(directory, true);
  await requireAppImagePinUpdate(directory, appUrn);
  const capacity = await fs.statfs(directory);
  if (capacity.bavail * capacity.bsize < (65 + 4 + 256) * 1024 * 1024) throw recovery();
  const id = randomUUID();
  const staging = path.join(directory, `update-${id}`);
  await fs.mkdir(staging, { mode: 0o700 });
  if (staging.startsWith(`${metadata}/`) || metadata === directory || env.startsWith(`${directory}/`)) throw recovery();
  const owned = await fs.lstat(staging);
  try {
    const baseline = await metadataState(metadata, env, staging);
    if (JSON.stringify(baseline) !== JSON.stringify(await metadataState(metadata, env))) throw recovery();
    const syncTree = async (root: string, entries: MetadataEntry[], environment?: string) => {
      for (const entry of [...entries].reverse()) {
        const handle = await fs.open(path.join(root, entry.name), constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      if (environment) {
        const handle = await fs.open(environment, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    };
    await syncTree(path.join(staging, 'metadata'), baseline.entries, baseline.envSha256 === null ? undefined : path.join(staging, 'app.env'));
    let prepared: MetadataState | null = null;
    const guard = { version: 1, appUrn, id, phase: 'staged' };
    let initial = true;
    const save = async () => {
      await privateJson(path.join(staging, 'journal.json'), { ...guard, metadata, env, baseline, prepared });
      if (initial) {
        const handle = await fs.open(
          updatePath(directory, appUrn),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(JSON.stringify(guard));
          await handle.sync();
        } finally {
          await handle.close();
        }
        const parent = await fs.open(directory, constants.O_RDONLY);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        initial = false;
      } else await privateJson(updatePath(directory, appUrn), guard);
    };
    await save();
    const requireOwned = async () => {
      const current = await fs.lstat(staging);
      if (current.ino !== owned.ino || current.dev !== owned.dev || current.uid !== owned.uid || !current.isDirectory() || current.isSymbolicLink())
        throw recovery();
      await requireAppImagePinUpdate(directory, appUrn, id);
    };
    const clear = async () => {
      await fs.rm(staging, { recursive: true });
      await fs.unlink(updatePath(directory, appUrn));
      const parent = await fs.open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    };
    return {
      id,
      prepare: async () => {
        await requireOwned();
        if (guard.phase !== 'staged') throw recovery();
        prepared = await metadataState(metadata, env);
        guard.phase = 'prepared';
        await save();
      },
      activationAttempted: async () => {
        await requireOwned();
        if (guard.phase !== 'prepared') throw recovery();
        guard.phase = 'activation-attempted';
        await save();
      },
      restoreMetadata: async () => {
        await requireOwned();
        if (!['staged', 'prepared'].includes(guard.phase)) throw recovery();
        if (JSON.stringify(await metadataState(metadata, env)) !== JSON.stringify(prepared ?? baseline)) throw recovery();
        for (const entry of baseline.entries) {
          if (entry.directory) continue;
          const bytes = await readOwned(path.join(staging, 'metadata', entry.name), 8 * 1024 * 1024);
          if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw recovery();
        }
        const oldEnv = baseline.envSha256 === null ? null : await readOwned(path.join(staging, 'app.env'), 1024 * 1024);
        if (oldEnv !== null && createHash('sha256').update(oldEnv).digest('hex') !== baseline.envSha256) throw recovery();
        await fs.rm(metadata, { recursive: true });
        for (const entry of baseline.entries) {
          const target = path.join(metadata, entry.name);
          if (entry.directory) {
            await fs.mkdir(target, { mode: entry.mode });
            await fs.chown(target, entry.uid, entry.gid);
          } else {
            await fs.copyFile(path.join(staging, 'metadata', entry.name), target, constants.COPYFILE_EXCL);
            await fs.chown(target, entry.uid, entry.gid);
            await fs.chmod(target, entry.mode);
          }
        }
        if (oldEnv === null) await fs.rm(env, { force: true });
        else {
          const temporary = path.join(path.dirname(env), `.retained-env-${id}`);
          await fs.writeFile(temporary, oldEnv, { flag: 'wx', mode: baseline.envMode ?? 0o600 });
          await fs.chown(temporary, process.geteuid?.() ?? -1, baseline.envGid ?? -1);
          await fs.rename(temporary, env);
        }
        if (JSON.stringify(await metadataState(metadata, env)) !== JSON.stringify(baseline)) throw recovery();
        await syncTree(metadata, baseline.entries, baseline.envSha256 === null ? undefined : env);
        await clear();
      },
      commit: async (retire) => {
        await requireOwned();
        if (!['prepared', 'activation-attempted'].includes(guard.phase)) throw recovery();
        guard.phase = 'committing';
        await save();
        await retire();
        await clear();
      },
    };
  } catch (error) {
    const guard = await updateGuard(directory, appUrn).catch(() => undefined);
    if (guard !== undefined && guard?.id !== id) {
      const current = await fs.lstat(staging);
      if (current.ino === owned.ino && current.dev === owned.dev && current.isDirectory() && !current.isSymbolicLink())
        await fs.rm(staging, { recursive: true });
    }
    throw error;
  }
}
