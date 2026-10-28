import { describe, expect, it } from 'vitest';
import { deriveRestoreStorageLayout, verifyRestoreStorageMounts, type RestoreStorageMount } from './backup-restore-storage';

const mount = (Destination: string, Source: string, RW = true): RestoreStorageMount => ({
  Type: 'bind',
  Source,
  Destination,
  RW,
  Propagation: 'rprivate',
});
const consolidated = () => [
  mount('/data', '/srv/orbis/data'),
  mount('/app-data', '/srv/orbis/app-data'),
  mount('/cache', '/srv/orbis/cache'),
  mount('/var/run/docker.sock', '/run/docker.sock', false),
];
const production = () => [
  ...['media', 'state', 'repos', 'apps', 'logs', 'traefik', 'user-config', 'backups'].map((name) =>
    mount(`/data/${name}`, `/srv/orbis/.internal/${name}`),
  ),
  mount('/app-data', '/srv/orbis/.internal/app-data'),
  mount('/data/.env', '/srv/orbis/.env'),
  mount('/cache', '/srv/orbis/.internal/cache'),
  mount('/var/run/docker.sock', '/var/run/docker.sock', false),
  mount('/host/proc/meminfo', '/proc/meminfo', false),
  mount('/host/proc/stat', '/proc/stat', false),
  mount('/host/proc/uptime', '/proc/uptime', false),
  mount('/data/docker-compose.yml', '/srv/orbis/docker-compose.prod.yml'),
  mount('/etc/localtime', '/etc/localtime', false),
  mount('/etc/timezone', '/etc/timezone', false),
];
function target(mounts: RestoreStorageMount[], name: string) {
  const found = mounts.find((item) => item.Destination === name);
  if (!found) throw new Error('Missing synthetic fixture mount');
  return found;
}

const storageDestinations = new Set([
  '/data/media',
  '/data/state',
  '/data/repos',
  '/data/apps',
  '/data/logs',
  '/data/traefik',
  '/data/user-config',
  '/data/backups',
  '/data/.env',
  '/app-data',
  '/cache',
]);
function productionInspection(role: 'worker' | 'verifier') {
  return production()
    .filter((item) => storageDestinations.has(item.Destination) || (role === 'worker' && item.Destination === '/var/run/docker.sock'))
    .map((item) => ({ ...item, RW: role === 'worker' ? item.RW : ['/cache', '/data/logs'].includes(item.Destination) }));
}

it.each(['worker', 'verifier'] as const)('verifies an actual %s inspection using production child binds', (role) => {
  expect(() => verifyRestoreStorageMounts(production(), productionInspection(role), role)).not.toThrow();
  expect(() => verifyRestoreStorageMounts(production(), [...productionInspection(role)].reverse(), role)).not.toThrow();
});

it.each(['worker', 'verifier'] as const)('rejects extra host access and altered source identity in the %s', (role) => {
  const extra = productionInspection(role);
  extra.push(mount('/private-host', '/srv/private', false));
  expect(() => verifyRestoreStorageMounts(production(), extra, role)).toThrow();
  const wrongSource = productionInspection(role);
  target(wrongSource, '/data/state').Source = '/srv/another-server/state';
  expect(() => verifyRestoreStorageMounts(production(), wrongSource, role)).toThrow();
  const duplicate = productionInspection(role);
  target(duplicate, '/data/apps').Destination = '/data/state';
  expect(() => verifyRestoreStorageMounts(production(), duplicate, role)).toThrow();
  expect(() => verifyRestoreStorageMounts(production(), productionInspection(role).slice(1), role)).toThrow();
});

it('keeps every restored tree and the database environment read-only in the verifier', () => {
  for (const destination of ['/data/state', '/data/apps', '/app-data', '/data/.env', '/data/backups']) {
    const changed = productionInspection('verifier');
    target(changed, destination).RW = true;
    expect(() => verifyRestoreStorageMounts(production(), changed, 'verifier')).toThrow();
  }
  const withSocket = productionInspection('verifier');
  withSocket.push(mount('/var/run/docker.sock', '/var/run/docker.sock', false));
  expect(() => verifyRestoreStorageMounts(production(), withSocket, 'verifier')).toThrow();
});

