import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { DockerComposeBuilder } from '../compose.builder';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { DynamicComposeSchemaYaml } from '@runtipi/common/schemas';

const urn = createAppUrn('nginx', 'store-id');
const subnet = '10.128.1.0/24';

describe('DockerComposeBuilder', () => {
  let composeBuilder: DockerComposeBuilder;

  beforeEach(() => {
    composeBuilder = new DockerComposeBuilder();
  });

  afterEach(() => vi.unstubAllEnvs());

  describe('Variable interpolation', () => {
    it('should replace {{RUNTIPI_APP_ID}} in label values', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    labels:
      runtipi.app_id: '{{RUNTIPI_APP_ID}}'
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels['runtipi.app_id']).toBe('nginx-store-id');
    });

    it('should replace {{ RUNTIPI_APP_ID }} with spaces in label values', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    labels:
      runtipi.app_id: '{{ RUNTIPI_APP_ID }}'
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels['runtipi.app_id']).toBe('nginx-store-id');
    });

    it('should replace {{RUNTIPI_APP_ID}} in label keys', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    labels:
      '{{RUNTIPI_APP_ID}}': 'value'
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels['nginx-store-id']).toBe('value');
    });

    it('should replace multiple {{RUNTIPI_APP_ID}} occurrences', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    labels:
      test: '{{RUNTIPI_APP_ID}}-{{RUNTIPI_APP_ID}}'
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels.test).toBe('nginx-store-id-nginx-store-id');
    });

    it('should not replace non-string label values', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    labels:
      numeric_label: 123
      boolean_label: true
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels.numeric_label).toBe(123);
      expect(resultParsed.services.web.labels.boolean_label).toBe(true);
    });
  });

  describe('Architecture overrides', () => {
    it('should merge architecture-specific overrides', () => {
      const doc = `
services:
  web:
    image: nginx:alpine
x-runtipi:
  overrides:
    - architecture: arm64
      services:
        web:
          image: nginx:arm64
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet, 'arm64');

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.image).toBe('nginx:arm64');
    });

    it('should not merge overrides for different architecture', () => {
      const doc = `
services:
  web:
    image: nginx:alpine
x-runtipi:
  overrides:
    - architecture: arm64
      services:
        web:
          image: nginx:arm64
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet, 'amd64');

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.image).toBe('nginx:alpine');
    });
  });

  describe('Restart policy preservation', () => {
    it('should preserve restart policy from YAML', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    restart: always
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.restart).toBe('always');
    });

    it('should add default restart: unless-stopped if not specified', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.restart).toBe('unless-stopped');
    });
  });

  describe('Network configuration', () => {
    it.each([undefined, '', 'orbis_test_main'])('keeps external network and proxy routing together for override %j', (override) => {
      vi.stubEnv('RUNTIPI_DOCKER_NETWORK', override);
      const input: DynamicComposeSchemaYaml = {
        'x-runtipi': { schema_version: 2 },
        services: {
          web: { image: 'nginx:alpine', 'x-runtipi': { is_main: true, internal_port: 80 } },
          db: { image: 'postgres:alpine' },
        },
      };
      const generated = yaml.parse(composeBuilder.getDockerCompose(input, { exposed: true, exposedLocal: true, enableAuth: true }, urn, subnet));
      const selected = override || 'runtipi_tipi_main_network';
      expect(generated.networks.tipi_main_network).toEqual({ name: selected, external: true });
      expect(generated.services.web.labels['traefik.docker.network']).toBe(selected);
      expect(generated.services.web.labels['traefik.http.routers.nginx-store-id.middlewares']).toBe('runtipi');
      expect(generated.services.web.labels['traefik.http.routers.nginx-store-id-local.middlewares']).toBe('runtipi');
      expect(generated.services.db.networks).not.toHaveProperty('tipi_main_network');
      expect(input.networks).toBeUndefined();
    });

    it('should add app-specific network for multi-service apps', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
  db:
    image: postgres
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.networks['nginx_store-id_network']).toBeDefined();
      expect(resultParsed.networks['nginx_store-id_network'].ipam).toBeDefined();
      expect(resultParsed.networks['nginx_store-id_network'].ipam.config[0].subnet).toBe(subnet);
    });

    it('should add tipi_main_network when is_main is true', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.networks.tipi_main_network).toBeDefined();
      expect(resultParsed.networks.tipi_main_network.name).toBe('runtipi_tipi_main_network');
      expect(resultParsed.networks.tipi_main_network.external).toBe(true);
    });

    it('should add tipi_main_network when add_to_main_network is true', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      add_to_main_network: true
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.networks.tipi_main_network).toBeDefined();
    });
  });

  describe('Port configuration', () => {
    const mainPort = '${APP_PORT}:80';
    const composeWithPorts = (ports: unknown[]): DynamicComposeSchemaYaml => ({
      'x-runtipi': { schema_version: 2 },
      services: { web: { image: 'nginx:alpine', ports, 'x-runtipi': { is_main: true, internal_port: 80 } } },
    });
    const generatedPorts = (ports: unknown[], port?: number) =>
      yaml.parse(composeBuilder.getDockerCompose(composeWithPorts(ports), { openPort: true, port }, urn, subnet)).services.web.ports;

    it.each([
      mainPort,
      '$APP_PORT:80/tcp',
      '127.0.0.1:${APP_PORT}:80',
      '::1:${APP_PORT}:80',
      '[::1]:${APP_PORT}:80/tcp',
      '${INTERNAL_IP}:${APP_PORT}:80',
      '${BIND_IP:-127.0.0.1}:${APP_PORT:-8080}:80',
    ])('does not widen or repeat an existing TCP mapping %s', (binding) => {
      expect(generatedPorts([binding])).toEqual([binding]);
    });

    it.each([
      ['127.0.0.1:8080:80/tcp', 8080],
      ['[::1]:8080-8081:80-81', 8080],
      ['8080-8082:79-81', 8081],
    ] as const)('recognizes a matching selected numeric port in %s', (binding, selected) => {
      expect(generatedPorts([binding], selected)).toEqual([binding]);
    });

    it.each([
      '${APP_PORT}:80/udp',
      '127.0.0.1:${APP_PORT}:80/udp',
      '[::1]:${APP_PORT}:80/udp',
      '${APP_PORT}:81',
      '${OTHER_PORT}:80',
      '80:${APP_PORT}',
      '80:8080',
      '8081:80',
      '8080-8082:80',
      'invalid:${APP_PORT}:80',
      '80',
    ])('still publishes TCP for a different or unproven mapping %s', (binding) => {
      expect(generatedPorts([binding], 8080)).toEqual([binding, mainPort]);
    });

    it('does not infer an app default from a literal mapping when no selected port is available', () => {
      expect(generatedPorts(['8080:80'])).toEqual(['8080:80', mainPort]);
    });

    it('preserves long-form TCP address and other Compose options', () => {
      const binding = { target: 80, published: '${APP_PORT}', host_ip: '127.0.0.1', app_protocol: 'http', name: 'admin', mode: 'host' };
      expect(generatedPorts([binding])).toEqual([binding]);
      const selected = { ...binding, published: '8080', host_ip: '::1', protocol: 'tcp' };
      expect(generatedPorts([selected], 8080)).toEqual([selected]);
    });

    it('retains a long-form UDP binding and does not mistake automatic allocation for the selected port', () => {
      const udp = { target: 80, published: '${APP_PORT}', host_ip: '127.0.0.1', protocol: 'udp' };
      const automatic = { target: 80, mode: 'host' };
      expect(generatedPorts([udp, automatic], 8080)).toEqual([udp, automatic, mainPort]);
    });

    it('checks the winning architecture-specific bindings after array replacement', () => {
      const compose = composeWithPorts([mainPort]);
      const arm = { target: 80, published: '${APP_PORT}', host_ip: '::1' };
      compose['x-runtipi'].overrides = [{ architecture: 'arm64', services: { web: { image: 'nginx:arm64', ports: [arm] } } }];
      const command = (architecture: string) =>
        yaml.parse(composeBuilder.getDockerCompose(compose, { openPort: true }, urn, subnet, architecture)).services.web;

      expect(command('arm64')).toMatchObject({ image: 'nginx:arm64', ports: [arm] });
      expect(command('amd64')).toMatchObject({ image: 'nginx:alpine', ports: [mainPort] });
      expect(compose.services.web?.ports).toEqual([mainPort]);
    });

    it('should add port when is_main and openPort are set', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.ports).toContain('${APP_PORT}:80');
    });

    it('should not add port when openPort is false', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: false, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.ports).toBeUndefined();
    });
  });

  describe('Traefik labels', () => {
    it('should add Traefik labels when exposed is true', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels).toBeDefined();
      expect(resultParsed.services.web.labels['runtipi.managed']).toBe('true');
      expect(resultParsed.services.web.labels['runtipi.appurn']).toBe(urn);
    });

    it('should add Traefik labels when exposedLocal is true', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: false, domain: 'hello.com', exposedLocal: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.labels).toBeDefined();
    });

    it('should not add Traefik labels when not exposed', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(
        parsed,
        { openPort: false, domain: 'hello.com', exposed: false, exposedLocal: false },
        urn,
        subnet,
      );

      const resultParsed = yaml.parse(result);
      // Should only have runtipi labels, not Traefik labels
      expect(resultParsed.services.web.labels['runtipi.managed']).toBe('true');
      expect(resultParsed.services.web.labels['runtipi.appurn']).toBe(urn);
      expect(resultParsed.services.web.labels['traefik.enable']).toBeUndefined();
    });
  });

  describe('x-runtipi metadata', () => {
    it('should remove x-runtipi from services', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web['x-runtipi']).toBeUndefined();
    });

    it('should remove x-runtipi from root', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed['x-runtipi']).toBeUndefined();
    });
  });

  describe('Complete compose file', () => {
    it('should build a complete docker-compose.yml', () => {
      const doc = `x-runtipi:
  schema-version: 2

services:
  web:
    image: nginx:alpine
    restart: always
    labels:
      test: '{{RUNTIPI_APP_ID}}'
    x-runtipi:
      is_main: true
      internal_port: 80
  db:
    image: postgres
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);

      // Check service configuration
      expect(resultParsed.services.web.image).toBe('nginx:alpine');
      expect(resultParsed.services.web.restart).toBe('always');
      expect(resultParsed.services.web.labels.test).toBe('nginx-store-id');
      expect(resultParsed.services.web.labels['runtipi.managed']).toBe('true');
      expect(resultParsed.services.web.labels['runtipi.appurn']).toBe(urn);
      expect(resultParsed.services.web['x-runtipi']).toBeUndefined();

      // Check networks
      expect(resultParsed.networks['nginx_store-id_network']).toBeDefined();
      expect(resultParsed.networks.tipi_main_network).toBeDefined();

      // Check root x-runtipi removed
      expect(resultParsed['x-runtipi']).toBeUndefined();
    });

    it('should preserve empty named volumes without rendering null', () => {
      const doc = `services:
  web:
    image: nginx:alpine
volumes:
  nginx_logs:
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      expect(result).toContain(`volumes:
  nginx_logs:
`);
      expect(result).not.toContain('nginx_logs: null');
    });
  });

  describe('Network mode exclusivity', () => {
    it('should not add networks when network_mode is set to host', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    network_mode: host
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks).toEqual({});
    });

    it('should not add networks when network_mode is set to none', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    network_mode: none
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks).toEqual({});
    });

    it('should add networks normally when network_mode is not set', () => {
      const doc = `services:
  web:
    image: nginx:alpine
  db:
    image: postgres
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks['nginx_store-id_network']).toBeDefined();
    });

    it('should NOT add internal app network for single-service apps', () => {
      const doc = `services:
  web:
    image: nginx:alpine
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks['nginx_store-id_network']).toBeUndefined();
      expect(resultParsed.networks['nginx_store-id_network']).toBeUndefined();
    });

    it('should still add tipi_main_network for single-service exposed apps', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks.tipi_main_network).toBeDefined();
      expect(resultParsed.services.web.networks['nginx_store-id_network']).toBeUndefined();
    });

    it('should add internal app network for multi-service apps', () => {
      const doc = `services:
  web:
    image: nginx:alpine
  db:
    image: postgres
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.networks['nginx_store-id_network']).toBeDefined();
      expect(resultParsed.services.db.networks['nginx_store-id_network']).toBeDefined();
      expect(resultParsed.networks['nginx_store-id_network']).toBeDefined();
    });

    it('should clear ports when network_mode is set', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    network_mode: host
    ports:
      - "8080:80"
    x-runtipi:
      is_main: true
      internal_port: 80
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.ports).toEqual([]);
    });
  });

  describe('Default restart policy', () => {
    it('should add default restart: unless-stopped when no restart specified', () => {
      const doc = `services:
  web:
    image: nginx:alpine
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.restart).toBe('unless-stopped');
    });

    it('should preserve existing restart policy when specified', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    restart: always
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.restart).toBe('always');
    });

    it('should preserve restart: no when explicitly set', () => {
      const doc = `services:
  web:
    image: nginx:alpine
    restart: "no"
`;

      const parsed = yaml.parse(doc);
      const result = composeBuilder.getDockerCompose(parsed, { openPort: true, domain: 'hello.com', exposed: true }, urn, subnet);

      const resultParsed = yaml.parse(result);
      expect(resultParsed.services.web.restart).toBe('no');
    });
  });
});
