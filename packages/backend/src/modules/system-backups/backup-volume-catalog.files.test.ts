import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BackupVolumeArchive } from './backup-docker-volumes';
import { BackupRequirementError } from './backup-files';
import { validateBackupVolumeCatalog } from './backup-volume-catalog';

const digest = (name: string) => createHash('sha256').update(`orbis.backup-volume.v1\n${name}`).digest('hex');
const containerId = 'a'.repeat(64);
const secondId = 'b'.repeat(64);
const contentHash = 'c'.repeat(64);
function fixture(name = 'app-data', id = containerId): BackupVolumeArchive {
  const key = digest(name);
  return {
    key,
    sourceName: name,
    mounts: [{ containerId: id, project: 'app_store', service: 'app', ordinal: 1, target: '/var/data', readOnly: false }],
    archive: { name: `volumes/${key}.tar`, root: 'data', bytes: 1024, sha256: contentHash },
    inventory: { name: `volumes/${key}.inventory.json`, bytes: 123, sha256: contentHash },
    excludedRuntimeSockets: ['run/server.sock'],
  };
}
function context(records: BackupVolumeArchive[]) {
  return {
    containers: [
      { id: containerId, project: 'app_store' },
      { id: secondId, project: 'app_store' },
    ],
    files: records.flatMap((record) => [record.archive, record.inventory].map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))),
    directories: records.length ? [{ name: 'volumes' }] : [],
  };
}
function rejects(records: unknown, ctx: ReturnType<typeof context>) {
  expect(() => validateBackupVolumeCatalog(records, ctx)).toThrow(BackupRequirementError);
}

describe('backup volume catalog validation', () => {
  it('accepts capture-shaped metadata and returns a detached clone', () => {
    const original = [fixture()];
    const result = validateBackupVolumeCatalog(original, context(original));
    expect(result).toEqual(original);
    expect(result[0]).not.toBe(original[0]);
    expect(result[0]?.mounts).not.toBe(original[0]?.mounts);
    expect(validateBackupVolumeCatalog([], context([]))).toEqual([]);
  });
  it('matches exact inventory/archive manifest files and the exclusive volume directory', () => {
    const records = [fixture()];
    const base = context(records);
    rejects(records, { ...base, files: base.files.slice(0, 1) });
    rejects(records, { ...base, files: [...base.files, { name: 'volumes/extra', bytes: 0, sha256: contentHash }] });
    rejects(records, { ...base, files: base.files.map((file, index) => (index ? file : { ...file, bytes: 1536 })) });
    rejects(records, { ...base, files: base.files.map((file, index) => (index ? file : { ...file, sha256: 'd'.repeat(64) })) });
    rejects(records, { ...base, directories: [] });
    rejects(records, { ...base, directories: [...base.directories, { name: 'volumes/extra' }] });
    rejects([], { ...context([]), directories: [{ name: 'volumes' }] });
  });
  it('rejects foreign consumers, mismatched projects and duplicate or nested mount destinations', () => {
    const record = fixture();
    const base = context([record]);
    rejects([{ ...record, mounts: [{ ...record.mounts[0], containerId: 'd'.repeat(64) }] }], base);
    rejects([{ ...record, mounts: [{ ...record.mounts[0], project: 'foreign' }] }], base);
    rejects([{ ...record, mounts: [record.mounts[0], record.mounts[0]] }], base);
    rejects([{ ...record, mounts: [record.mounts[0], { ...record.mounts[0], target: '/var/data/nested' }] }], base);
  });
  it('rejects replica-specific volume or read-only divergence', () => {
    const first = fixture();
    const second = fixture('other', secondId);
    const base = context([first, second]);
    rejects([first, second], base);
    const sameVolume = { ...first, mounts: [...first.mounts, { ...first.mounts[0], containerId: secondId, ordinal: 2, readOnly: true }] };
    rejects([sameVolume], context([first]));
    const consistent = { ...first, mounts: [...first.mounts, { ...first.mounts[0], containerId: secondId, ordinal: 2 }] };
    expect(validateBackupVolumeCatalog([consistent], context([first]))).toEqual([consistent]);
  });
  it('rejects malformed record keys, hashes, archive metadata and unsafe names', () => {
    const record = fixture();
    const base = context([record]);
    for (const invalid of [
      { ...record, unknown: true },
      { ...record, key: 'd'.repeat(64) },
      { ...record, sourceName: 'bad:name' },
      { ...record, archive: { ...record.archive, root: '../data' } },
      { ...record, archive: { ...record.archive, bytes: 1025 } },
      { ...record, inventory: { ...record.inventory, bytes: 0 } },
      { ...record, mounts: [{ ...record.mounts[0], target: '/var/../data' }] },
      { ...record, mounts: [{ ...record.mounts[0], target: '/' }] },
      { ...record, excludedRuntimeSockets: ['../socket'] },
      { ...record, excludedRuntimeSockets: ['a\\b'] },
      { ...record, excludedRuntimeSockets: ['a', 'a'] },
    ])
      rejects([invalid], base);
  });
  it('enforces catalog, mount, socket and metadata bounds', () => {
    const record = fixture();
    const base = context([record]);
    rejects(Array(1025).fill(record), base);
    const mounts = Array.from({ length: 4097 }, (_, index) => ({ ...record.mounts[0], target: `/var/${index}` }));
    rejects([{ ...record, mounts }], base);
    const sockets = Array.from({ length: 250001 }, (_, index) => `s${index}`);
    rejects([{ ...record, excludedRuntimeSockets: sockets }], base);
    const huge = { ...record, inventory: { ...record.inventory, bytes: 64 * 1024 * 1024 + 1 } };
    rejects([huge], context([huge]));
  });
});
