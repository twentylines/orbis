import path from 'node:path';
import type Dockerode from 'dockerode';
import type { AppStorageObservation } from '../host-updates/app-storage-observation';
import { migrationEngineRequest, inspectMigrationContainer, migrationRecord as record } from './app-migration-engine';
const fail = () => new Error('App storage ownership could not be verified. Existing data was kept.');
const id = /^[a-f0-9]{64}$/;
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  path.posix.normalize(value) === value &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\0\r\n\\]/.test(value);
const overlaps = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : b + '/') || b.startsWith(a === '/' ? '/' : a + '/');

export async function readAppContainerInventory(docker: Dockerode) {
  const signal = AbortSignal.timeout(30_000);
  const listed = await migrationEngineRequest(docker, '/containers/json?', 'GET', { all: true }, signal);
  let bytes = 0;
  if (!Array.isArray(listed) || listed.length > 4096) throw fail();
  const result: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of listed) {
    if (!record(item) || typeof item.Id !== 'string' || !id.test(item.Id) || seen.has(item.Id)) throw fail();
    seen.add(item.Id);
    const value = await inspectMigrationContainer(docker, item.Id, signal);
    if (
      !value ||
      !record(value.Config) ||
      (value.Config.Labels !== null && value.Config.Labels !== undefined && !record(value.Config.Labels)) ||
      !Array.isArray(value.Mounts) ||
      value.Mounts.length > 256 ||
      !record(value.State)
    )
      throw fail();
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > 32 * 1024 * 1024) throw fail();
    result.push(value);
  }
  return result;
}
export function appContainerMounts(value: Record<string, unknown>) {
  if (!Array.isArray(value.Mounts)) throw fail();
  const seen = new Set<string>();
  return value.Mounts.map((mount) => {
    if (
      !record(mount) ||
      !absolute(mount.Destination) ||
      typeof mount.Type !== 'string' ||
      typeof mount.RW !== 'boolean' ||
      seen.has(mount.Destination)
    )
      throw fail();
    seen.add(mount.Destination);
    return { type: mount.Type, target: mount.Destination, source: mount.Source ?? null, name: mount.Name ?? null, writable: mount.RW };
  }).sort((a, b) => a.target.localeCompare(b.target));
}
export async function requireAppStorageOwners(
  docker: Dockerode,
  observed: Readonly<AppStorageObservation>,
  ownIds: Set<string>,
  ownVolumes: Set<string>,
) {
  const values = await readAppContainerInventory(docker);
  const owned = values.filter(
    (value) =>
      record(value.Config) && record(value.Config.Labels) && value.Config.Labels['com.docker.compose.project'] === observed.appUrn.replace(':', '_'),
  );
  if (owned.some((value) => typeof value.Id !== 'string' || !ownIds.has(value.Id)) || owned.length !== ownIds.size) throw fail();
  for (const value of values) {
    if (typeof value.Id !== 'string') throw fail();
    if (value.Id === observed.controller.id) {
      if (value.Image !== observed.controller.imageId || !record(value.State) || value.State.StartedAt !== observed.controller.startedAt)
        throw fail();
      continue;
    }
    if (ownIds.has(value.Id)) continue;
    for (const mount of appContainerMounts(value)) {
      if (!mount.writable) continue;
      if (mount.type === 'bind' && (!absolute(mount.source) || overlaps(mount.source, observed.hostPath))) throw fail();
      if (mount.type === 'volume' && typeof mount.name === 'string' && ownVolumes.has(mount.name)) throw fail();
    }
  }
  return owned;
}
