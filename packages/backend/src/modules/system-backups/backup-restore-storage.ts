import path from 'node:path';
import { BackupRequirementError } from './backup-files';
import type { RestoreTreeName } from './backup-restore-materialize';

export type RestoreStorageMount = {
  Type: string;
  Source: string;
  Destination: string;
  RW: boolean;
  Propagation?: string;
};
export type RestoreStorageBind = {
  Type: 'bind';
  Source: string;
  Target: string;
  ReadOnly: boolean;
  BindOptions: { Propagation: 'rprivate' };
};
export type RestoreStorageLayout = {
  roots: Record<RestoreTreeName, string>;
  backups: string;
  logs: string;
  environment: string;
  cache: string;
  workerMounts: RestoreStorageBind[];
  verifierMounts: RestoreStorageBind[];
};

const rootDestinations: Record<RestoreTreeName, string> = {
  state: '/data/state',
  apps: '/data/apps',
  repos: '/data/repos',
  media: '/data/media',
  'user-config': '/data/user-config',
  traefik: '/data/traefik',
  'app-data': '/app-data',
};
const auxiliaryDestinations = { backups: '/data/backups', logs: '/data/logs', environment: '/data/.env', cache: '/cache' } as const;
const socketDestination = '/var/run/docker.sock';
const inside = (root: string, target: string) => target === root || target.startsWith(`${root}/`);
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const failed = () => new BackupRequirementError('Full restore requires supported writable bind storage. No server data has been changed.');

function canonical(value: string) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value !== '/' &&
    !value.endsWith('/') &&
    Buffer.byteLength(value) <= 4096 &&
    !value.includes('\\') &&
    !/\p{Surrogate}/u.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    path.posix.normalize(value) === value
  );
}
function bind(mount: RestoreStorageMount) {
  if (
    mount.Type !== 'bind' ||
    !canonical(mount.Source) ||
    typeof mount.RW !== 'boolean' ||
    (mount.Propagation !== undefined && !['', 'private', 'rprivate'].includes(mount.Propagation))
  )
    throw failed();
  return mount;
}
function mountOrder(a: RestoreStorageBind, b: RestoreStorageBind) {
  return a.Target.split('/').length - b.Target.split('/').length || (a.Target < b.Target ? -1 : a.Target > b.Target ? 1 : 0);
}
function specification(mount: RestoreStorageMount, readOnly = !mount.RW): RestoreStorageBind {
  return { Type: 'bind', Source: mount.Source, Target: mount.Destination, ReadOnly: readOnly, BindOptions: { Propagation: 'rprivate' } };
}

export function deriveRestoreStorageLayout(original: readonly RestoreStorageMount[]): RestoreStorageLayout {
  if (!Array.isArray(original) || original.length > 1024) throw failed();
  const destinations = new Set<string>();
  for (const mount of original) {
    if (!mount || !canonical(mount.Destination) || destinations.has(mount.Destination)) throw failed();
    destinations.add(mount.Destination);
    if (mount.Type === 'bind') bind(mount);
  }
  for (const root of Object.values(rootDestinations)) {
    if (original.some((mount) => mount.Destination !== root && inside(root, mount.Destination))) throw failed();
  }
  const selected = new Map<string, RestoreStorageMount>();
  const resolve = (destination: string) => {
    const covering = original
      .filter((mount) => inside(mount.Destination, destination))
      .sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!covering || !covering.RW) throw failed();
    bind(covering);
    selected.set(covering.Destination, covering);
    const suffix = path.posix.relative(covering.Destination, destination);
    const source = path.posix.join(covering.Source, suffix);
    if (!canonical(source)) throw failed();
    return source;
  };
  const roots = Object.fromEntries(Object.entries(rootDestinations).map(([name, destination]) => [name, resolve(destination)])) as Record<
    RestoreTreeName,
    string
  >;
  const auxiliary = Object.fromEntries(Object.entries(auxiliaryDestinations).map(([name, destination]) => [name, resolve(destination)])) as Pick<
    RestoreStorageLayout,
    keyof typeof auxiliaryDestinations
  >;
  const sources = [...Object.values(roots), ...Object.values(auxiliary)];
  if (sources.some((source, index) => sources.some((other, position) => position !== index && overlap(source, other)))) throw failed();
  // Omitting a shadow below a retained parent would expose host contents hidden in the original container.
  if (
    original.some(
      (mount) => !selected.has(mount.Destination) && [...selected.values()].some((parent) => inside(parent.Destination, mount.Destination)),
    )
  )
    throw failed();
  const socket = original.find((mount) => mount.Destination === socketDestination);
  if (socket) {
    bind(socket);
    if (sources.some((source) => overlap(source, socket.Source))) throw failed();
  }
  const workerMounts = [...selected.values(), ...(socket ? [socket] : [])].map((mount) => specification(mount)).sort(mountOrder);
  const verifierMounts = [...selected.values()].map((mount) => specification(mount, !['/cache', '/data/logs'].includes(mount.Destination)));
  if (!verifierMounts.some((mount) => mount.Target === '/data/logs'))
    verifierMounts.push({
      Type: 'bind',
      Source: auxiliary.logs,
      Target: '/data/logs',
      ReadOnly: false,
      BindOptions: { Propagation: 'rprivate' },
    });
  return { roots, ...auxiliary, workerMounts, verifierMounts: verifierMounts.sort(mountOrder) };
}

export function verifyRestoreStorageMounts(
  original: readonly RestoreStorageMount[],
  actual: readonly RestoreStorageMount[],
  role: 'worker' | 'verifier',
) {
  if (!['worker', 'verifier'].includes(role) || !Array.isArray(actual)) throw failed();
  const layout = deriveRestoreStorageLayout(original);
  const expected = role === 'worker' ? layout.workerMounts : layout.verifierMounts;
  if (
    actual.length !== expected.length ||
    actual.some((mount) => !mount || !canonical(mount.Destination)) ||
    new Set(actual.map((mount) => mount.Destination)).size !== actual.length
  )
    throw failed();
  for (const mount of actual) {
    bind(mount);
    const selected = expected.find((item) => item.Target === mount.Destination);
    if (!selected || mount.Source !== selected.Source || mount.RW !== !selected.ReadOnly) throw failed();
  }
}
