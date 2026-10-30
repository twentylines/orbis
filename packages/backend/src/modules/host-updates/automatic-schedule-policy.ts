import fs, { constants, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { type } from 'arktype';
import {
  automaticUpdateTimeSchema,
  automaticScheduleRevisionSchema,
  type AutomaticUpdateState,
  type SystemUpdateState,
} from './automatic-updates.model';

const revision = automaticScheduleRevisionSchema;
export const automaticSchedulePolicySchema = type({
  version: '1',
  orbis: type({ revision, enabled: 'boolean', time: automaticUpdateTimeSchema }).onUndeclaredKey('reject'),
  system: type({ revision, enabled: 'boolean', time: automaticUpdateTimeSchema.or('null') }).onUndeclaredKey('reject'),
})
  .onUndeclaredKey('reject')
  .narrow((value) => !value.system.enabled || value.system.time !== null);
export type AutomaticSchedulePolicy = typeof automaticSchedulePolicySchema.infer;

async function readPrivateScheduleRecord(file: string): Promise<{ data: string; stat: Stats } | null> {
  const directory = path.dirname(file);
  try {
    const parent = await fs.lstat(directory);
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      (process.getuid && parent.uid !== process.getuid()) ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error('Unsafe independent schedule directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096 || before.mode & 0o077 || (process.getuid && before.uid !== process.getuid()))
      throw new Error('Unsafe independent schedule policy');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead).toString('utf8');
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Independent schedule policy changed');
    return { data, stat: before };
  } finally {
    await handle.close();
  }
}

export async function readAutomaticSchedulePolicy(file: string): Promise<AutomaticSchedulePolicy | null> {
  const record = await readPrivateScheduleRecord(file);
  if (!record) return null;
  const { data } = record;
  const parsed: unknown = JSON.parse(data);
  const value = automaticSchedulePolicySchema(parsed);
  if (value instanceof type.errors || data.trim() !== JSON.stringify(value)) throw new Error('Invalid independent schedule policy');
  return value;
}

export async function readAutomaticSchedulePending(file: string) {
  const record = await readPrivateScheduleRecord(file);
  if (!record) return null;
  const value: unknown = JSON.parse(record.data);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'sha256,version' ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { sha256?: unknown }).sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test((value as { sha256: string }).sha256) ||
    record.data.trim() !== JSON.stringify(value)
  )
    throw new Error('Invalid pending schedule save');
  return { ...record.stat, sha256: (value as { sha256: string }).sha256 };
}
async function syncScheduleDirectory(file: string) {
  const handle = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function beginAutomaticScheduleSave(file: string, policy: AutomaticSchedulePolicy) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (await readAutomaticSchedulePending(file)) throw new Error('An earlier schedule save requires review');
  const sha256 = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let stat: Stats;
  try {
    await handle.writeFile(JSON.stringify({ version: 1, sha256 }));
    await handle.sync();
    stat = await handle.stat();
  } finally {
    await handle.close();
  }
  await syncScheduleDirectory(file);
  return { ...stat, sha256 };
}
export async function finishAutomaticScheduleSave(file: string, proof: { dev: number; ino: number; sha256: string }) {
  const current = await readAutomaticSchedulePending(file);
  if (!current || current.dev !== proof.dev || current.ino !== proof.ino || current.sha256 !== proof.sha256)
    throw new Error('Pending schedule save changed');
  await fs.unlink(file);
  try {
    await syncScheduleDirectory(file);
    return true;
  } catch {
    // The policy was durably committed before release; a resurrected marker only pauses recovery.
    return false;
  }
}

export function schedulePolicyFor(
  state: AutomaticUpdateState,
  system: SystemUpdateState,
  previous: AutomaticSchedulePolicy | null,
  override: { orbisTime?: string; systemTime?: string } = {},
): AutomaticSchedulePolicy {
  const policy = {
    version: 1 as const,
    orbis: {
      revision: state.revision,
      enabled: state.settings.orbis.enabled,
      time: override.orbisTime ?? previous?.orbis.time ?? state.settings.schedule.time,
    },
    system: { revision: system.revision, enabled: system.enabled, time: override.systemTime ?? previous?.system.time ?? null },
  };
  if (!automaticSchedulePolicySchema.allows(policy)) throw new Error('Invalid independent schedule policy');
  return policy;
}

export function legacyScheduleProjection(state: AutomaticUpdateState, system: SystemUpdateState) {
  const apps = structuredClone(state);
  apps.settings.orbis.enabled = false;
  return { apps, system: { ...structuredClone(system), enabled: false } };
}
