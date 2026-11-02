import type Dockerode from 'dockerode';
import { afterEach, expect, it, vi } from 'vitest';
import * as config from '../host-updates/host-controller-config';
import { deriveRestoreStorageLayout } from './backup-restore-storage';
import { verifyRetainedWorkerIdentity } from './time-machine-retained-worker-identity';
const restoreId = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const workerId = 'a'.repeat(64);
const retainedSource = '/var/lib/orbis/retained/migrations';
const mount = (Destination: string, Source: string, RW = true) => ({ Type: 'bind', Destination, Source, RW, Propagation: 'rprivate' });
const original = {
  Id: 'b'.repeat(64),
  Image: `sha256:${'c'.repeat(64)}`,
  NetworkSettings: { Networks: { orbis: { NetworkID: 'd'.repeat(64) } } },
  State: { Running: true },
  Mounts: [
    mount('/data', '/srv/orbis/data'),
    mount('/app-data', '/srv/orbis/apps'),
    mount('/cache', '/srv/orbis/cache'),
    mount('/var/run/docker.sock', '/run/docker.sock', false),
    mount('/run/orbis', '/run/orbis-private', false),
  ],
} as unknown as Dockerode.ContainerInspectInfo;
function fixture() {
  const mounts = deriveRestoreStorageLayout(original.Mounts).workerMounts.map((item) => mount(item.Target, item.Source, !item.ReadOnly));
  mounts.push(mount('/run/orbis', '/run/orbis-private', false));
  mounts.push(mount(`/data/backups/restores/${restoreId}/retained`, retainedSource, false));
  mounts.push(mount(`/data/backups/restores/${restoreId}/source/payload`, '/var/lib/orbis/retained/source', false));
  const worker = {
    Id: workerId,
    Image: original.Image,
    Config: {
      User: '0',
      Entrypoint: ['node'],
      Cmd: ['-e', 'setInterval(()=>{},1000)'],
      Env: ['NODE_ENV=production', 'ORBIS_HOST_SOCKET=/run/orbis/host.sock', 'PATH=/usr/bin'],
      Labels: { 'io.orbis.restore': restoreId, 'io.orbis.restore.nonce': nonce, 'io.orbis.restore.role': 'worker' },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      AutoRemove: false,
      NetworkMode: 'orbis',
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no' },
    },
    Mounts: mounts,
    NetworkSettings: { Networks: { orbis: { NetworkID: 'd'.repeat(64), EndpointID: 'old', IPAddress: '10.0.0.1' } } },
    State: { Running: true, Restarting: false, Paused: false },
  } as unknown as Dockerode.ContainerInspectInfo;
  const rootSnapshot = {
    Id: worker.Id,
    Image: worker.Image,
    Config: worker.Config,
    HostConfig: worker.HostConfig,
    Mounts: worker.Mounts,
    NetworkSettings: { Networks: worker.NetworkSettings.Networks },
  };
  return {
    original,
    worker,
    rootSnapshot: structuredClone(rootSnapshot),
    restoreId,
    nonce,
    workerId,
    retainedSource,
    payloadSource: '/var/lib/orbis/retained/source',
    coordinatorImageEnv: ['PATH=/usr/bin'],
  };
}
afterEach(() => vi.restoreAllMocks());
it('validates current coordinator, root snapshot, exact mounts, labels and protected socket', async () => {
  const identity = vi.spyOn(config, 'controllerCaptureSocketIdentity').mockResolvedValue('protected-socket-inode');
  const input = fixture();
  await expect(verifyRetainedWorkerIdentity(input)).resolves.toBe('protected-socket-inode');
  expect(identity).toHaveBeenCalledWith('/run/orbis/host.sock');
  for (const kind of ['snapshot', 'image', 'command', 'labels', 'privileged', 'environment', 'socket', 'migration'] as const) {
    const changed = fixture();
    if (kind === 'snapshot') changed.rootSnapshot.Id = 'f'.repeat(64);
    if (kind === 'image') changed.worker.Image = `sha256:${'f'.repeat(64)}`;
    if (kind === 'command') changed.worker.Config.Cmd = ['/app/restore-worker.mjs', restoreId];
    if (kind === 'labels') changed.worker.Config.Labels['io.orbis.restore.nonce'] = 'wrong';
    if (kind === 'privileged') changed.worker.HostConfig.Privileged = true;
    if (kind === 'environment') changed.worker.Config.Env?.push('ATTACKER=true');
    const socket = changed.worker.Mounts.find((entry) => entry.Destination === '/run/orbis');
    const migration = changed.worker.Mounts.find((entry) => entry.Destination.endsWith('/retained'));
    if (!socket || !migration) throw new Error('Missing fixture mount');
    if (kind === 'socket') socket.RW = true;
    if (kind === 'migration') migration.Source = '/attacker';
    const worker = changed.worker;
    // The root snapshot is untrusted by itself: changes must also satisfy independent role and mount policy.
    if (kind !== 'snapshot')
      changed.rootSnapshot = {
        Id: worker.Id,
        Image: worker.Image,
        Config: worker.Config,
        HostConfig: worker.HostConfig,
        Mounts: worker.Mounts,
        NetworkSettings: { Networks: worker.NetworkSettings.Networks },
      };
    await expect(verifyRetainedWorkerIdentity(changed), kind).rejects.toThrow();
  }
});

it('allows only volatile worker endpoint changes after restart while retaining pinned network identity', async () => {
  vi.spyOn(config, 'controllerCaptureSocketIdentity').mockResolvedValue('protected-socket-inode');
  const input = fixture();
  const network = input.worker.NetworkSettings.Networks.orbis;
  if (!network) throw new Error('Missing fixture network');
  network.EndpointID = 'new';
  network.IPAddress = '10.0.0.2';
  await expect(verifyRetainedWorkerIdentity(input)).resolves.toBe('protected-socket-inode');
  network.NetworkID = 'f'.repeat(64);
  await expect(verifyRetainedWorkerIdentity(input)).rejects.toThrow();
  network.NetworkID = 'd'.repeat(64);
  network.Aliases = ['unexpected'];
  await expect(verifyRetainedWorkerIdentity(input)).rejects.toThrow();
});

it('accepts reordered exact mount objects while rejecting duplicate destinations and changed fields', async () => {
  vi.spyOn(config, 'controllerCaptureSocketIdentity').mockResolvedValue('protected-socket-inode');
  const input = fixture();
  input.worker.Mounts.reverse();
  await expect(verifyRetainedWorkerIdentity(input)).resolves.toBe('protected-socket-inode');
  const duplicate = fixture();
  const first = duplicate.worker.Mounts[0];
  if (!first) throw new Error('Missing fixture mount');
  duplicate.worker.Mounts.push({ ...first });
  await expect(verifyRetainedWorkerIdentity(duplicate)).rejects.toThrow();
  const changed = fixture();
  const mount = changed.worker.Mounts[0];
  if (!mount) throw new Error('Missing fixture mount');
  mount.Propagation = 'shared';
  await expect(verifyRetainedWorkerIdentity(changed)).rejects.toThrow();
});