it('requires writable worker roots and exactly the original socket access', () => {
  for (const destination of ['/data/state', '/app-data', '/data/.env']) {
    const changed = productionInspection('worker');
    target(changed, destination).RW = false;
    expect(() => verifyRestoreStorageMounts(production(), changed, 'worker')).toThrow();
  }
  const socket = productionInspection('worker');
  target(socket, '/var/run/docker.sock').RW = true;
  expect(() => verifyRestoreStorageMounts(production(), socket, 'worker')).toThrow();
});

it('does not accept a parent mount in place of independently bound production trees', () => {
  expect(() => verifyRestoreStorageMounts(production(), consolidated(), 'worker')).toThrow();
  expect(() => verifyRestoreStorageMounts(production(), consolidated(), 'verifier')).toThrow();
});

it('derives consolidated storage and retains the existing four-mount verifier contract', () => {
  const original = consolidated();
  const result = deriveRestoreStorageLayout(original);
  expect(result.roots).toEqual({
    state: '/srv/orbis/data/state',
    apps: '/srv/orbis/data/apps',
    repos: '/srv/orbis/data/repos',
    media: '/srv/orbis/data/media',
    'user-config': '/srv/orbis/data/user-config',
    traefik: '/srv/orbis/data/traefik',
    'app-data': '/srv/orbis/app-data',
  });
  expect({ backups: result.backups, logs: result.logs, environment: result.environment, cache: result.cache }).toEqual({
    backups: '/srv/orbis/data/backups',
    logs: '/srv/orbis/data/logs',
    environment: '/srv/orbis/data/.env',
    cache: '/srv/orbis/cache',
  });
  expect(result.workerMounts).toHaveLength(4);
  expect(result.verifierMounts.map(({ Target, Source, ReadOnly }) => ({ Target, Source, ReadOnly }))).toEqual([
    { Target: '/app-data', Source: '/srv/orbis/app-data', ReadOnly: true },
    { Target: '/cache', Source: '/srv/orbis/cache', ReadOnly: false },
    { Target: '/data', Source: '/srv/orbis/data', ReadOnly: true },
    { Target: '/data/logs', Source: '/srv/orbis/data/logs', ReadOnly: false },
  ]);
  expect(result.workerMounts.find((item) => item.Target === '/var/run/docker.sock')).toMatchObject({ Source: '/run/docker.sock', ReadOnly: true });
  expect(result.verifierMounts.some((item) => item.Target.includes('docker.sock'))).toBe(false);
});

it('supports the standard production Compose mounts without a host-parent bind or unrelated host files', () => {
  const original = production();
  const result = deriveRestoreStorageLayout(original);
  expect(result.workerMounts).toHaveLength(12);
  expect(result.verifierMounts).toHaveLength(11);
  expect(result.environment).toBe('/srv/orbis/.env');
  expect(result.backups).toBe('/srv/orbis/.internal/backups');
  expect(result.roots.state).toBe('/srv/orbis/.internal/state');
  expect(result.roots['app-data']).toBe('/srv/orbis/.internal/app-data');
  for (const derived of result.workerMounts) {
    expect(original.some((item) => item.Destination === derived.Target && item.Source === derived.Source && item.RW === !derived.ReadOnly)).toBe(
      true,
    );
    expect(derived.BindOptions.Propagation).toBe('rprivate');
  }
  expect(result.workerMounts.some((item) => ['/data', '/srv/orbis', '/srv/orbis/.internal'].includes(item.Source) || item.Target === '/data')).toBe(
    false,
  );
  expect(
    result.workerMounts.some(
      (item) => item.Target.startsWith('/host/') || item.Target === '/etc/localtime' || item.Target.endsWith('docker-compose.yml'),
    ),
  ).toBe(false);
  expect(result.verifierMounts.filter((item) => !item.ReadOnly).map((item) => item.Target)).toEqual(['/cache', '/data/logs']);
});

