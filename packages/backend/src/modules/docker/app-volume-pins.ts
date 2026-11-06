import { createHash, randomUUID } from 'node:crypto';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';

const fail = () => new Error('Retained app volume bindings could not be verified.');
const maximum = 512 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
const serviceName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const volumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const urn = /^[a-z0-9][a-z0-9._-]{0,127}:(?:[a-z0-9][a-z0-9._-]{0,127}|_user)$/;
const reservedTarget = (target: string) => ['/proc', '/sys', '/dev'].some((reserved) => target === reserved || target.startsWith(`${reserved}/`));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type AppVolumePins = {
  version: 1;
  appUrn: string;
  project: string;
  services: { name: string; mounts: { target: string; volume: string; readOnly: boolean }[] }[];
};

function validate(value: unknown): AppVolumePins {
  if (
    !record(value) ||
    !keys(value, ['version', 'appUrn', 'project', 'services']) ||
    value.version !== 1 ||
    typeof value.appUrn !== 'string' ||
    !urn.test(value.appUrn) ||
    value.project !== value.appUrn.replace(':', '_') ||
    !Array.isArray(value.services) ||
    value.services.length < 1 ||
    value.services.length > 256
  )
    throw fail();
  let previous = '';
  let total = 0;
  for (const service of value.services) {
    if (
      !record(service) ||
      !keys(service, ['name', 'mounts']) ||
      typeof service.name !== 'string' ||
      !serviceName.test(service.name) ||
      compare(previous, service.name) >= 0 ||
      !Array.isArray(service.mounts) ||
      !service.mounts.length
    )
      throw fail();
    previous = service.name;
    let lastTarget = '';
    const targets = new Set<string>();
    for (const mount of service.mounts) {
      if (
        !record(mount) ||
        !keys(mount, ['target', 'volume', 'readOnly']) ||
        typeof mount.target !== 'string' ||
        Buffer.byteLength(mount.target) > 4096 ||
        !mount.target.startsWith('/') ||
        mount.target === '/' ||
        mount.target.endsWith('/') ||
        path.posix.normalize(mount.target) !== mount.target ||
        /[\\:$]/.test(mount.target) ||
        [...mount.target].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        reservedTarget(mount.target) ||
        compare(lastTarget, mount.target) >= 0 ||
        mount.target.split('/').some((_segment, index, parts) => index > 1 && targets.has(parts.slice(0, index).join('/'))) ||
        typeof mount.volume !== 'string' ||
        !volumeName.test(mount.volume) ||
        typeof mount.readOnly !== 'boolean' ||
        ++total > 4096
      )
        throw fail();
      lastTarget = mount.target;
      targets.add(mount.target);
    }
  }
  return value as AppVolumePins;
}

function render(pins: AppVolumePins) {
  const names = [...new Set(pins.services.flatMap((service) => service.mounts.map((mount) => mount.volume)))].sort(compare);
  const local = new Map(names.map((name) => [name, `orbis_retained_${createHash('sha256').update(name).digest('hex')}`]));
  return {
    'x-orbis-volume-pin': pins,
    services: Object.fromEntries(
      pins.services.map((service) => [
        service.name,
        {
          volumes: service.mounts.map((mount) => ({
            type: 'volume',
            source: local.get(mount.volume),
            target: mount.target,
            read_only: mount.readOnly,
            volume: { nocopy: true },
          })),
        },
      ]),
    ),
    volumes: Object.fromEntries(names.map((name) => [local.get(name), { external: true, name }])),
  };
}

export function encodeAppVolumePins(value: AppVolumePins): Buffer {
  const data = Buffer.from(JSON.stringify(render(validate(value))));
  if (data.length > maximum) throw fail();
  return data;
}

export function decodeAppVolumePins(bytes: Uint8Array): AppVolumePins {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maximum) throw fail();
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail();
  }
  if (!record(document)) throw fail();
  const pins = validate(document['x-orbis-volume-pin']);
  if (!Buffer.from(bytes).equals(encodeAppVolumePins(pins))) throw fail();
  return pins;
}

function location(directory: string, appUrn: string) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || !urn.test(appUrn)) throw fail();
  return path.join(directory, `${createHash('sha256').update(appUrn).digest('hex')}.json`);
}

async function directorySafe(directory: string, create: boolean) {
  const parents: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    parents.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of parents) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (current === directory && (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)))
      throw fail();
  }
  return true;
}

export async function readAppVolumePins(directory: string, identity: { appUrn: string; project: string }) {
  const file = location(directory, identity.appUrn);
  if (identity.project !== identity.appUrn.replace(':', '_')) throw fail();
  if (!(await directorySafe(directory, false))) return null;
  let handle: Awaited<ReturnType<typeof fs.open>>;
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
      [after, current].some((item) =>
        ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(item, key) !== Reflect.get(stat, key)),
      )
    )
      throw fail();
    const pins = decodeAppVolumePins(bytes.subarray(0, bytesRead));
    if (pins.appUrn !== identity.appUrn || pins.project !== identity.project) throw fail();
    return { pins, path: file, sha256: createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function writeAppVolumePins(directory: string, pins: AppVolumePins) {
  const data = encodeAppVolumePins(pins);
  const file = location(directory, pins.appUrn);
  await directorySafe(directory, true);
  await readAppVolumePins(directory, pins);
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
