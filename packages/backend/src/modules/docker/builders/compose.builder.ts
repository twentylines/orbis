import { extractAppUrn } from '@/common/helpers/app-helpers';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import { type DynamicComposeSchemaYaml, type XRuntipiServiceParams } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import deepmerge from 'deepmerge';
import * as yaml from 'yaml';
import { TraefikLabelsBuilder } from './traefik-labels.builder';

/**
 * Interpolate {{RUNTIPI_APP_ID}} placeholders in labels with the actual app ID
 */
const interpolateLabels = (labels: Record<string, string | number | boolean>, appId: string): Record<string, string | number | boolean> => {
  const interpolated: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(labels)) {
    const interpolatedKey = key.replace(/\{\{\s*RUNTIPI_APP_ID\s*\}\}/g, appId);
    const interpolatedValue = typeof value === 'string' ? value.replace(/\{\{\s*RUNTIPI_APP_ID\s*\}\}/g, appId) : value;

    interpolated[interpolatedKey] = interpolatedValue;
  }

  return interpolated;
};

/**
 * Normalize labels to a record format
 */
const normalizeLabels = (labels: unknown): Record<string, string | number | boolean> => {
  if (!labels) return {};
  if (Array.isArray(labels)) {
    const normalized: Record<string, string | number | boolean> = {};
    for (const label of labels) {
      const [key, ...valueParts] = label.split('=');
      normalized[key] = valueParts.join('=');
    }
    return normalized;
  }

  return labels as Record<string, string | number | boolean>;
};

/**
 * Normalize networks to a record format
 */
const normalizeNetworks = (networks: unknown) => {
  if (!networks) return {};
  if (Array.isArray(networks)) {
    const normalized: { [key: string]: unknown } = {};

    for (const net of networks) {
      normalized[net] = {};
    }

    return normalized;
  }

  return networks as NormalizedComposeService['networks'];
};

const normalizePorts = (ports: unknown) => {
  if (!ports) return undefined;
  return Array.isArray(ports) ? ports.map((port: unknown) => (typeof port === 'object' && port !== null ? port : String(port))) : [];
};

const shortPort = /^(?:(.*):)?(\$\{[^{}]+\}|[^:/{}]+):(\$\{[^{}]+\}|[^:/{}]+)(?:\/([^/]+))?$/;
const appPort = /^(?:\$APP_PORT|\$\{APP_PORT(?::?[-?][^{}]*)?\})$/;

function isBindAddress(host: unknown) {
  if (host === undefined || host === '') return true;
  if (typeof host !== 'string') return false;
  return isIP(host.replace(/^\[(.*)\]$/, '$1')) !== 0 || /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*(?::?[-+?][^{}]*)?\})$/.test(host);
}

function portRange(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start > 0 && end >= start && end <= 65535 ? { start, end } : null;
}

function publishesMainTcpPort(ports: unknown[] | undefined, internalPort: string | number, selectedPort?: number) {
  const main = portRange(internalPort);
  return ports?.some((port) => {
    const match = typeof port === 'string' ? shortPort.exec(port) : null;
    const binding = match
      ? { host_ip: match[1], published: match[2], target: match[3], protocol: match[4] }
      : port && typeof port === 'object' && !Array.isArray(port)
        ? (port as Record<string, unknown>)
        : null;
    if (!binding) return false;
    const { host_ip: host, published, target, protocol = 'tcp' } = binding;
    if (protocol !== 'tcp' || !isBindAddress(host)) return false;
    if (typeof published === 'string' && appPort.test(published)) return String(target) === String(internalPort);
    if (selectedPort === undefined || !Number.isInteger(selectedPort) || !main || main.start !== main.end) return false;

    const publishedPorts = portRange(published);
    const targetPorts = portRange(target);
    return (
      publishedPorts &&
      targetPorts &&
      publishedPorts.end - publishedPorts.start === targetPorts.end - targetPorts.start &&
      selectedPort >= publishedPorts.start &&
      selectedPort <= publishedPorts.end &&
      main.start === targetPorts.start + selectedPort - publishedPorts.start
    );
  });
}

type NormalizedComposeService = DynamicComposeSchemaYaml['services'][string] & {
  networks: { [key: string]: { gw_priority?: number } };
  ports: unknown[];
  labels: Record<string, string | number | boolean>;
};

