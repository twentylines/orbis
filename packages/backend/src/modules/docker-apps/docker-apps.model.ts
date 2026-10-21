import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import type { DockerApp } from '@runtipi/common/schemas';

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
};
export const dockerAppHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
export const dockerId = /^[a-f0-9]{64}$/;
const coreNames = new Set([
  'runtipi',
  'runtipi-db',
  'runtipi-queue',
  'runtipi-reverse-proxy',
  'orbis',
  'orbis-db',
  'orbis-queue',
  'orbis-reverse-proxy',
]);
const controllerImage = /^(?:ghcr\.io\/(?:runtipi\/runtipi|twentylines\/orbis))(?::|@)/;

export const protectedDockerContainer = (container: Dockerode.ContainerInfo) => {
  const labels = container.Labels ?? {};
  const service = labels['com.docker.compose.service'];
  const project = labels['com.docker.compose.project'];
  return (
    container.Names.some((name) => coreNames.has(name.replace(/^\//, ''))) ||
    (['runtipi', 'orbis'].includes(project ?? '') && coreNames.has(service ?? '')) ||
    (controllerImage.test(container.Image) && (!service || coreNames.has(service))) ||
    ['controller', 'installer'].includes(labels['io.orbis.role'] ?? '') ||
    (dockerId.test(process.env.HOSTNAME ?? '') && container.Id === process.env.HOSTNAME)
  );
};

export const dockerAppGroup = (container: Dockerode.ContainerInfo) => {
  const labels = container.Labels ?? {};
  const project = labels['com.docker.compose.project'];
  if (project && labels['com.docker.compose.service']) {
    return ['compose', project, labels['com.docker.compose.project.working_dir'] ?? '', labels['com.docker.compose.project.config_files'] ?? ''];
  }
  return ['container', container.Id];
};

export const dockerContainerDefinition = (value: Dockerode.ContainerInspectInfo) =>
  dockerAppHash([
    value.Id,
    value.Name,
    value.Image,
    value.Config,
    value.HostConfig,
    [...value.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination)),
  ]);

export function dockerAppSummary(id: string, containers: Dockerode.ContainerInspectInfo[]): DockerApp {
  const first = containers[0];
  if (!first) throw new Error('Docker app has no containers');
  const labels = first.Config.Labels ?? {};
  const automatic = containers.some((item) => item.HostConfig.AutoRemove);
  const transitioning = containers.some((item) => !['running', 'exited', 'created', 'paused', 'restarting'].includes(item.State.Status));
  return {
    id,
    name: labels['com.docker.compose.project'] || first.Name.replace(/^\//, ''),
    source: containers.some((item) => item.Config.Labels?.['runtipi.managed']?.toLowerCase() === 'true') ? 'runtipi' : 'docker',
    containers: containers.map((item) => ({
      id: item.Id,
      name: item.Name.replace(/^\//, ''),
      image: item.Config.Image,
      state: item.State.Status,
      service: item.Config.Labels?.['com.docker.compose.service'] || null,
    })),
    running: containers.filter((item) => item.State.Running).length,
    removable: !automatic && !transitioning,
    unavailableReason: automatic
      ? 'Docker automatically removes one of these containers. Back up its storage before removing it outside Orbis.'
      : transitioning
        ? 'Wait for Docker to finish changing these containers, then refresh.'
        : null,
  };
}
