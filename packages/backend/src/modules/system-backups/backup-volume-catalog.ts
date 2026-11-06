import { createHash } from 'node:crypto';
import path from 'node:path';
import { BackupRequirementError } from './backup-files';
import { fullBackupLimits } from './backup-limits';
import type { BackupVolumeArchive } from './backup-docker-volumes';

const fail = () => new BackupRequirementError('App volume backup metadata could not be verified. No data was changed.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) => Object.keys(value).sort().join('\0') === [...names].sort().join('\0');
const hash = /^[a-f0-9]{64}$/;
const sourceName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const serviceName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const safeText = (value: string) =>
  !Array.from(value).some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point < 32 || point === 127 || char === '\\' || point === 0xfffd || (point >= 0xd800 && point <= 0xdfff);
  });
const validPath = (value: unknown, absolute: boolean): value is string => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || !safeText(value) || value.startsWith('/') !== absolute) return false;
  const parts = (absolute ? value.slice(1) : value).split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
};

type Context = {
  containers: readonly { id: string; project: string }[];
  files: readonly { name: string; bytes: number; sha256: string }[];
  directories: readonly { name: string }[];
};

export function validateBackupVolumeCatalog(value: unknown, context: Context): BackupVolumeArchive[] {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    !context ||
    !Array.isArray(context.containers) ||
    !Array.isArray(context.files) ||
    !Array.isArray(context.directories) ||
    context.files.length + context.directories.length > fullBackupLimits.entries ||
    context.containers.length > fullBackupLimits.entries
  )
    throw fail();
  const containers = new Map<string, string>();
  for (const item of context.containers) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !hash.test(item.id) ||
      typeof item.project !== 'string' ||
      !item.project ||
      Buffer.byteLength(item.project) > 255 ||
      !safeText(item.project) ||
      containers.has(item.id)
    )
      throw fail();
    containers.set(item.id, item.project);
  }
  const files = new Map<string, { bytes: number; sha256: string }>();
  for (const file of context.files) {
    if (!object(file) || typeof file.name !== 'string') throw fail();
    if (file.name !== 'volumes' && !file.name.startsWith('volumes/')) continue;
    if (
      files.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !hash.test(file.sha256)
    )
      throw fail();
    files.set(file.name, { bytes: file.bytes as number, sha256: file.sha256 });
  }
  const directories = context.directories.filter((directory) => {
    if (!object(directory) || typeof directory.name !== 'string') throw fail();
    return directory.name === 'volumes' || directory.name.startsWith('volumes/');
  });
  if (value.length ? directories.length !== 1 || directories[0]?.name !== 'volumes' : directories.length !== 0) throw fail();
  const expectedFiles = new Set<string>();
  const names = new Set<string>();
  const volumeKeys = new Set<string>();
  const destinations = new Map<string, Set<string>>();
  const replicas = new Map<string, string>();
  let mountCount = 0;
  let socketCount = 0;
  let pathBytes = 0;
  let metadataBytes = 0;
  const consumePath = (item: string) => {
    pathBytes += Buffer.byteLength(item);
    if (pathBytes > fullBackupLimits.pathBytes) throw fail();
  };
  const result: BackupVolumeArchive[] = [];
  for (const volume of value) {
    if (
      !object(volume) ||
      !keys(volume, ['key', 'sourceName', 'mounts', 'archive', 'inventory', 'excludedRuntimeSockets']) ||
      typeof volume.sourceName !== 'string' ||
      !sourceName.test(volume.sourceName) ||
      names.has(volume.sourceName) ||
      typeof volume.key !== 'string' ||
      volume.key !== createHash('sha256').update(`orbis.backup-volume.v1\n${volume.sourceName}`).digest('hex') ||
      volumeKeys.has(volume.key) ||
      !Array.isArray(volume.mounts) ||
      !volume.mounts.length ||
      !Array.isArray(volume.excludedRuntimeSockets)
    )
      throw fail();
    names.add(volume.sourceName);
    volumeKeys.add(volume.key);
    const mounts: Array<BackupVolumeArchive['mounts'][number]> = [];
    for (const mount of volume.mounts) {
      if (
        ++mountCount > 4096 ||
        !object(mount) ||
        !keys(mount, ['containerId', 'project', 'service', 'ordinal', 'target', 'readOnly']) ||
        typeof mount.containerId !== 'string' ||
        !hash.test(mount.containerId) ||
        typeof mount.project !== 'string' ||
        containers.get(mount.containerId) !== mount.project ||
        typeof mount.service !== 'string' ||
        !serviceName.test(mount.service) ||
        !Number.isInteger(mount.ordinal) ||
        (mount.ordinal as number) < 1 ||
        (mount.ordinal as number) > 9999 ||
        !validPath(mount.target, true) ||
        typeof mount.readOnly !== 'boolean'
      )
        throw fail();
      consumePath(mount.target);
      const prior = destinations.get(mount.containerId) ?? new Set<string>();
      if (prior.has(mount.target)) throw fail();
      prior.add(mount.target);
      destinations.set(mount.containerId, prior);
      const replica = JSON.stringify([mount.project, mount.service, mount.target]);
      const binding = JSON.stringify([volume.sourceName, mount.readOnly]);
      if (replicas.has(replica) && replicas.get(replica) !== binding) throw fail();
      replicas.set(replica, binding);
      mounts.push({
        containerId: mount.containerId,
        project: mount.project,
        service: mount.service,
        ordinal: mount.ordinal as number,
        target: mount.target,
        readOnly: mount.readOnly,
      });
    }
    const archive = volume.archive;
    const inventory = volume.inventory;
    const target = mounts[0]?.target;
    if (
      !target ||
      !object(archive) ||
      !keys(archive, ['name', 'root', 'bytes', 'sha256']) ||
      archive.name !== `volumes/${volume.key}.tar` ||
      archive.root !== path.posix.basename(target) ||
      !validPath(archive.root, false) ||
      archive.root.includes('/') ||
      !Number.isSafeInteger(archive.bytes) ||
      (archive.bytes as number) < 1024 ||
      (archive.bytes as number) % 512 !== 0 ||
      typeof archive.sha256 !== 'string' ||
      !hash.test(archive.sha256) ||
      !object(inventory) ||
      !keys(inventory, ['name', 'bytes', 'sha256']) ||
      inventory.name !== `volumes/${volume.key}.inventory.json` ||
      !Number.isSafeInteger(inventory.bytes) ||
      (inventory.bytes as number) < 1 ||
      (inventory.bytes as number) > fullBackupLimits.manifestBytes ||
      typeof inventory.sha256 !== 'string' ||
      !hash.test(inventory.sha256)
    )
      throw fail();
    metadataBytes += inventory.bytes as number;
    if (metadataBytes > fullBackupLimits.manifestBytes) throw fail();
    for (const entry of [archive, inventory]) {
      const name = entry.name as string;
      consumePath(name);
      const file = files.get(name);
      if (!file || file.bytes !== entry.bytes || file.sha256 !== entry.sha256 || expectedFiles.has(name)) throw fail();
      expectedFiles.add(name);
    }
    const sockets = new Set<string>();
    for (const socket of volume.excludedRuntimeSockets) {
      if (++socketCount > fullBackupLimits.entries || !validPath(socket, false) || sockets.has(socket)) throw fail();
      sockets.add(socket);
      consumePath(socket);
    }
    result.push({
      key: volume.key,
      sourceName: volume.sourceName,
      mounts,
      archive: { name: archive.name as string, root: archive.root as string, bytes: archive.bytes as number, sha256: archive.sha256 },
      inventory: { name: inventory.name as string, bytes: inventory.bytes as number, sha256: inventory.sha256 },
      excludedRuntimeSockets: [...sockets],
    });
  }
  if (expectedFiles.size !== files.size) throw fail();
  for (const targets of destinations.values())
    for (const target of targets) {
      const parts = target.split('/');
      for (let index = 2; index < parts.length; index++) if (targets.has(parts.slice(0, index).join('/'))) throw fail();
    }
  return result;
}