export class DockerComposeBuilder {
  private buildService = (
    service: DynamicComposeSchemaYaml['services'][string],
    form: AppEventFormInput,
    appUrn: AppUrn,
    hasMultipleServices: boolean,
    privateAliases?: string[],
  ) => {
    const { appName, appStoreId } = extractAppUrn(appUrn);

    const serviceCopy = { ...service };
    serviceCopy.networks = normalizeNetworks(serviceCopy.networks);
    serviceCopy.ports = normalizePorts(serviceCopy.ports);
    serviceCopy.labels = normalizeLabels(serviceCopy.labels);

    const xruntipiParams = service['x-runtipi'] || ({} as XRuntipiServiceParams);

    if (service.network_mode) {
      serviceCopy.networks = {} as NormalizedComposeService['networks'];
      serviceCopy.ports = [];
    } else {
      if (hasMultipleServices) {
        serviceCopy.networks[`${appName}_${appStoreId}_network`] = {
          gw_priority: 0,
          ...(privateAliases ? { aliases: privateAliases } : {}),
        };
      }

      if (xruntipiParams.is_main || xruntipiParams.add_to_main_network) {
        serviceCopy.networks.tipi_main_network = {
          gw_priority: 1,
        };
      }
    }

    if (xruntipiParams.is_main) {
      if (
        form.openPort &&
        !service.network_mode &&
        xruntipiParams.internal_port &&
        !publishesMainTcpPort(serviceCopy.ports, xruntipiParams.internal_port, form.port)
      ) {
        serviceCopy.ports = serviceCopy.ports || [];
        serviceCopy.ports.push(`\${APP_PORT}:${xruntipiParams.internal_port}`);
      }

      if (xruntipiParams.internal_port && service.network_mode === undefined && (form.exposed || form.exposedLocal)) {
        const traefikLabels = new TraefikLabelsBuilder({
          storeId: appStoreId,
          appId: appName,
          internalPort: xruntipiParams.internal_port,
          exposedLocal: form.exposedLocal,
          exposed: form.exposed,
          enableAuth: form.enableAuth,
          localSubdomain: form.localSubdomain,
        })
          .addExposedLabels()
          .addExposedLocalLabels();

        serviceCopy.labels = { ...serviceCopy.labels, ...traefikLabels.build() };
      }
    }

    serviceCopy.labels = { ...serviceCopy.labels, 'runtipi.managed': 'true', 'runtipi.appurn': appUrn };

    if (!service.restart) {
      serviceCopy.restart = 'unless-stopped';
    }

    return serviceCopy as NormalizedComposeService;
  };

  public getDockerCompose = (input: DynamicComposeSchemaYaml, form: AppEventFormInput, appUrn: AppUrn, subnet: string, architecture?: string) => {
    const umbrel = input['x-orbis-umbrel'] as { requires_auth?: boolean } | undefined;
    if (umbrel?.requires_auth && (form.enableAuth !== true || form.openPort === true || (!form.exposedLocal && !form.exposed))) {
      throw new Error('This Umbrel application requires an authenticated Orbis proxy with direct port access disabled.');
    }
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const appId = `${appName}-${appStoreId}`;

    const inputCopy = JSON.parse(JSON.stringify(input)) as DynamicComposeSchemaYaml;

    const privateAliases = new Map<string, string[]>();
    if (umbrel) {
      // Original Umbrel hostnames exist only on this app's isolated network. Shared
      // network DNS uses unique service keys, so separate imported apps cannot collide.
      const prefix = `umbrel_${createHash('sha256').update(appUrn).digest('hex').slice(0, 20)}_`;
      const rename = (name: string) => `${prefix}${name}`;
      inputCopy.services = Object.fromEntries(
        Object.entries(inputCopy.services).map(([name, service]) => {
          privateAliases.set(rename(name), [name, `${appName}_${name}_1`]);
          if (Array.isArray(service.depends_on)) service.depends_on = service.depends_on.map((dependency) => rename(String(dependency)));
          else if (service.depends_on && typeof service.depends_on === 'object')
            service.depends_on = Object.fromEntries(
              Object.entries(service.depends_on).map(([dependency, settings]) => [rename(dependency), settings]),
            );
          return [rename(name), service];
        }),
      );
    }

    // Merge architecture-specific overrides
    if (architecture && inputCopy['x-runtipi']?.overrides) {
      const architectureOverrides = inputCopy['x-runtipi'].overrides.find((o) => o.architecture === architecture);
      if (architectureOverrides) {
        for (const [serviceName, overrideService] of Object.entries(architectureOverrides.services)) {
          if (inputCopy.services[serviceName]) {
            const arrayMode = {
              arrayMerge: (_target: unknown[], source: unknown[]) => source,
            };
            inputCopy.services[serviceName] = deepmerge(inputCopy.services[serviceName], overrideService, arrayMode);
          } else {
            inputCopy.services[serviceName] = overrideService;
          }
        }
      }
    }

    const services = Object.values(inputCopy.services).filter(Boolean);
    const hasMultipleServices = services.length > 1 || Boolean(umbrel);

    for (const serviceName in inputCopy.services) {
      const service = inputCopy.services[serviceName];
      if (!service) continue;

      const built = this.buildService(service, form, appUrn, hasMultipleServices, privateAliases.get(serviceName));

      if (built.labels) {
        built.labels = interpolateLabels(built.labels, appId);
      }

      inputCopy.services[serviceName] = built;
      delete inputCopy.services[serviceName]?.['x-runtipi'];
    }

    // @ts-expect-error - not needed in the generated compose file
    delete inputCopy['x-runtipi'];

    const dockerNetworkName = process.env.RUNTIPI_DOCKER_NETWORK || 'runtipi_tipi_main_network';
    inputCopy.networks = inputCopy.networks || {};
    inputCopy.networks.tipi_main_network = {
      name: dockerNetworkName,
      external: true,
    };

    if (hasMultipleServices) {
      inputCopy.networks[`${appName}_${appStoreId}_network`] = {
        ipam: {
          config: [{ subnet }],
        },
      };
    }

    const header = ['# This file is generated by Orbis.', '# Manual changes will be overwritten.', '', ''].join('\n');

    return header + yaml.stringify(inputCopy, { nullStr: '' });
  };
}
