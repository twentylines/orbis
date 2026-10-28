import type Dockerode from 'dockerode';
import { expect, it } from 'vitest';
import { restoreAuxiliaryContainerPlans } from './backup-restore-containers';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture() {
  return {
    Id: '1'.repeat(64),
    Image: `sha256:${'2'.repeat(64)}`,
    Config: {
      User: '',
      Env: [
        'NODE_ENV=production',
        'HOSTNAME=previous-host',
        'DOCKER_HOST=tcp://previous-host:2376',
        'ORBIS_INSTALLER_PHASE=hold',
        'ORBIS_INSTALLER_TRANSACTION=previous',
      ],
      Labels: { 'traefik.enable': 'true', 'com.docker.compose.service': 'runtipi' },
    },
    HostConfig: { NetworkMode: 'orbis_private', Memory: 512 * 1024 * 1024, PidsLimit: 128 },
    NetworkSettings: { Networks: { orbis_private: { Aliases: ['runtipi', 'old-controller'], IPAddress: '192.0.2.9' } } },
    State: { Running: true, Restarting: false, Paused: false },
    Mounts: [
      { Type: 'bind', Source: '/srv/data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/app-data', Destination: '/app-data', RW: true },
      { Type: 'bind', Source: '/srv/cache', Destination: '/cache', RW: true },
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false },
      { Type: 'bind', Source: '/proc/stat', Destination: '/host/proc/stat', RW: false },
    ],
  };
}
type Fixture = ReturnType<typeof fixture>;
const plans = (original: Fixture) => restoreAuxiliaryContainerPlans(original as unknown as Dockerode.ContainerInspectInfo, id, nonce);

it('creates verifier and worker plans without copying the controller identity, routing or ports', () => {
  const original = fixture();
  const before = structuredClone(original);
  const { verifier, worker } = plans(original);
  expect(original).toEqual(before);
  for (const plan of [verifier, worker]) {
    expect(plan.Image).toBe(original.Image);
    expect(plan.Hostname).toBeUndefined();
    expect(plan.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      Privileged: false,
      PortBindings: {},
      PublishAllPorts: false,
      CapDrop: ['ALL'],
      Memory: original.HostConfig.Memory,
      PidsLimit: 128,
    });
    expect(plan.NetworkingConfig).toEqual({ EndpointsConfig: { orbis_private: {} } });
    expect(plan.Labels).toMatchObject({ 'io.orbis.restore': id, 'io.orbis.restore.nonce': nonce, 'traefik.enable': 'false' });
    expect(plan.Labels?.['com.docker.compose.service']).toBeUndefined();
    expect(plan.HostConfig?.Devices).toBeUndefined();
    expect(plan.HostConfig?.PidMode).toBeUndefined();
    expect(plan.HostConfig?.Binds).toBeUndefined();
  }
  expect(verifier.Env).toEqual(['NODE_ENV=production', `ORBIS_INSTALLER_TRANSACTION=${id}`, 'ORBIS_INSTALLER_PHASE=hold']);
  expect(worker.Env).toEqual(['NODE_ENV=production']);
  expect(worker.HostConfig?.CapAdd).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
  expect(verifier.HostConfig?.CapAdd).toBeUndefined();
  expect(verifier.HostConfig?.Mounts?.some((mount) => mount.Target === '/var/run/docker.sock')).toBe(false);
  expect(worker.HostConfig?.Mounts?.some((mount) => mount.Target === '/var/run/docker.sock')).toBe(true);
  expect(worker.Cmd).toEqual(['/app/restore-worker.mjs', id]);
  expect(verifier.Cmd).toEqual(['/app/main.mjs']);
});

it.each([
  [
    'paused',
    (value: Fixture) => {
      value.State.Paused = true;
    },
  ],
  [
    'restarting',
    (value: Fixture) => {
      value.State.Restarting = true;
    },
  ],
  [
    'stopped',
    (value: Fixture) => {
      value.State.Running = false;
    },
  ],
  [
    'non-root',
    (value: Fixture) => {
      value.Config.User = '1000';
    },
  ],
  [
    'host network',
    (value: Fixture) => {
      value.HostConfig.NetworkMode = 'host';
    },
  ],
  [
    'container network',
    (value: Fixture) => {
      value.HostConfig.NetworkMode = `container:${'3'.repeat(64)}`;
    },
  ],
  [
    'missing socket',
    (value: Fixture) => {
      value.Mounts = value.Mounts.filter((mount) => mount.Destination !== '/var/run/docker.sock');
    },
  ],
] as const)('rejects an unsupported %s controller before creating anything', (_, change) => {
  const original = fixture();
  change(original);
  expect(() => plans(original)).toThrow('No server data has been changed');
});

it('does not grant a worker capabilities that were removed from the controller', () => {
  const original = fixture() as unknown as Dockerode.ContainerInspectInfo;
  original.HostConfig.CapDrop = ['ALL'];
  expect(() => restoreAuxiliaryContainerPlans(original, id, nonce)).toThrow();
  original.HostConfig.CapAdd = ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER'];
  expect(() => restoreAuxiliaryContainerPlans(original, id, nonce)).not.toThrow();
});

it('allocates distinct endpoint configuration objects for each container', () => {
  const result = plans(fixture());
  if (!result.worker.NetworkingConfig?.EndpointsConfig) throw new Error('Missing fixture network');
  result.worker.NetworkingConfig.EndpointsConfig.orbis_private = { Aliases: ['changed'] };
  expect(result.verifier.NetworkingConfig).toEqual({ EndpointsConfig: { orbis_private: {} } });
});

it('keeps the required worker capabilities independent from mutable create options', () => {
  const result = plans(fixture());
  result.worker.HostConfig?.CapAdd.pop();
  expect(plans(fixture()).worker.HostConfig?.CapAdd).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
});