it('resolves and preserves the most-specific original shadows for state, media, backups, logs and environment', () => {
  const original = [
    ...consolidated(),
    mount('/data/state', '/custom/state'),
    mount('/data/media', '/custom/media'),
    mount('/data/backups', '/custom/backups'),
    mount('/data/logs', '/custom/logs'),
    mount('/data/.env', '/custom/config.env'),
  ];
  const result = deriveRestoreStorageLayout(original);
  expect(result.roots.state).toBe('/custom/state');
  expect(result.roots.media).toBe('/custom/media');
  expect(result.roots.apps).toBe('/srv/orbis/data/apps');
  expect(result.backups).toBe('/custom/backups');
  expect(result.logs).toBe('/custom/logs');
  expect(result.environment).toBe('/custom/config.env');
  for (const name of ['/data/state', '/data/media', '/data/backups', '/data/logs', '/data/.env']) {
    expect(result.workerMounts.find((item) => item.Target === name)?.Source).toBe(target(original, name).Source);
    expect(result.verifierMounts.find((item) => item.Target === name)?.Source).toBe(target(original, name).Source);
  }
  expect(result.verifierMounts.filter((item) => item.Target === '/data/logs')).toHaveLength(1);
  expect(result.verifierMounts.find((item) => item.Target === '/data')?.ReadOnly).toBe(true);
  expect(result.verifierMounts.find((item) => item.Target === '/data/logs')?.ReadOnly).toBe(false);
});

it('omits an unused parent /data bind when every essential child already has an exact bind', () => {
  const original = [...production(), mount('/data', '/unneeded/parent', false), mount('/data/private', '/unneeded/private', false)];
  const result = deriveRestoreStorageLayout(original);
  expect(result.workerMounts.some((item) => item.Target === '/data' || item.Target === '/data/private')).toBe(false);
  expect(result.verifierMounts.some((item) => item.Target === '/data' || item.Target === '/data/private')).toBe(false);
});

it('does not mutate frozen inputs or share output mount records with the original or other role', () => {
  const original = Object.freeze(consolidated().map((item) => Object.freeze(item)));
  const result = deriveRestoreStorageLayout(original);
  const worker = result.workerMounts.find((item) => item.Target === '/data');
  if (!worker) throw new Error('Missing derived synthetic mount');
  worker.Source = '/changed';
  worker.BindOptions.Propagation = 'rprivate';
  expect(original.find((item) => item.Destination === '/data')?.Source).toBe('/srv/orbis/data');
  expect(result.verifierMounts.find((item) => item.Target === '/data')?.Source).toBe('/srv/orbis/data');
  expect(result.roots.state).toBe('/srv/orbis/data/state');
});

it('is order-independent and accepts spaces and Unicode as literal structured mount paths', () => {
  const original = production();
  target(original, '/data/media').Source = '/srv/共享 media';
  expect(deriveRestoreStorageLayout([...original].reverse())).toEqual(deriveRestoreStorageLayout(original));
  expect(deriveRestoreStorageLayout(original).roots.media).toBe('/srv/共享 media');
});

it('keeps the socket optional without deriving access to a socket parent', () => {
  const original = consolidated().filter((item) => item.Destination !== '/var/run/docker.sock');
  original.push(mount('/var/run', '/run'));
  const result = deriveRestoreStorageLayout(original);
  expect(result.workerMounts).toHaveLength(3);
  expect(result.workerMounts.some((item) => item.Target.startsWith('/var/run'))).toBe(false);
});

