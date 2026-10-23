import { fromAny } from '@total-typescript/shoehorn';
import { expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { ClusterService } from './cluster.service';

type Dependencies = ConstructorParameters<typeof ClusterService>;

it('keeps paired app library fields while excluding private saved configuration', async () => {
  const state = mock<Dependencies[0]>();
  const config = mock<Dependencies[1]>();
  const apps = mock<Dependencies[2]>();
  state.read.mockResolvedValue(fromAny({ id: 'local-server' }));
  config.get.mockReturnValue(fromAny({ localDomain: 'peer.local', sslPort: 443 }));
  apps.getInstalledApps.mockResolvedValue([
    {
      app: createMockApp({ createdAt: 1_790_000_000, config: { PASSWORD: 'saved-private-value' } }),
      info: createMockAppInfo({ categories: ['utilities'] }),
      metadata: { latestVersion: 1, latestDockerVersion: '1.0.0', localSubdomain: 'paired-app' },
    },
  ]);
  const service = new ClusterService(
    state,
    config,
    apps,
    mock<Dependencies[3]>(),
    mock<Dependencies[4]>(),
    mock<Dependencies[5]>(),
    mock<Dependencies[6]>(),
    mock<Dependencies[7]>(),
    mock<Dependencies[8]>(),
    mock<Dependencies[9]>(),
    mock<Dependencies[10]>(),
    mock<Dependencies[11]>(),
    mock<Dependencies[12]>(),
    mock<Dependencies[13]>(),
    mock<Dependencies[14]>(),
    mock<Dependencies[15]>(),
    mock<Dependencies[16]>(),
  );

  const result = await service.read('local-server', 'apps');

  expect(result).toMatchObject({
    installed: [{ app: { createdAt: 1_790_000_000 }, info: { categories: ['utilities'] } }],
    addresses: { localDomain: 'peer.local', sslPort: 443 },
  });
  expect(result).not.toHaveProperty('installed.0.app.config');
  expect(JSON.stringify(result)).not.toContain('saved-private-value');
});

const peerFixture = () => {
  const state = mock<Dependencies[0]>();
  const activity = mock<Dependencies[16]>();
  const service = new ClusterService(
    state,
    mock<Dependencies[1]>(),
    mock<Dependencies[2]>(),
    mock<Dependencies[3]>(),
    mock<Dependencies[4]>(),
    mock<Dependencies[5]>(),
    mock<Dependencies[6]>(),
    mock<Dependencies[7]>(),
    mock<Dependencies[8]>(),
    mock<Dependencies[9]>(),
    mock<Dependencies[10]>(),
    mock<Dependencies[11]>(),
    mock<Dependencies[12]>(),
    mock<Dependencies[13]>(),
    mock<Dependencies[14]>(),
    mock<Dependencies[15]>(),
    activity,
  );
  return { state, activity, service };
};

it('renews remote sampling only after peer authentication and valid monitoring parameters', async () => {
  const { state, activity, service } = peerFixture();
  state.authorize.mockRejectedValueOnce(new Error('Invalid signature'));
  await expect(service.peer({}, { action: 'read', resource: 'telemetry' })).rejects.toThrow('Invalid signature');
  expect(activity.touchPeer).not.toHaveBeenCalled();
  state.authorize.mockResolvedValue(true);
  for (const body of [
    { action: 'read', resource: 'unknown' },
    { action: 'read', resource: 'history', params: { range: 'forever' } },
    { action: 'read', resource: 'host-history', params: { device: 'disk:../../etc/shadow' } },
    { action: 'read', resource: 'telemetry', params: [] },
  ]) {
    await expect(service.peer({}, body)).rejects.toThrow();
  }
  expect(activity.touchPeer).not.toHaveBeenCalled();
  await service.peer({}, { action: 'read', resource: 'telemetry' });
  expect(activity.touchPeer).toHaveBeenCalledOnce();
  await service.peer({}, { action: 'read', resource: 'host-history', params: { range: '5m', device: 'network:eth0' } });
  expect(activity.touchPeer).toHaveBeenCalledTimes(2);
});

it('does not keep collectors alive for release checks or local reads with their own browser stream', async () => {
  const { state, activity, service } = peerFixture();
  state.read.mockResolvedValue(fromAny({ id: 'local-server' }));
  await service.read('local-server', 'telemetry');
  await service.peer({}, { action: 'read', resource: 'build' });
  expect(activity.touchPeer).not.toHaveBeenCalled();
});
