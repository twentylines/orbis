import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BackupVolumePlan } from '../system-backups/backup-docker-volumes';
import { canonicalPublicationJson } from './host-controller-publication';
import { decodeBackupVolumeCapability, decodeHostVolumeInventories, decodeHostVolumePlan, decodeHostVolumeStopped } from './host-volume-capture';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const h = 'a'.repeat(64);
const containerId = 'b'.repeat(64);
const binding = { pointId: '12345678-1234-4123-8123-123456789abc', appRuntimeSha256: h, volumeContractSha256: 'c'.repeat(64) };
const base = { version: 1, ...binding };
const plan: BackupVolumePlan = {
  version: 1,
  volumes: [
    {
      key: 'd'.repeat(64),
      sourceName: 'source',
      mounts: [{ containerId, project: 'app_store', service: 'app', ordinal: 1, target: '/data', readOnly: false }],
    },
  ],
};
const entries = () => [
  { name: '.', kind: 'directory' },
  { name: 'data', kind: 'directory' },
  { name: 'data/file', kind: 'file', bytes: 5, sha256: h },
  { name: 'data/link', kind: 'symlink', target: '../data/file' },
  { name: 'data/socket', kind: 'socket' },
];
const inventory = () => ({ key: 'd'.repeat(64), sourceName: 'source', containerId, entries: entries() });
const envelope = () => ({ ...base, inventories: [inventory()] });

describe('host volume capture responses', () => {
  it('binds a capability to its exact source and contract', () => {
    const unsigned = {
      version: 1,
      schema: 'orbis.backup-volume-capture.v1',
      manifestVersion: 3,
      appRuntimeSchema: 'orbis.app-runtime-capture.v1',
      inventorySchema: 'orbis.backup-volume-inventory.v1',
      authority: 'root-controller-capture-fence.v2',
      scope: 'orbis-managed-writers.v1',
      sourceSha256: h,
    };
    const capability = { ...unsigned, contractSha256: sha(`orbis.backup-volume-capture-capability.v1\n${canonicalPublicationJson(unsigned)}`) };
    expect(decodeBackupVolumeCapability(capability, h)).toEqual(capability);
    expect(() => decodeBackupVolumeCapability(capability, 'f'.repeat(64))).toThrow();
    expect(() => decodeBackupVolumeCapability({ ...capability, extra: true }, h)).toThrow();
    expect(() => decodeBackupVolumeCapability({ ...capability, contractSha256: h }, h)).toThrow();
  });
  it('accepts only the independently expected plan even if a forged plan hashes itself', () => {
    const planSha256 = sha(canonicalPublicationJson(plan));
    expect(decodeHostVolumePlan({ ...base, plan, planSha256 }, binding, plan)).toBe(planSha256);
    const fake = { version: 1, volumes: [] };
    expect(() => decodeHostVolumePlan({ ...base, plan: fake, planSha256: sha(canonicalPublicationJson(fake)) }, binding, plan)).toThrow();
    expect(() => decodeHostVolumePlan({ ...base, plan, planSha256: h, extra: 1 }, binding, plan)).toThrow();
  });
  it('validates stopped responses and binding exactly', () => {
    expect(decodeHostVolumeStopped({ ...base, stopped: true }, binding)).toBeUndefined();
    for (const bad of [
      { ...base, stopped: false },
      { ...base, stopped: true, extra: 1 },
      { ...base, pointId: 'other', stopped: true },
    ])
      expect(() => decodeHostVolumeStopped(bad, binding)).toThrow();
    expect(() => decodeHostVolumeStopped({ ...base, stopped: true }, { ...binding, appRuntimeSha256: 'no' })).toThrow();
  });
  it('returns deeply frozen, detached valid inventories including links and sockets', () => {
    const response = envelope();
    const result = decodeHostVolumeInventories(response, binding, plan);
    expect(result).toEqual(response.inventories);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]?.entries)).toBe(true);
    expect(Object.isFrozen(result[0]?.entries[0])).toBe(true);
    response.inventories[0]?.entries.push({ name: 'later', kind: 'socket' });
    expect(result[0]?.entries).toHaveLength(5);
  });
  it('rejects missing, duplicate, foreign or wrongly bound inventories', () => {
    const inv = inventory();
    for (const invalid of [
      [],
      [inv, inv],
      [{ ...inv, key: 'e'.repeat(64) }],
      [{ ...inv, sourceName: 'foreign' }],
      [{ ...inv, containerId: 'e'.repeat(64) }],
      [{ ...inv, other: 1 }],
    ])
      expect(() => decodeHostVolumeInventories({ ...base, inventories: invalid }, binding, plan)).toThrow();
    expect(() => decodeHostVolumeInventories({ ...base, inventories: [inv], extra: true }, binding, plan)).toThrow();
  });
  it('rejects malformed, duplicate, unsafe or orphan entries', () => {
    for (const bad of [
      [{ name: '.', kind: 'file', bytes: 0, sha256: h }],
      [{ name: 'data', kind: 'directory' }],
      [...entries(), { name: 'data/file', kind: 'socket' }],
      [
        { name: '.', kind: 'directory' },
        { name: 'missing/child', kind: 'socket' },
      ],
      [
        { name: '.', kind: 'directory' },
        { name: '../escape', kind: 'socket' },
      ],
      [
        { name: '.', kind: 'directory' },
        { name: 'a\\b', kind: 'socket' },
      ],
      [
        { name: '.', kind: 'directory' },
        { name: 'bad', kind: 'file', bytes: -1, sha256: h },
      ],
      [
        { name: '.', kind: 'directory' },
        { name: 'bad', kind: 'symlink', target: '/absolute' },
      ],
      [
        { name: '.', kind: 'directory' },
        { name: 'bad', kind: 'socket', extra: true },
      ],
    ])
      expect(() => decodeHostVolumeInventories({ ...base, inventories: [{ ...inventory(), entries: bad }] }, binding, plan)).toThrow();
  });
  it('enforces entry, path, and logical-byte bounds', () => {
    const huge = [{ name: '.', kind: 'directory' }, ...Array.from({ length: 250000 }, (_, index) => ({ name: `s${index}`, kind: 'socket' }))];
    expect(() => decodeHostVolumeInventories({ ...base, inventories: [{ ...inventory(), entries: huge }] }, binding, plan)).toThrow();
    const bigFile = [
      { name: '.', kind: 'directory' },
      { name: 'a', kind: 'file', bytes: 1024 ** 4 + 1, sha256: h },
    ];
    expect(() => decodeHostVolumeInventories({ ...base, inventories: [{ ...inventory(), entries: bigFile }] }, binding, plan)).toThrow();
    const pathFlood = [
      { name: '.', kind: 'directory' },
      ...Array.from({ length: 8200 }, (_, index) => ({ name: `s${index}`, kind: 'symlink', target: 'a'.repeat(4096) })),
    ];
    expect(() => decodeHostVolumeInventories({ ...base, inventories: [{ ...inventory(), entries: pathFlood }] }, binding, plan)).toThrow();
    const longName = [
      { name: '.', kind: 'directory' },
      { name: 'x'.repeat(256), kind: 'socket' },
    ];
    expect(() => decodeHostVolumeInventories({ ...base, inventories: [{ ...inventory(), entries: longName }] }, binding, plan)).toThrow();
  });
});
