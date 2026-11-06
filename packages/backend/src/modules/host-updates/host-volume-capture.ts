import { createHash } from 'node:crypto';
import type { BackupVolumeEntry, BackupVolumeInventory, BackupVolumePlan } from '../system-backups/backup-docker-volumes';
import { canonicalPublicationJson } from './host-controller-publication';

const fail = () => new Error('App volume capture response could not be verified.');
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const capability = {
  version: 1,
  schema: 'orbis.backup-volume-capture.v1',
  manifestVersion: 3,
  appRuntimeSchema: 'orbis.app-runtime-capture.v1',
  inventorySchema: 'orbis.backup-volume-inventory.v1',
  authority: 'root-controller-capture-fence.v2',
  scope: 'orbis-managed-writers.v1',
} as const;

export function decodeBackupVolumeCapability(raw: unknown, expectedSourceSha256: string) {
  if (
    !record(raw) ||
    !keys(raw, [...Object.keys(capability), 'sourceSha256', 'contractSha256']) ||
    !hash.test(expectedSourceSha256) ||
    raw.sourceSha256 !== expectedSourceSha256 ||
    typeof raw.contractSha256 !== 'string' ||
    !hash.test(raw.contractSha256) ||
    Object.entries(capability).some(([name, value]) => raw[name] !== value)
  )
    throw fail();
  const unsigned = { ...capability, sourceSha256: expectedSourceSha256 };
  const contractSha256 = digest(`orbis.backup-volume-capture-capability.v1\n${canonicalPublicationJson(unsigned)}`);
  if (raw.contractSha256 !== contractSha256) throw fail();
  return Object.freeze({ ...unsigned, contractSha256 });
}

export type HostVolumeCaptureBinding = { pointId: string; appRuntimeSha256: string; volumeContractSha256: string };
function envelope(raw: unknown, binding: HostVolumeCaptureBinding, fields: string[]): asserts raw is Record<string, unknown> {
  if (
    !record(binding) ||
    !keys(binding, ['pointId', 'appRuntimeSha256', 'volumeContractSha256']) ||
    typeof binding.pointId !== 'string' ||
    !uuid.test(binding.pointId) ||
    typeof binding.appRuntimeSha256 !== 'string' ||
    !hash.test(binding.appRuntimeSha256) ||
    typeof binding.volumeContractSha256 !== 'string' ||
    !hash.test(binding.volumeContractSha256) ||
    !record(raw) ||
    !keys(raw, ['version', 'pointId', 'appRuntimeSha256', 'volumeContractSha256', ...fields]) ||
    raw.version !== 1 ||
    raw.pointId !== binding.pointId ||
    raw.appRuntimeSha256 !== binding.appRuntimeSha256 ||
    raw.volumeContractSha256 !== binding.volumeContractSha256
  )
    throw fail();
}

export function decodeHostVolumePlan(raw: unknown, binding: HostVolumeCaptureBinding, expectedPlan: BackupVolumePlan): string {
  envelope(raw, binding, ['plan', 'planSha256']);
  let expected: string;
  let actual: string;
  try {
    expected = canonicalPublicationJson(expectedPlan);
    actual = canonicalPublicationJson(raw.plan);
  } catch {
    throw fail();
  }
  if (typeof raw.planSha256 !== 'string' || !hash.test(raw.planSha256) || raw.planSha256 !== digest(expected) || actual !== expected) throw fail();
  return raw.planSha256;
}

function safe(value: string) {
  return !Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || char === '\\' || code === 0xfffd || (code >= 0xd800 && code <= 0xdfff);
  });
}
function name(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    safe(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)
  );
}
function linkTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && safe(value) && !value.startsWith('/');
}

