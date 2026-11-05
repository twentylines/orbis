import { expect, it } from 'vitest';
import { deriveRestoreStorageLayout, verifyRetainedRestoreWorkerMounts, type RestoreStorageMount } from './backup-restore-storage';
const id = '11111111-1111-4111-8111-111111111111';
const mount = (Destination: string, Source: string, RW = true): RestoreStorageMount => ({
  Type: 'bind',
  Destination,
  Source,
  RW,
  Propagation: 'rprivate',
});
const original = () => [
  mount('/data', '/srv/orbis/data'),
  mount('/app-data', '/srv/orbis/apps'),
  mount('/cache', '/srv/orbis/cache'),
  mount('/var/run/docker.sock', '/run/docker.sock', false),
  mount('/run/orbis', '/run/orbis-private', false),
];
function fixture() {
  const source = original();
  const actual = deriveRestoreStorageLayout(source).workerMounts.map((item) => mount(item.Target, item.Source, !item.ReadOnly));
  actual.push(mount('/run/orbis', '/run/orbis-private', false));
  actual.push(mount(`/data/backups/restores/${id}/retained`, '/var/lib/orbis/verified-migrations', false));
  actual.push(mount(`/data/backups/restores/${id}/source/payload`, '/var/lib/orbis/verified-source', false));
  return { source, actual };
}
it('accepts only the original protected socket and root-bound migration shadow in the retained worker', () => {
  const { source, actual } = fixture();
  expect(() =>
    verifyRetainedRestoreWorkerMounts(source, actual, id, '/var/lib/orbis/verified-migrations', '/var/lib/orbis/verified-source'),
  ).not.toThrow();
  for (const kind of [
    'socket-source',
    'socket-write',
    'migration-source',
    'migration-write',
    'source-write',
    'source-path',
    'extra',
    'missing',
  ] as const) {
    const changed = structuredClone(actual);
    const socket = changed.find((item) => item.Destination === '/run/orbis');
    const migrations = changed.find((item) => item.Destination.endsWith('/retained'));
    const payload = changed.find((item) => item.Destination.endsWith('/source/payload'));
    if (!socket || !migrations || !payload) throw new Error('Missing fixture mounts');
    if (kind === 'socket-source') socket.Source = '/attacker/socket';
    if (kind === 'socket-write') socket.RW = true;
    if (kind === 'migration-source') migrations.Source = '/attacker/migrations';
    if (kind === 'migration-write') migrations.RW = true;
    if (kind === 'source-write') payload.RW = true;
    if (kind === 'source-path') payload.Source = '/attacker/source';
    if (kind === 'extra') changed.push(mount('/private', '/private'));
    if (kind === 'missing') changed.pop();
    expect(
      () => verifyRetainedRestoreWorkerMounts(source, changed, id, '/var/lib/orbis/verified-migrations', '/var/lib/orbis/verified-source'),
      kind,
    ).toThrow();
  }
});
it('binds a preserved read-only proxy to the same source and permissions in the retained worker', () => {
  const source = original();
  source.push(mount('/data/traefik', '/protected/proxy', false));
  const actual = deriveRestoreStorageLayout(source, true).workerMounts.map((item) => mount(item.Target, item.Source, !item.ReadOnly));
  actual.push(mount('/run/orbis', '/run/orbis-private', false));
  actual.push(mount(`/data/backups/restores/${id}/retained`, '/var/lib/orbis/verified-migrations', false));
  actual.push(mount(`/data/backups/restores/${id}/source/payload`, '/var/lib/orbis/verified-source', false));
  const verify = (preserve: boolean) =>
    verifyRetainedRestoreWorkerMounts(source, actual, id, '/var/lib/orbis/verified-migrations', '/var/lib/orbis/verified-source', preserve);
  expect(() => verify(false)).toThrow();
  expect(() => verify(true)).not.toThrow();
  const proxy = actual.find((item) => item.Destination === '/data/traefik');
  if (!proxy) throw new Error('Missing proxy fixture');
  proxy.RW = true;
  expect(() => verify(true)).toThrow();
});
