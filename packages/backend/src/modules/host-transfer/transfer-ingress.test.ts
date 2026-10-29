import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { TransferIngress } from './transfer-ingress';

const coreId = 'a'.repeat(64);
const proxyId = 'b'.repeat(64);
const networkId = 'c'.repeat(64);
const root = '/srv/orbis';
let core: Dockerode.ContainerInspectInfo;
let proxy: Dockerode.ContainerInspectInfo;
let network: Dockerode.NetworkInspectInfo;
let proxies: { Id: string }[];
let networks: { Id: string }[];
const containerInspect = vi.fn(async (id: string, _options?: unknown) => (id === coreId.slice(0, 12) ? core : proxy));
const networkInspect = vi.fn(async (_options?: unknown) => network);
const listContainers = vi.fn(async (_options?: unknown) => proxies);
const listNetworks = vi.fn(async (_options?: unknown) => networks);
const docker = {
  getContainer: (id: string) => ({ inspect: (options: unknown) => containerInspect(id, options) }),
  modem: {
    dial: (options: unknown, callback: (error: unknown, value?: Dockerode.NetworkInspectInfo) => void) =>
      networkInspect(options).then((value) => callback(null, value), callback),
  },
  listContainers,
  listNetworks,
} as unknown as Dockerode;
const config = { get: () => root } as unknown as ConfigurationService;
const ingress = () => new TransferIngress(docker, config);
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture field');
  return value;
}
const labels = (service: string) => ({
  'com.docker.compose.project': 'owned-qa-nonce',
  'com.docker.compose.service': service,
  'com.docker.compose.oneoff': 'False',
  'com.docker.compose.project.working_dir': root,
  'com.docker.compose.project.config_files': `${root}/docker-compose.yml,${root}/orbis-compose.yml`,
});
const container = (id: string, service: string, ip: string, source: string, destination: string) =>
  ({
    Id: id,
    Config: { Hostname: id.slice(0, 12), Labels: labels(service) },
    State: { Running: true, Restarting: false, Paused: false },
    Mounts: [{ Type: 'bind', Source: source, Destination: destination }],
    NetworkSettings: { Networks: { owned_main: { NetworkID: networkId, EndpointID: id.slice(0, 20), IPAddress: ip } } },
  }) as unknown as Dockerode.ContainerInspectInfo;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HOSTNAME', coreId.slice(0, 12));
  core = container(coreId, 'runtipi', '172.20.0.2', `${root}/docker-compose.yml`, '/data/docker-compose.yml');
  proxy = container(proxyId, 'runtipi-reverse-proxy', '172.20.0.3', `${root}/traefik`, '/etc/traefik');
  proxies = [{ Id: proxyId }];
  networks = [{ Id: networkId }];
  network = {
    Id: networkId,
    Driver: 'bridge',
    Scope: 'local',
    Labels: { 'com.docker.compose.project': 'owned-qa-nonce', 'com.docker.compose.network': 'tipi_main_network' },
    Containers: {
      [coreId]: { EndpointID: coreId.slice(0, 20), IPv4Address: '172.20.0.2/16' },
      [proxyId]: { EndpointID: proxyId.slice(0, 20), IPv4Address: '172.20.0.3/16' },
    },
  } as unknown as Dockerode.NetworkInspectInfo;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('accepts only the actual current core deployment and exact managed proxy endpoint, inspecting again for every request', async () => {
  const guard = ingress();
  await expect(guard.addresses('::ffff:172.20.0.3')).resolves.toEqual(['172.20.0.3']);
  await expect(guard.addresses('172.20.0.3')).resolves.toEqual(['172.20.0.3']);
  expect(containerInspect).toHaveBeenCalledTimes(4);
  expect(networkInspect).toHaveBeenCalledTimes(2);
  expect(listContainers.mock.calls[0]?.[0]).toMatchObject({ all: false });
  expect(JSON.parse((listContainers.mock.calls[0]?.[0] as { filters: string }).filters)).toEqual({
    label: ['com.docker.compose.project=owned-qa-nonce', 'com.docker.compose.service=runtipi-reverse-proxy'],
  });
  required(proxy.NetworkSettings.Networks.owned_main).IPAddress = '172.20.0.4';
  await expect(guard.addresses('172.20.0.3')).resolves.toEqual([]);
});

