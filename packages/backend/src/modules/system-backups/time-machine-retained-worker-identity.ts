import type Dockerode from 'dockerode';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { controllerCaptureSocketIdentity } from '../host-updates/host-controller-config';
import { verifyRetainedRestoreWorkerMounts } from './backup-restore-storage';

const fail = () => new Error('Retained restore worker identity could not be verified.');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const id = /^[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalPublicationJson(a) === canonicalPublicationJson(b);

function stableNetworks(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const volatile = new Set([
    'EndpointID',
    'IPAddress',
    'IPPrefixLen',
    'GlobalIPv6Address',
    'GlobalIPv6PrefixLen',
    'Gateway',
    'IPv6Gateway',
    'MacAddress',
    'DNSNames',
  ]);
  return Object.fromEntries(
    Object.entries(value).map(([name, endpoint]) => {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) throw fail();
      const fields = endpoint as Record<string, unknown>;
      if (typeof fields.NetworkID !== 'string' || !/^[a-f0-9]{64}$/.test(fields.NetworkID)) throw fail();
      return [name, Object.fromEntries(Object.entries(fields).filter(([key]) => !volatile.has(key)))];
    }),
  );
}

function stableMounts(value: unknown) {
  if (!Array.isArray(value)) throw fail();
  const names = new Set<string>();
  const mounts = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !('Destination' in entry) ||
      typeof entry.Destination !== 'string' ||
      names.has(entry.Destination)
    )
      throw fail();
    names.add(entry.Destination);
    return entry;
  });
  return mounts.sort((a, b) => String(a.Destination).localeCompare(String(b.Destination)));
}

// rootSnapshot and migrationSource must come directly from a verified root binding, not from the retained point or browser.
export async function verifyRetainedWorkerIdentity(options: {
  original: Dockerode.ContainerInspectInfo;
  worker: Dockerode.ContainerInspectInfo;
  rootSnapshot: unknown;
  restoreId: string;
  nonce: string;
  workerId: string;
  retainedSource: string;
  payloadSource: string;
  coordinatorImageEnv: readonly string[];
}) {
  const { original, worker } = options;
  const envMap = (values: readonly string[]) => {
    const map = new Map<string, string>();
    for (const entry of values) {
      const separator = entry.indexOf('=');
      if (separator < 1 || map.has(entry.slice(0, separator))) throw fail();
      map.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    return map;
  };
  const inherited = envMap(options.coordinatorImageEnv);
  inherited.set('NODE_ENV', 'production');
  inherited.set('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  const workerEnv = envMap(worker.Config.Env ?? []);
  const equalEnv = inherited.size === workerEnv.size && [...inherited].every(([key, value]) => workerEnv.get(key) === value);
  if (
    !uuid.test(options.restoreId) ||
    !uuid.test(options.nonce) ||
    !id.test(options.workerId) ||
    !id.test(original.Id) ||
    !digest.test(original.Image) ||
    worker.Id !== options.workerId ||
    worker.Image !== original.Image ||
    worker.Id === original.Id ||
    !['', '0', 'root'].includes(worker.Config.User ?? '') ||
    !same(worker.Config.Entrypoint, ['node']) ||
    !same(worker.Config.Cmd, ['-e', 'setInterval(()=>{},1000)']) ||
    !equalEnv ||
    worker.Config.Labels?.['io.orbis.restore'] !== options.restoreId ||
    worker.Config.Labels?.['io.orbis.restore.nonce'] !== options.nonce ||
    worker.Config.Labels?.['io.orbis.restore.role'] !== 'worker' ||
    worker.HostConfig.ReadonlyRootfs !== true ||
    worker.HostConfig.Privileged ||
    worker.HostConfig.AutoRemove ||
    !same([...(worker.HostConfig.CapDrop ?? [])].sort(), ['ALL']) ||
    !same([...(worker.HostConfig.CapAdd ?? [])].map((item) => item.replace(/^CAP_/, '')).sort(), ['CHOWN', 'DAC_OVERRIDE', 'FOWNER']) ||
    !(worker.HostConfig.SecurityOpt ?? []).includes('no-new-privileges:true') ||
    worker.HostConfig.UsernsMode ||
    worker.HostConfig.PidMode === 'host' ||
    worker.HostConfig.NetworkMode === 'host' ||
    worker.HostConfig.NetworkMode === 'none' ||
    worker.HostConfig.NetworkMode?.startsWith('container:') ||
    worker.HostConfig.Devices?.length ||
    worker.HostConfig.DeviceRequests?.length ||
    Object.keys(worker.HostConfig.PortBindings ?? {}).length ||
    (worker.HostConfig.RestartPolicy?.Name && worker.HostConfig.RestartPolicy.Name !== 'no') ||
    !worker.State.Running ||
    worker.State.Restarting ||
    worker.State.Paused
  )
    throw fail();
  const rootSnapshot = {
    Id: worker.Id,
    Image: worker.Image,
    Config: worker.Config,
    HostConfig: worker.HostConfig,
    Mounts: stableMounts(worker.Mounts),
    NetworkSettings: { Networks: stableNetworks(worker.NetworkSettings.Networks) },
  };
  const supplied = options.rootSnapshot;
  if (
    !supplied ||
    typeof supplied !== 'object' ||
    Array.isArray(supplied) ||
    !('NetworkSettings' in supplied) ||
    !supplied.NetworkSettings ||
    typeof supplied.NetworkSettings !== 'object' ||
    !('Networks' in supplied.NetworkSettings)
  )
    throw fail();
  const binding = supplied as Record<string, unknown> & { NetworkSettings: { Networks: unknown } };
  const expected = {
    Id: binding.Id,
    Image: binding.Image,
    Config: binding.Config,
    HostConfig: binding.HostConfig,
    Mounts: stableMounts(binding.Mounts),
    NetworkSettings: { Networks: stableNetworks(binding.NetworkSettings.Networks) },
  };
  if (!same(rootSnapshot, expected)) throw fail();
  const originalNetworks = original.NetworkSettings?.Networks;
  if (!originalNetworks || typeof originalNetworks !== 'object' || Array.isArray(originalNetworks)) throw fail();
  const currentNetworks = worker.NetworkSettings.Networks;
  if (!same(Object.keys(originalNetworks).sort(), Object.keys(currentNetworks).sort())) throw fail();
  for (const name of Object.keys(currentNetworks)) {
    const originalId = originalNetworks[name]?.NetworkID;
    const workerId = currentNetworks[name]?.NetworkID;
    if (originalId ? originalId !== workerId : original.State.Running) throw fail();
  }
  verifyRetainedRestoreWorkerMounts(original.Mounts, worker.Mounts, options.restoreId, options.retainedSource, options.payloadSource);
  return controllerCaptureSocketIdentity('/run/orbis/host.sock');
}
