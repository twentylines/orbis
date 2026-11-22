import { assertPackageLinks, portablePackageLink } from '../app-stores/app-package-links';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs, { constants, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { APP_GENERATED_COMPOSE_FILENAME } from '@/common/constants';

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
export type StagedAppImageUpdate = AppImagePinUpdate & {
  targetDirectory: string;
  stageTarget: (compose: string, environment: string) => Promise<void>;
  recordPulledImages: (binding: PulledUpdateImages) => Promise<void>;
  publishTarget: () => Promise<void>;
};
export type PulledUpdateImages = { activationSha256: string; imageIds: Record<string, string> };
const validPulledImages = ({ activationSha256, imageIds }: PulledUpdateImages) =>
  hash.test(activationSha256) &&
  Object.keys(imageIds).length > 0 &&
  Object.keys(imageIds).length <= 256 &&
  Object.entries(imageIds).every(([name, image]) => service.test(name) && id.test(image));
export type MetadataEntry = {
  name: string;
  directory: boolean;
  mode: number;
  uid: number;
  gid: number;
  sha256?: string;
  bytes?: number;
  symlink?: string;
};
export type MetadataState = { entries: MetadataEntry[]; envSha256: string | null; envMode: number | null; envGid: number | null };
const recovery = () => new Error('Retained app update requires explicit recovery. Its metadata and any new app writes were preserved.');
const updatePath = (directory: string, appUrn: string) => location(directory, appUrn).replace(/\.json$/, '.update.json');

function stagedPaths(directory: string, id: string) {
  const staging = path.join(directory, `update-${id}`);
  const target = path.join(staging, 'target');
  return { staging, target, compose: path.join(target, APP_GENERATED_COMPOSE_FILENAME), env: path.join(staging, 'target.env') };
}

const sameDirectory = (actual: Stats, expected: unknown) =>
  record(expected) && actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino;
const directoryIdentity = ({ dev, ino }: Stats) => ({ dev, ino });

async function requireVacantUpdatePath(file: string) {
  try {
    await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw recovery();
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceUpdateFile(file: string, bytes: Uint8Array | string, mode: number, gid?: number, renamed?: () => void) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    if (gid !== undefined) await handle.chown(process.geteuid?.() ?? -1, gid);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    renamed?.();
    await syncDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

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

async function metadataState(metadata: string, env: string, copyTo?: string, options?: { omitGenerated: true }): Promise<MetadataState> {
  await noSymlinkParents(metadata);
  await noSymlinkParents(path.dirname(env));
  const entries: MetadataEntry[] = [];
  let total = 0;
  const visit = async (name: string) => {
    if (options?.omitGenerated && name === APP_GENERATED_COMPOSE_FILENAME) return;
    if (entries.length >= 4096 || Buffer.byteLength(name) > 512) throw recovery();
    const source = path.join(metadata, name);
    const stat = await fs.lstat(source);
    if (stat.uid !== process.geteuid?.() || (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile())) throw recovery();
    const entry: MetadataEntry = { name, directory: stat.isDirectory(), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
    entries.push(entry);
    const destination = copyTo ? path.join(copyTo, 'metadata', name) : null;
    if (stat.isDirectory()) {
      if (destination) await fs.mkdir(destination, { mode: 0o700 });
      for (const child of (await fs.readdir(source)).sort()) await visit(name ? path.join(name, child) : child);
    } else if (stat.isSymbolicLink()) {
      const link = await fs.readlink(source);
      const after = await fs.lstat(source);
      if (
        !portablePackageLink(link) ||
        ['dev', 'ino', 'uid', 'gid', 'mode', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(after, key))
      )
        throw recovery();
      entry.symlink = link;
      entry.bytes = Buffer.byteLength(link);
      entry.sha256 = createHash('sha256').update(link).digest('hex');
      total += entry.bytes;
      if (total > 64 * 1024 * 1024) throw recovery();
      if (destination) await fs.symlink(link, destination);
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
  assertPackageLinks(entries);
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

export type AppImageUpdateGuard =
  | { version: 1; appUrn: string; id: string; phase: string }
  | { version: 2; appUrn: string; id: string; phase: string; requestId: string; revision: number; journalSha256: string };

async function updateGuard(directory: string, appUrn: string): Promise<AppImageUpdateGuard | null> {
  if (!(await directorySafe(directory, false))) return null;
  try {
    const guard = await privateJson(updatePath(directory, appUrn));
    if (
      !record(guard) ||
      !keys(
        guard,
        guard.version === 2 ? ['version', 'appUrn', 'id', 'phase', 'requestId', 'revision', 'journalSha256'] : ['version', 'appUrn', 'id', 'phase'],
      ) ||
      (guard.version !== 1 && guard.version !== 2) ||
      guard.appUrn !== appUrn ||
      typeof guard.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(guard.id) ||
      ![
        'staged',
        'target-ready',
        'switching',
        'prepared',
        'activation-attempted',
        'committing',
        ...(guard.version === 2 ? ['rolling-back', 'rolled-back', 'commit-verified'] : []),
      ].includes(String(guard.phase)) ||
      (guard.version === 2 &&
        (typeof guard.requestId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(guard.requestId) ||
          !Number.isSafeInteger(guard.revision) ||
          Number(guard.revision) < 0 ||
          typeof guard.journalSha256 !== 'string' ||
          !hash.test(guard.journalSha256)))
    )
      throw recovery();
    return guard as AppImageUpdateGuard;
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

async function readUpdateJournal(staging: string, guard: AppImageUpdateGuard) {
  const file = path.join(staging, 'journal.json');
  if (((await fs.lstat(file)).mode & 0o077) !== 0) throw recovery();
  const bytes = await readOwned(file, 4 * 1024 * 1024);
  if (guard.version === 2 && createHash('sha256').update(bytes).digest('hex') !== guard.journalSha256) throw recovery();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (guard.version === 2 && (!record(value) || value.version !== 2 || value.requestId !== guard.requestId || value.revision !== guard.revision))
    throw recovery();
  return value;
}

/** Internal file primitives shared with request-bound staged updates; no execution or recovery authority. */
export const appUpdateStorage = {
  directorySafe,
  stagedPaths,
  sameDirectory,
  directoryIdentity,
  updatePath,
  updateGuard,
  requireVacantUpdatePath,
  syncDirectory,
  replaceUpdateFile,
  privateJson,
  readOwned,
  noSymlinkParents,
  metadataState,
  validPulledImages,
};

export async function readStagedAppUpdate(directory: string, appUrn: string, id: string) {
  const guard = await requireAppImagePinUpdate(directory, appUrn, id);
  if (guard?.phase !== 'target-ready') throw recovery();
  const paths = stagedPaths(directory, id);
  if (!(await directorySafe(paths.staging, false))) throw recovery();
  const journal = await readUpdateJournal(paths.staging, guard);
  if (!record(journal) || journal.id !== id || journal.appUrn !== appUrn || journal.phase !== guard.phase || !journal.prepared) throw recovery();
  if (
    !sameDirectory(await fs.lstat(paths.target), journal.targetIdentity) ||
    JSON.stringify(await metadataState(paths.target, paths.env)) !== JSON.stringify(journal.prepared)
  )
    throw recovery();
  return paths;
}

export async function requireStagedAppUpdateActivation(directory: string, appUrn: string, id: string, binding: PulledUpdateImages) {
  const guard = await requireAppImagePinUpdate(directory, appUrn, id);
  if (guard?.phase !== 'activation-attempted') throw recovery();
  const { staging } = stagedPaths(directory, id);
  if (!(await directorySafe(staging, false))) throw recovery();
  const journal = await readUpdateJournal(staging, guard);
  if (
    !record(journal) ||
    journal.id !== id ||
    journal.appUrn !== appUrn ||
    journal.phase !== guard.phase ||
    JSON.stringify(journal.pulledImages) !== JSON.stringify(binding)
  )
    throw recovery();
}

export const STAGED_UPDATE_DEFAULT_PLATFORM = 'x-orbis-update-default-platform';

export async function withStagedUpdateOverrides<T>(
  directory: string,
  appUrn: string,
  id: string,
  inputs: { compose: string | null; env: string | null },
  use: (paths: { compose?: string; env?: string; platform: string }) => Promise<T>,
) {
  const { staging } = await readStagedAppUpdate(directory, appUrn, id);
  if (Buffer.byteLength(inputs.compose ?? '') > 2 * 1024 * 1024 || Buffer.byteLength(inputs.env ?? '') > 1024 * 1024) throw recovery();
  const snapshot = path.join(staging, 'user-overrides');
  await fs.mkdir(snapshot, { mode: 0o700 });
  const owned = directoryIdentity(await fs.lstat(snapshot));
  const removeSnapshot = async () => {
    if (!sameDirectory(await fs.lstat(snapshot), owned)) throw recovery();
    await fs.rm(snapshot, { recursive: true });
  };
  let result: T;
  try {
    const compose = inputs.compose ? path.join(snapshot, 'compose.yml') : undefined;
    const env = inputs.env ? path.join(snapshot, 'app.env') : undefined;
    const platform = path.join(snapshot, 'platform.yml');
    if (compose && inputs.compose) await fs.writeFile(compose, inputs.compose, { flag: 'wx', mode: 0o600 });
    if (env && inputs.env) await fs.writeFile(env, inputs.env, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(platform, `${STAGED_UPDATE_DEFAULT_PLATFORM}: "\${DOCKER_DEFAULT_PLATFORM:-}"\n`, { flag: 'wx', mode: 0o600 });
    result = await use({ compose, env, platform });
  } catch (error) {
    await removeSnapshot().catch(() => undefined);
    throw error;
  }
  await removeSnapshot();
  return result;
}

export async function beginAppImagePinUpdate(
  directory: string,
  appUrn: string,
  metadata: string,
  env: string,
  staged = false,
): Promise<StagedAppImageUpdate> {
  await directorySafe(directory, true);
  await requireAppImagePinUpdate(directory, appUrn);
  const capacity = await fs.statfs(directory);
  if (capacity.bavail * capacity.bsize < (65 + 4 + 256 + (staged ? 65 : 0)) * 1024 * 1024) throw recovery();
  const id = randomUUID();
  const paths = stagedPaths(directory, id);
  const staging = paths.staging;
  const previousLive = path.join(staging, 'previous-live');
  if (staging.startsWith(`${metadata}/`) || metadata === directory || env.startsWith(`${directory}/`)) throw recovery();
  await fs.mkdir(staging, { mode: 0o700 });
  const owned = await fs.lstat(staging);
  try {
    const originalIdentity = directoryIdentity(await fs.lstat(metadata));
    const environmentParent = directoryIdentity(await fs.lstat(path.dirname(env)));
    const baseline = await metadataState(metadata, env, staging);
    if (JSON.stringify(baseline) !== JSON.stringify(await metadataState(metadata, env))) throw recovery();
    const syncTree = async (root: string, entries: MetadataEntry[], environment?: string) => {
      for (const entry of [...entries].reverse()) {
        if (entry.symlink !== undefined) continue;
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
    let targetIdentity: ReturnType<typeof directoryIdentity> | null = null;
    let pulledImages: PulledUpdateImages | null = null;
    let movedOriginal = false;
    let movedTarget = false;
    let replacedEnv = false;
    const guard = { version: 1, appUrn, id, phase: 'staged' };
    let initial = true;
    const save = async () => {
      await privateJson(path.join(staging, 'journal.json'), { ...guard, metadata, env, baseline, prepared, targetIdentity, pulledImages });
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
      if (
        current.ino !== owned.ino ||
        current.dev !== owned.dev ||
        current.uid !== owned.uid ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        (current.mode & 0o077) !== 0
      )
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
    const verifyBaseline = async () => {
      if (
        !sameDirectory(await fs.lstat(metadata), originalIdentity) ||
        !sameDirectory(await fs.lstat(path.dirname(env)), environmentParent) ||
        JSON.stringify(await metadataState(metadata, env)) !== JSON.stringify(baseline)
      )
        throw recovery();
    };
    const checkMetadata = async (root: string, expected: MetadataState) => {
      if (JSON.stringify((await metadataState(root, env)).entries) !== JSON.stringify(expected.entries)) throw recovery();
    };
    const verifyCurrentEnv = async (expected: MetadataState) => {
      const state = await metadataState(previousLive, env);
      if (state.envSha256 !== expected.envSha256 || state.envMode !== expected.envMode || state.envGid !== expected.envGid) throw recovery();
    };
    const restoreStaged = async () => {
      if (!['staged', 'target-ready', 'switching', 'prepared'].includes(guard.phase)) throw recovery();
      if (!movedOriginal) {
        await verifyBaseline();
        await clear();
        return;
      }
      if (!prepared) throw recovery();
      if (!sameDirectory(await fs.lstat(previousLive), originalIdentity) || !sameDirectory(await fs.lstat(path.dirname(env)), environmentParent))
        throw recovery();
      await checkMetadata(previousLive, baseline);
      await verifyCurrentEnv(replacedEnv ? prepared : baseline);
      if (movedTarget) {
        if (!sameDirectory(await fs.lstat(metadata), targetIdentity)) throw recovery();
        await checkMetadata(metadata, prepared);
        await requireVacantUpdatePath(paths.target);
        await fs.rename(metadata, paths.target);
      } else {
        await requireVacantUpdatePath(metadata);
      }
      await fs.rename(previousLive, metadata);
      if (replacedEnv) {
        if (baseline.envSha256 === null) {
          await fs.unlink(env);
          await syncDirectory(path.dirname(env));
        } else {
          const oldEnv = await readOwned(path.join(staging, 'app.env'), 1024 * 1024);
          if (createHash('sha256').update(oldEnv).digest('hex') !== baseline.envSha256) throw recovery();
          await replaceUpdateFile(env, oldEnv, baseline.envMode ?? 0o600, baseline.envGid ?? undefined);
        }
      }
      await verifyBaseline();
      await syncDirectory(path.dirname(metadata));
      await clear();
    };
    return {
      id,
      targetDirectory: paths.target,
      stageTarget: async (compose, environment) => {
        await requireOwned();
        if (!staged || pulledImages || !['staged', 'target-ready'].includes(guard.phase)) throw recovery();
        await verifyBaseline();
        if (Buffer.byteLength(compose) > 8 * 1024 * 1024 || Buffer.byteLength(environment) > 1024 * 1024) throw recovery();
        const currentTarget = await fs.lstat(paths.target);
        if (currentTarget.dev !== originalIdentity.dev) throw recovery();
        const before = await metadataState(paths.target, paths.env);
        if (prepared && (!sameDirectory(currentTarget, targetIdentity) || JSON.stringify(before) !== JSON.stringify(prepared))) throw recovery();
        targetIdentity = directoryIdentity(currentTarget);
        await replaceUpdateFile(paths.compose, compose, 0o600);
        await replaceUpdateFile(paths.env, environment, 0o600);
        prepared = await metadataState(paths.target, paths.env);
        await syncTree(paths.target, prepared.entries, paths.env);
        guard.phase = 'target-ready';
        await save();
      },
      recordPulledImages: async (binding) => {
        await requireOwned();
        if (!staged || guard.phase !== 'target-ready' || pulledImages || !validPulledImages(binding)) throw recovery();
        await readStagedAppUpdate(directory, appUrn, id);
        pulledImages = structuredClone(binding);
        await save();
      },
      publishTarget: async () => {
        await requireOwned();
        if (!staged || guard.phase !== 'target-ready' || !prepared || !pulledImages) throw recovery();
        await verifyBaseline();
        if (
          !sameDirectory(await fs.lstat(paths.target), targetIdentity) ||
          JSON.stringify(await metadataState(paths.target, paths.env)) !== JSON.stringify(prepared)
        )
          throw recovery();
        if ((await fs.lstat(metadata)).dev !== (await fs.lstat(paths.target)).dev) throw recovery();
        await requireVacantUpdatePath(previousLive);
        const targetEnv = await readOwned(paths.env, 1024 * 1024);
        if (createHash('sha256').update(targetEnv).digest('hex') !== prepared.envSha256) throw recovery();
        guard.phase = 'switching';
        await save();
        await fs.rename(metadata, previousLive);
        movedOriginal = true;
        await fs.rename(paths.target, metadata);
        movedTarget = true;
        await syncDirectory(path.dirname(metadata));
        await syncDirectory(staging);
        await replaceUpdateFile(env, targetEnv, prepared.envMode ?? 0o600, prepared.envGid ?? undefined, () => {
          replacedEnv = true;
        });
        if (JSON.stringify(await metadataState(metadata, env)) !== JSON.stringify(prepared)) throw recovery();
        guard.phase = 'prepared';
        await save();
      },
      prepare: async () => {
        await requireOwned();
        if (staged || guard.phase !== 'staged') throw recovery();
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
        if (staged) return restoreStaged();
        if (!['staged', 'prepared'].includes(guard.phase)) throw recovery();
        if (JSON.stringify(await metadataState(metadata, env)) !== JSON.stringify(prepared ?? baseline)) throw recovery();
        for (const entry of baseline.entries) {
          if (entry.symlink !== undefined) {
            if ((await fs.readlink(path.join(staging, 'metadata', entry.name))) !== entry.symlink) throw recovery();
            continue;
          }
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
          } else if (entry.symlink !== undefined) {
            await fs.symlink(entry.symlink, target);
            await fs.lchown(target, entry.uid, entry.gid);
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
