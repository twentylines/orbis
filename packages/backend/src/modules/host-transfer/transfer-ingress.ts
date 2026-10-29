import { isAbsolute, join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DOCKERODE } from '../docker/docker.module';
import { privateTransferAddress } from './transfer-transport';

const composeLabel = 'com.docker.compose.';
const normalized = (address: string) => address.replace(/^::ffff:/i, '');

@Injectable()
export class TransferIngress {
  constructor(
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly config: ConfigurationService,
  ) {}

  private inspectNetwork(id: string, signal: AbortSignal): Promise<Dockerode.NetworkInspectInfo> {
    // This Dockerode version's network.inspect does not forward abortSignal to the modem.
    return new Promise((resolve, reject) =>
      this.docker.modem.dial(
        {
          path: `/networks/${id}`,
          method: 'GET',
          options: {},
          abortSignal: signal,
          statusCodes: { 200: true, 404: 'Network unavailable', 500: 'Network unavailable' },
        },
        (error, network) => (error ? reject(error) : resolve(network as Dockerode.NetworkInspectInfo)),
      ),
    );
  }

  async addresses(socketAddress: string): Promise<string[]> {
    if (!privateTransferAddress(socketAddress)) return [];
    const self = process.env.HOSTNAME;
    const root = this.config.get('rootFolderHost');
    if (!self || !/^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(self) || !root || !isAbsolute(root)) return [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Ingress inspection timed out'));
      }, 2000);
    });
    const options = { abortSignal: controller.signal };
    try {
      return await Promise.race([
        (async () => {
          const core = await this.docker.getContainer(self).inspect(options);
          const project = core.Config.Labels?.[`${composeLabel}project`];
          if (
            controller.signal.aborted ||
            !/^[a-f0-9]{64}$/.test(core.Id) ||
            !core.Id.startsWith(self) ||
            core.Config.Hostname !== self ||
            !project ||
            !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)
          )
            return [];
          const owned = (container: Dockerode.ContainerInspectInfo, service: string) => {
            const labels = container.Config.Labels;
            return (
              container.State.Running &&
              !container.State.Restarting &&
              !container.State.Paused &&
              labels?.[`${composeLabel}project`] === project &&
              labels?.[`${composeLabel}service`] === service &&
              labels?.[`${composeLabel}oneoff`]?.toLowerCase() === 'false' &&
              labels?.[`${composeLabel}project.working_dir`] === root &&
              labels?.[`${composeLabel}project.config_files`]?.split(',').includes(join(root, 'docker-compose.yml'))
            );
          };
          const mount = (container: Dockerode.ContainerInspectInfo, source: string, destination: string) =>
            container.Mounts.some((value) => value.Type === 'bind' && value.Source === source && value.Destination === destination);
          if (!owned(core, 'runtipi') || !mount(core, join(root, 'docker-compose.yml'), '/data/docker-compose.yml')) return [];
          const filters = (label: string) => JSON.stringify({ label: [`${composeLabel}project=${project}`, label] });
          const [proxies, networks] = await Promise.all([
            this.docker.listContainers({
              all: false,
              filters: filters(`${composeLabel}service=runtipi-reverse-proxy`),
              abortSignal: controller.signal,
            }),
            this.docker.listNetworks({ filters: filters(`${composeLabel}network=tipi_main_network`), ...options }),
          ]);
          const proxyId = proxies[0]?.Id;
          const networkId = networks[0]?.Id;
          if (
            controller.signal.aborted ||
            proxies.length !== 1 ||
            networks.length !== 1 ||
            !proxyId ||
            !networkId ||
            !/^[a-f0-9]{64}$/.test(proxyId) ||
            !/^[a-f0-9]{64}$/.test(networkId)
          )
            return [];
          const [proxy, network] = await Promise.all([
            this.docker.getContainer(proxyId).inspect(options),
            this.inspectNetwork(networkId, controller.signal),
          ]);
          if (
            controller.signal.aborted ||
            proxy.Id !== proxyId ||
            network.Id !== networkId ||
            !owned(proxy, 'runtipi-reverse-proxy') ||
            !mount(proxy, join(root, 'traefik'), '/etc/traefik') ||
            network.Driver !== 'bridge' ||
            network.Scope !== 'local' ||
            network.Labels?.[`${composeLabel}project`] !== project ||
            network.Labels?.[`${composeLabel}network`] !== 'tipi_main_network'
          )
            return [];
          const endpoint = (container: Dockerode.ContainerInspectInfo) => {
            const matches = Object.values(container.NetworkSettings.Networks).filter((value) => value.NetworkID === network.Id);
            if (matches.length !== 1) return undefined;
            const value = matches[0];
            const member = network.Containers?.[container.Id];
            if (
              !value?.EndpointID ||
              !member ||
              member.EndpointID !== value.EndpointID ||
              member.IPv4Address?.split('/')[0] !== value.IPAddress ||
              !privateTransferAddress(value.IPAddress)
            )
              return undefined;
            return value.IPAddress;
          };
          const coreAddress = endpoint(core);
          const proxyAddress = endpoint(proxy);
          return coreAddress && proxyAddress && coreAddress !== proxyAddress && normalized(socketAddress) === proxyAddress ? [proxyAddress] : [];
        })(),
        timeout,
      ]);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