describe('unsupported layouts', () => {
  it.each([
    '/data/state',
    '/data/apps',
    '/data/repos',
    '/data/media',
    '/data/user-config',
    '/data/traefik',
    '/app-data',
    '/data/backups',
    '/data/logs',
    '/data/.env',
    '/cache',
  ])('rejects missing essential storage %s', (destination) => {
    expect(() => deriveRestoreStorageLayout(production().filter((item) => item.Destination !== destination))).toThrow(
      'supported writable bind storage',
    );
  });
  it.each(['/data/state', '/data/.env', '/data/backups', '/data/logs', '/cache', '/app-data'])(
    'rejects readonly essential storage %s',
    (destination) => {
      const original = production();
      target(original, destination).RW = false;
      expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
    },
  );
  it.each(['volume', 'tmpfs', 'image', 'npipe'])('rejects a most-specific %s shadow even when its parent is a valid writable bind', (Type) => {
    const original = [...consolidated(), { ...mount('/data/state', '/var/lib/synthetic-volume'), Type }];
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it.each(['state', 'app-data', 'cache', 'backups', 'logs', 'environment', 'parent'])('rejects overlapping source paths involving %s', (name) => {
    const original = production();
    const aliases: Record<string, string> = {
      state: '/srv/orbis/.internal/apps',
      'app-data': '/srv/orbis/.internal/app-data',
      cache: '/srv/orbis/.internal/cache/child',
      backups: '/srv/orbis/.internal/backups',
      logs: '/srv/orbis/.internal/logs',
      environment: '/srv/orbis/.env/child',
      parent: '/srv/orbis/.internal',
    };
    target(original, '/data/state').Source = aliases[name] ?? '';
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it('rejects overlapping auxiliary storage too', () => {
    const original = production();
    target(original, '/cache').Source = '/srv/orbis/.internal/backups/cache';
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it.each(['/data/state/nested', '/data/apps/catalogue', '/app-data/application', '/app-data/application/deeper'])(
    'rejects a nested mount %s that would block swapping children',
    (destination) => {
      expect(() => deriveRestoreStorageLayout([...consolidated(), mount(destination, '/independent/nested', false)])).toThrow(
        'supported writable bind storage',
      );
    },
  );
  it.each(['bind', 'volume', 'tmpfs'])('rejects an unselected %s shadow below retained /data instead of exposing its hidden underlay', (Type) => {
    expect(() => deriveRestoreStorageLayout([...consolidated(), { ...mount('/data/private', '/private/hidden'), Type }])).toThrow(
      'supported writable bind storage',
    );
  });
  it('rejects duplicate destinations including unrelated mounts', () => {
    expect(() => deriveRestoreStorageLayout([...production(), mount('/host/proc/stat', '/other/stat')])).toThrow('supported writable bind storage');
  });
  it.each([
    'relative',
    '/',
    '/srv/../state',
    '/srv/./state',
    '/srv//state',
    '/srv/state/',
    '//srv/state',
    '/srv/state\0suffix',
    '/srv/state\nnext',
    '/srv/\\state',
    '/srv/\ud800',
    `/${'x'.repeat(4096)}`,
  ])('rejects noncanonical or unsafe source case %#', (Source) => {
    const original = production();
    target(original, '/data/state').Source = Source;
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it.each(['relative', '/', '/data/../state', '/data//state', '/data/state/', '/data/\0state', '/data/\ud800'])(
    'rejects noncanonical or unsafe destination case %#',
    (Destination) => {
      expect(() => deriveRestoreStorageLayout([...production(), mount(Destination, '/synthetic/extra')])).toThrow('supported writable bind storage');
    },
  );
  it.each(['shared', 'rshared', 'slave', 'rslave', 'unexpected'])('rejects unsafe bind propagation %s', (Propagation) => {
    const original = production();
    target(original, '/data/state').Propagation = Propagation;
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it('rejects a non-bind socket instead of granting another socket or its parent', () => {
    const original = production();
    target(original, '/var/run/docker.sock').Type = 'volume';
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it('rejects socket storage aliasing a restored tree', () => {
    const original = production();
    target(original, '/var/run/docker.sock').Source = '/srv/orbis/.internal/state/docker.sock';
    expect(() => deriveRestoreStorageLayout(original)).toThrow('supported writable bind storage');
  });
  it('returns a generic diagnostic without host paths', () => {
    const original = production();
    target(original, '/data/state').Source = '/private/synthetic/../value';
    try {
      deriveRestoreStorageLayout(original);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('/private');
    }
  });
});
