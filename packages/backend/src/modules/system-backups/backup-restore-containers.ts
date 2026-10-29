import type Dockerode from 'dockerode';
import { BackupRequirementError } from './backup-files';
import { deriveRestoreStorageLayout } from './backup-restore-storage';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const requiredCapabilities = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'];
const failed = () => new BackupRequirementError('This controller cannot prepare an isolated restore worker. No server data has been changed.');

export function restoreAuxiliaryContainerPlans(original: Dockerode.ContainerInspectInfo, id: string, nonce: string) {
  const { Config: config, HostConfig: host } = original;
  if (
    !uuid.test(id) ||
    !uuid.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(original.Id) ||
    !/^sha256:[a-f0-9]{64}$/.test(original.Image) ||
    !['', '0', 'root'].includes(config.User ?? '') ||
    !original.State.Running ||
    original.State.Restarting ||
    original.State.Paused ||
    host.Privileged ||
    host.AutoRemove ||
    host.UsernsMode ||
    ['host', 'none'].includes(host.NetworkMode ?? '') ||
    host.NetworkMode?.startsWith('container:') ||
    !original.Mounts.some((mount) => mount.Type === 'bind' && mount.Destination === '/var/run/docker.sock')
  )
    throw failed();
  const capabilities = (value: unknown) => {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw failed();
    return value.map((item: string) => item.toUpperCase().replace(/^CAP_/, ''));
  };
  const added = capabilities(host.CapAdd);
  const dropped = capabilities(host.CapDrop);
  if (requiredCapabilities.some((capability) => (dropped.includes('ALL') || dropped.includes(capability)) && !added.includes(capability)))
    throw failed();
  const storage = deriveRestoreStorageLayout(original.Mounts);
  const networks = Object.keys(original.NetworkSettings.Networks);
  if (!networks.length || networks.length > 16 || networks.some((name) => !/^[a-zA-Z0-9_.-]{1,255}$/.test(name))) throw failed();
  const requestedNetwork = host.NetworkMode || networks[0];
  let networkMode = requestedNetwork;
  if (requestedNetwork && /^[a-f0-9]{64}$/.test(requestedNetwork)) {
    const matches = networks.filter((name) => original.NetworkSettings.Networks[name]?.NetworkID === requestedNetwork);
    if (matches.length > 1 || (networks.includes(requestedNetwork) && matches.length === 1 && matches[0] !== requestedNetwork)) throw failed();
    if (!networks.includes(requestedNetwork)) networkMode = matches.length === 1 ? matches[0] : undefined;
  }
  if (!networkMode || !networks.includes(networkMode) || ['host', 'none'].includes(networkMode)) throw failed();
  const endpoints = Object.fromEntries(networks.map((name) => [name, {}]));
  const labels = (role: string) => ({
    'io.orbis.restore': id,
    'io.orbis.restore.nonce': nonce,
    'io.orbis.restore.role': role,
    'traefik.enable': 'false',
  });
  const common: Dockerode.ContainerCreateOptions = {
    Image: original.Image,
    User: '0',
    WorkingDir: '/app',
    Entrypoint: ['node'],
    AttachStdin: false,
    OpenStdin: false,
    Tty: false,
    Healthcheck: { Test: ['NONE'] },
    NetworkingConfig: { EndpointsConfig: endpoints },
    HostConfig: {
      NetworkMode: networkMode,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Privileged: false,
      AutoRemove: false,
      PublishAllPorts: false,
      PortBindings: {},
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
      Memory: Math.min(host.Memory || 1024 * 1024 * 1024, 1024 * 1024 * 1024),
      PidsLimit: Math.min(host.PidsLimit && host.PidsLimit > 0 ? host.PidsLimit : 256, 256),
      LogConfig: { Type: 'none', Config: {} },
    },
  };
  const verifier: Dockerode.ContainerCreateOptions = {
    ...structuredClone(common),
    name: `orbis-restore-${id}-verifier`,
    Cmd: ['/app/main.mjs'],
    // Do not reuse HOSTNAME, installer state or a remote Docker endpoint in the isolated controller.
    Env: [
      ...(config.Env ?? []).filter((entry) => !/^(?:HOSTNAME|ORBIS_INSTALLER_[A-Z_]+|DOCKER_[A-Z_]+)=/.test(entry)),
      `ORBIS_INSTALLER_TRANSACTION=${id}`,
      'ORBIS_INSTALLER_PHASE=hold',
    ],
    Labels: labels('verifier'),
    HostConfig: { ...structuredClone(common.HostConfig), Mounts: storage.verifierMounts },
  };
  const worker: Dockerode.ContainerCreateOptions = {
    ...structuredClone(common),
    name: `orbis-restore-${id}-worker`,
    Cmd: ['/app/restore-worker.mjs', id],
    Env: ['NODE_ENV=production'],
    Labels: labels('worker'),
    HostConfig: {
      ...structuredClone(common.HostConfig),
      CapAdd: [...requiredCapabilities],
      Mounts: storage.workerMounts,
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    },
  };
  return { verifier, worker };
}