it.each([
  [
    'wrong current container',
    () => {
      core.Id = 'd'.repeat(64);
    },
  ],
  [
    'foreign hostname',
    () => {
      core.Config.Hostname = 'foreign';
    },
  ],
  [
    'foreign core service',
    () => {
      core.Config.Labels['com.docker.compose.service'] = 'other';
    },
  ],
  [
    'foreign core root',
    () => {
      core.Config.Labels['com.docker.compose.project.working_dir'] = '/other';
    },
  ],
  [
    'foreign core compose',
    () => {
      core.Config.Labels['com.docker.compose.project.config_files'] = '/other/docker-compose.yml';
    },
  ],
  [
    'foreign core bind',
    () => {
      required(core.Mounts[0]).Source = '/other/docker-compose.yml';
    },
  ],
  [
    'foreign proxy project',
    () => {
      proxy.Config.Labels['com.docker.compose.project'] = 'foreign';
    },
  ],
  [
    'foreign proxy service',
    () => {
      proxy.Config.Labels['com.docker.compose.service'] = 'foreign';
    },
  ],
  [
    'foreign proxy bind',
    () => {
      required(proxy.Mounts[0]).Source = '/other/traefik';
    },
  ],
  [
    'stopped proxy',
    () => {
      proxy.State.Running = false;
    },
  ],
  [
    'restarting core',
    () => {
      core.State.Restarting = true;
    },
  ],
  [
    'duplicate proxies',
    () => {
      proxies.push({ Id: 'd'.repeat(64) });
    },
  ],
  [
    'duplicate networks',
    () => {
      networks.push({ Id: 'd'.repeat(64) });
    },
  ],
  [
    'foreign network project',
    () => {
      required(network.Labels)['com.docker.compose.project'] = 'foreign';
    },
  ],
  [
    'foreign logical network',
    () => {
      required(network.Labels)['com.docker.compose.network'] = 'other';
    },
  ],
  [
    'foreign network identity',
    () => {
      network.Id = 'd'.repeat(64);
    },
  ],
  [
    'host network',
    () => {
      network.Driver = 'host';
    },
  ],
  [
    'missing core membership',
    () => {
      delete required(network.Containers)[coreId];
    },
  ],
  [
    'changed proxy endpoint',
    () => {
      required(required(network.Containers)[proxyId]).EndpointID = 'replaced';
    },
  ],
  [
    'changed proxy IP',
    () => {
      required(required(network.Containers)[proxyId]).IPv4Address = '172.20.0.4/16';
    },
  ],
  [
    'public proxy endpoint',
    () => {
      required(proxy.NetworkSettings.Networks.owned_main).IPAddress = '8.8.8.8';
    },
  ],
] as const)('refuses %s without a cached trust grant', async (_name, change) => {
  change();
  await expect(ingress().addresses('172.20.0.3')).resolves.toEqual([]);
});

it('refuses socket neighbors and public peers, and never uses a custom hostname as Docker identity', async () => {
  await expect(ingress().addresses('172.20.0.4')).resolves.toEqual([]);
  containerInspect.mockClear();
  await expect(ingress().addresses('8.8.8.8')).resolves.toEqual([]);
  vi.stubEnv('HOSTNAME', 'runtipi');
  await expect(ingress().addresses('172.20.0.3')).resolves.toEqual([]);
  expect(containerInspect).not.toHaveBeenCalled();
});

it('bounds a stalled Docker inspection, aborts it and returns no ingress identity', async () => {
  vi.useFakeTimers();
  containerInspect.mockImplementationOnce(async () => new Promise(() => undefined));
  const pending = ingress().addresses('172.20.0.3');
  await vi.advanceTimersByTimeAsync(2001);
  await expect(pending).resolves.toEqual([]);
  expect((containerInspect.mock.calls[0]?.[1] as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true);
});

it('sanitizes unavailable Docker failures', async () => {
  containerInspect.mockRejectedValueOnce(new Error('private-daemon-path-and-detail'));
  await expect(ingress().addresses('172.20.0.3')).resolves.toEqual([]);
});

it('forwards the deadline cancellation to network inspection without continuing with partial identity', async () => {
  vi.useFakeTimers();
  networkInspect.mockImplementationOnce(async () => new Promise(() => undefined));
  const pending = ingress().addresses('172.20.0.3');
  await vi.advanceTimersByTimeAsync(2001);
  await expect(pending).resolves.toEqual([]);
  const options = networkInspect.mock.calls[0]?.[0] as { abortSignal: AbortSignal; path: string; method: string };
  expect(options).toMatchObject({ path: `/networks/${networkId}`, method: 'GET' });
  expect(options.abortSignal.aborted).toBe(true);
});