export function decodeHostVolumeInventories(
  raw: unknown,
  binding: HostVolumeCaptureBinding,
  plan: BackupVolumePlan,
): readonly BackupVolumeInventory[] {
  envelope(raw, binding, ['inventories']);
  if (
    !plan ||
    plan.version !== 1 ||
    !Array.isArray(plan.volumes) ||
    plan.volumes.length > 1024 ||
    !Array.isArray(raw.inventories) ||
    raw.inventories.length !== plan.volumes.length
  )
    throw fail();
  const volumes = new Map<string, BackupVolumePlan['volumes'][number]>();
  const sources = new Set<string>();
  for (const volume of plan.volumes) {
    if (
      !volume ||
      typeof volume.key !== 'string' ||
      !hash.test(volume.key) ||
      volumes.has(volume.key) ||
      typeof volume.sourceName !== 'string' ||
      sources.has(volume.sourceName) ||
      !Array.isArray(volume.mounts) ||
      !volume.mounts.length
    )
      throw fail();
    volumes.set(volume.key, volume);
    sources.add(volume.sourceName);
  }
  const seen = new Set<string>();
  let entriesTotal = 0;
  let pathsTotal = 0;
  let bytesTotal = 0;
  const inventories: BackupVolumeInventory[] = [];
  for (const item of raw.inventories) {
    if (
      !record(item) ||
      !keys(item, ['key', 'sourceName', 'containerId', 'entries']) ||
      typeof item.key !== 'string' ||
      seen.has(item.key) ||
      typeof item.sourceName !== 'string' ||
      typeof item.containerId !== 'string' ||
      !hash.test(item.containerId) ||
      !Array.isArray(item.entries)
    )
      throw fail();
    const volume = volumes.get(item.key);
    if (!volume || item.sourceName !== volume.sourceName || !volume.mounts.some((mount) => mount.containerId === item.containerId)) throw fail();
    seen.add(item.key);
    const entries: BackupVolumeEntry[] = [];
    const kinds = new Map<string, string>();
    for (const entry of item.entries) {
      if (
        ++entriesTotal > 250000 ||
        !record(entry) ||
        typeof entry.name !== 'string' ||
        (entry.name !== '.' && !name(entry.name)) ||
        kinds.has(entry.name) ||
        typeof entry.kind !== 'string'
      )
        throw fail();
      pathsTotal += Buffer.byteLength(entry.name);
      let decoded: BackupVolumeEntry;
      if ((entry.kind === 'directory' || entry.kind === 'socket') && keys(entry, ['name', 'kind'])) {
        decoded = { name: entry.name, kind: entry.kind };
      } else if (
        entry.kind === 'file' &&
        keys(entry, ['name', 'kind', 'bytes', 'sha256']) &&
        Number.isSafeInteger(entry.bytes) &&
        (entry.bytes as number) >= 0 &&
        typeof entry.sha256 === 'string' &&
        hash.test(entry.sha256)
      ) {
        bytesTotal += entry.bytes as number;
        if (bytesTotal > 1024 ** 4) throw fail();
        decoded = { name: entry.name, kind: 'file', bytes: entry.bytes as number, sha256: entry.sha256 };
      } else if (entry.kind === 'symlink' && keys(entry, ['name', 'kind', 'target']) && linkTarget(entry.target)) {
        pathsTotal += Buffer.byteLength(entry.target);
        decoded = { name: entry.name, kind: 'symlink', target: entry.target };
      } else throw fail();
      if (pathsTotal > 32 * 1024 * 1024) throw fail();
      kinds.set(entry.name, entry.kind);
      entries.push(Object.freeze(decoded));
    }
    if (kinds.get('.') !== 'directory') throw fail();
    for (const entry of entries) {
      if (entry.name === '.') continue;
      const parts = entry.name.split('/');
      for (let index = 1; index < parts.length; index++) if (kinds.get(parts.slice(0, index).join('/')) !== 'directory') throw fail();
    }
    inventories.push(Object.freeze({ key: item.key, sourceName: item.sourceName, containerId: item.containerId, entries: Object.freeze(entries) }));
  }
  return Object.freeze(inventories);
}

export function decodeHostVolumeStopped(raw: unknown, binding: HostVolumeCaptureBinding): void {
  envelope(raw, binding, ['stopped']);
  if (raw.stopped !== true) throw fail();
}
