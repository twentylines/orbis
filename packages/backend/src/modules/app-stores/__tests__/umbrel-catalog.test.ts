import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, APP_DATA_DIR, APP_DIR } from '@/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStore } from '@/core/database/drizzle/types';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { AppValidationService } from '@/modules/app-lifecycle/services/app-validation.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import type { AppUrn } from '@runtipi/common/types';
import { describe, expect, it, vi } from 'vitest';
import { stringify, parse } from 'yaml';
import { withAppRepositoryCustody } from '../app-store-lock';
import { AppStoreFilesManager } from '../app-store-files-manager';
import { assertUmbrelRuntimeAccess, parseUmbrelYaml, translateUmbrelApp } from '../umbrel-catalog';

const urn = 'recipe:umbrel' as AppUrn;
const manifest = {
  manifestVersion: 1,
  id: 'recipe',
  name: 'Recipe',
  tagline: 'Plan meals',
  version: '1.2.3',
  category: 'files',
  developer: 'Recipe team',
  repo: 'https://example.com/recipe',
  port: 9925,
  dependencies: [],
  gallery: ['https://example.com/recipe.png'],
};
const definition = {
  version: '3.7',
  services: {
    app_proxy: { environment: { APP_HOST: 'recipe_web_1', APP_PORT: 9000 } },
    web: { image: 'registry.example/recipe:1.2.3', environment: { PUID: 1000 }, volumes: ['${APP_DATA_DIR}/data:/app/data'] },
  },
};
const translate = (compose: unknown = definition, metadata: unknown = manifest) =>
  translateUmbrelApp({ manifest: stringify(metadata), compose: stringify(compose), urn, revision: 'assets' });
const web = (fields: Record<string, unknown>) => ({
  ...definition,
  services: { ...definition.services, web: { ...definition.services.web, ...fields } },
});
const protectedForm = { openPort: false, enableAuth: true, exposedLocal: true };

describe('Umbrel package translation', () => {
  it('maps dependency-closed packages into existing Compose and protected routing', () => {
    const result = translate();
    if (!result.compose) throw new Error('Expected supported Compose');
    expect(result.info).toMatchObject({
      available: true,
      catalog_format: 'umbrel',
      categories: ['data'],
      port: 9925,
      compatibility: { supported: true, requires_auth: true },
    });
    expect(result.compose?.services).not.toHaveProperty('app_proxy');
    expect(result.compose?.services.web?.['x-runtipi']).toEqual({ is_main: true, internal_port: 9000 });
    const output = parse(new DockerComposeBuilder().getDockerCompose(result.compose, protectedForm, urn, '10.0.0.0/24'));
    const main = output.services[Object.keys(output.services)[0] ?? ''];
    expect(main.image).toBe(definition.services.web.image);
    expect(main.ports).toBeUndefined();
    expect(main.labels['traefik.http.routers.recipe-umbrel-local.middlewares']).toBe('runtipi');
    expect(main.labels['traefik.http.services.recipe-umbrel.loadbalancer.server.port']).toBe('9000');
    expect(main.volumes).toEqual(['${APP_DATA_DIR}/data:/app/data']);
    expect(Object.keys(output.services)[0]).toMatch(/^umbrel_[a-f0-9]{20}_web$/);
    expect(main.networks.recipe_umbrel_network.aliases).toEqual(['web', 'recipe_web_1']);
    expect(main.networks.tipi_main_network).not.toHaveProperty('aliases');
  });
  it('does not silently break upstream public endpoints by protecting an authentication whitelist', () => {
    const result = translate({
      ...definition,
      services: {
        ...definition.services,
        app_proxy: { environment: { ...definition.services.app_proxy.environment, PROXY_AUTH_WHITELIST: '/api/public/*' } },
      },
    });
    expect(result.info.available).toBe(false);
    expect(result.info.compatibility?.reasons.join(' ')).toContain('per-path routing');
    expect(result.compose).toBeNull();
  });
  it('ignores a redundant whitelist when the upstream gateway explicitly adds no authentication', () => {
    const result = translate({
      ...definition,
      services: {
        ...definition.services,
        app_proxy: {
          environment: { ...definition.services.app_proxy.environment, PROXY_AUTH_ADD: 'false', PROXY_AUTH_WHITELIST: '/api/public/*' },
        },
      },
    });
    expect(result.info.available).toBe(true);
    expect(result.info.compatibility?.requires_auth).toBe(false);
  });
  it.each([{}, { enableAuth: true }, { ...protectedForm, openPort: true }, { ...protectedForm, enableAuth: false }])(
    'rejects auth bypass in admission and runtime %j',
    (form) => {
      const result = translate();
      expect(() => assertUmbrelRuntimeAccess(result.info, form)).toThrow(/authentication/);
      const compose = result.compose;
      if (!compose) throw new Error('Expected supported Compose');
      expect(() => new DockerComposeBuilder().getDockerCompose(compose, form, urn, '10.0.0.0/24')).toThrow(/authenticated/);
    },
  );
  it('enforces compatibility at actual install and configuration-update admission', async () => {
    const repo = { getApps: vi.fn().mockResolvedValue([]) } as unknown as AppsRepository;
    const config = {
      getConfig: vi.fn().mockReturnValue({ architecture: 'amd64', version: '1.0.0', demoMode: false }),
    } as unknown as ConfigurationService;
    const logger = { warn: vi.fn() } as unknown as LoggerService;
    const validation = new AppValidationService(repo, config, logger);
    const unsafe = translate(web({ privileged: true })).info;
    await expect(
      validation.validateInstallSettings(urn, unsafe, { openPort: false, skipEnv: false, skipPull: false, skipRun: false }),
    ).rejects.toThrow(/privileged/);
    await expect(
      validation.validateUpdateConfigSettings(
        urn,
        translate().info,
        { openPort: true, enableAuth: false, skipEnv: false, skipPull: false, skipRun: false },
        1,
      ),
    ).rejects.toThrow(/authentication/);
    await expect(
      validation.validateInstallSettings(urn, translate().info, { ...protectedForm, skipEnv: false, skipPull: false, skipRun: false }),
    ).resolves.toBeUndefined();
  });
  it('honors explicit upstream gateway auth opt-out', () => {
    const result = translate({
      ...definition,
      services: { ...definition.services, app_proxy: { environment: { ...definition.services.app_proxy.environment, PROXY_AUTH_ADD: 'false' } } },
    });
    expect(result.info.compatibility?.requires_auth).toBe(false);
    expect(() => assertUmbrelRuntimeAccess(result.info, { openPort: true })).not.toThrow();
  });
  it.each([
    { privileged: true },
    { network_mode: 'host' },
    { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] },
    { volumes: ['${APP_DATA_DIR}/data/../../outside:/data'] },
    { volumes: ['${UMBREL_ROOT}/data/storage:/data'] },
    { volumes: [{ type: 'bind', source: '/etc', target: '/data' }] },
    { ports: ['8080:9000'] },
    { devices: ['/dev/dri:/dev/dri'] },
    { cap_add: ['SYS_ADMIN'] },
    { build: '.' },
    { env_file: ['.env'] },
    { environment: { ENDPOINT: '$APP_BITCOIN_NODE_IP' } },
    { environment: ['INHERITED_SECRET'] },
    { depends_on: ['other-app'] },
    { extends: { file: '../other.yml', service: 'web' } },
    { labels: { 'traefik.enable': true } },
  ])('keeps unsafe/platform-dependent options discoverable and uninstallable %j', (fields) => {
    const result = translate(web(fields));
    expect(result.info.available).toBe(false);
    expect(result.info.compatibility?.supported).toBe(false);
    expect(result.info.compatibility?.reasons.length).toBeGreaterThan(0);
    expect(result.compose).toBeNull();
    expect(() => assertUmbrelRuntimeAccess(result.info, protectedForm)).toThrow();
  });
  it.each([
    { dependencies: ['bitcoin'] },
    { permissions: ['GPU'] },
    { folderAccess: [{ id: 'files' }] },
    { environment: [{ name: 'TZ' }] },
    { implements: ['bitcoin'] },
    { torOnly: true },
    { manifestVersion: 2 },
    { requiresHttps: true },
    { storage: { dataRoot: 'outside' } },
  ])('rejects untranslated platform contracts %j', (fields) => {
    expect(translate(definition, { ...manifest, ...fields }).info.compatibility?.supported).toBe(false);
  });
  it('rewrites internal aliases, preserves escaped variables and generates isolated secrets', () => {
    const source = web({
      environment: { DATABASE_URL: 'http://recipe_database_1:5432', PASSWORD: '${APP_PASSWORD}', SEED: '$APP_SEED' },
      command: ['sh', '-c', 'echo $$HOME'],
      depends_on: ['database'],
    });
    const result = translate({ ...source, services: { ...source.services, database: { image: 'postgres:17' } } });
    const [password, seed] = result.info.form_fields;
    expect(result.compose?.services.web?.environment).toEqual({
      DATABASE_URL: 'http://database:5432',
      PASSWORD: `\${${password?.env_variable}}`,
      SEED: `\${${seed?.env_variable}}`,
    });
    expect(result.compose?.services.web?.command).toEqual(['sh', '-c', 'echo $$HOME']);
    expect(result.info.form_fields.map((field) => [field.env_variable, field.type])).toEqual([
      [expect.stringMatching(/^UMBREL_[A-F0-9]{20}_APP_PASSWORD$/), 'random'],
      [expect.stringMatching(/^UMBREL_[A-F0-9]{20}_APP_SEED$/), 'random'],
    ]);
    const other = translateUmbrelApp({
      manifest: stringify(manifest),
      compose: stringify({ ...source, services: { ...source.services, database: { image: 'postgres:17' } } }),
      urn: 'recipe:other' as AppUrn,
      revision: 'assets',
    });
    expect(other.info.form_fields[0]?.env_variable).not.toBe(password?.env_variable);
    expect([...result.info.form_fields, ...other.info.form_fields].map((field) => [field.min, field.encoding])).toEqual([
      [64, 'hex'],
      [64, 'hex'],
      [64, 'hex'],
      [64, 'hex'],
    ]);
  });
  it('isolates aliases and renames service dependencies for multiple imported stores', () => {
    const source = web({ depends_on: { database: { condition: 'service_started' } } });
    const result = translate({ ...source, services: { ...source.services, database: { image: 'postgres:17' } } });
    if (!result.compose) throw new Error('Expected supported Compose');
    const builder = new DockerComposeBuilder();
    const first = parse(builder.getDockerCompose(result.compose, protectedForm, urn, '10.1.0.0/24'));
    const second = parse(builder.getDockerCompose(result.compose, protectedForm, 'recipe:other' as AppUrn, '10.2.0.0/24'));
    const keys = Object.keys(first.services);
    expect(keys.some((key) => Object.hasOwn(second.services, key))).toBe(false);
    const main = first.services[keys.find((key) => key.endsWith('_web')) ?? ''];
    const database = keys.find((key) => key.endsWith('_database')) ?? '';
    expect(main.depends_on).toEqual({ [database]: { condition: 'service_started' } });
    expect(main.networks.recipe_umbrel_network.aliases).toEqual(['web', 'recipe_web_1']);
    expect(main.networks.tipi_main_network).not.toHaveProperty('aliases');
    expect(first.services[database].networks).not.toHaveProperty('tipi_main_network');
  });
  it('retains revisions and advances the existing counter on package changes', () => {
    const first = translate();
    const same = translateUmbrelApp({ manifest: stringify(manifest), compose: stringify(definition), urn, revision: 'assets', previous: first.info });
    const changed = translateUmbrelApp({
      manifest: stringify(manifest),
      compose: stringify(definition),
      urn,
      revision: 'changed assets',
      previous: first.info,
    });
    expect(same.info.tipi_version).toBe(1);
    expect(changed.info.tipi_version).toBe(2);
  });
  it('rejects alias amplification, duplicate keys, identity mismatches and prototype keys', () => {
    expect(() => parseUmbrelYaml('a: &a [value]\nb: [*a, *a]')).toThrow();
    expect(() => parseUmbrelYaml('a: 1\na: 2')).toThrow();
    expect(() => parseUmbrelYaml('constructor: value')).toThrow();
    expect(() => translate(definition, { ...manifest, id: '../other' })).toThrow();
  });
});
function managers() {
  const directories = { appDataDir: APP_DATA_DIR, appDir: APP_DIR, dataDir: DATA_DIR };
  const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as LoggerService;
  const configuration = {
    get: vi.fn().mockReturnValue(directories),
    getConfig: vi.fn().mockReturnValue({ directories }),
  } as unknown as ConfigurationService;
  const filesystem = new FilesystemService(logger);
  const store = new AppStoreFilesManager(configuration, filesystem, logger, { slug: 'umbrel', url: 'https://example.com/catalog.git' } as AppStore);
  return { store, installed: new AppFilesManager(configuration, filesystem, logger), repository: path.join(DATA_DIR, 'repos', 'umbrel', 'recipe') };
}
async function write(file: string, content: string) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
}
async function packageFiles(directory: string) {
  await write(path.join(directory, 'umbrel-app.yml'), stringify(manifest));
  await write(path.join(directory, 'docker-compose.yml'), stringify(definition));
  await write(path.join(directory, 'data', 'initial.txt'), 'first-run scaffold');
}
describe('Umbrel catalog integration', () => {
  it('detects root catalogs and installs Orbis config/Compose/data while preserving source and revisions', async () => {
    const { store, installed, repository } = managers();
    await packageFiles(repository);
    await write(path.join(DATA_DIR, 'repos', 'umbrel', 'README.md'), 'catalog');
    expect(await store.getAvailableAppUrns()).toEqual([urn]);
    expect((await store.getAppInfoFromAppStore(urn))?.available).toBe(true);
    await store.copyAppFromRepoToInstalled(urn);
    expect((await installed.getInstalledAppInfo(urn))?.catalog_format).toBe('umbrel');
    const runtime = await installed.getSourceDockerComposeYaml(urn);
    expect(runtime.content?.services.web?.image).toBe(definition.services.web.image);
    expect(runtime.content?.services).not.toHaveProperty('app_proxy');
    expect(await fs.promises.readFile(path.join(repository, 'docker-compose.yml'), 'utf8')).toBe(stringify(definition));
    expect(await fs.promises.readFile(path.join(installed.getAppPaths(urn).appInstalledDir, 'data', 'initial.txt'), 'utf8')).toBe(
      'first-run scaffold',
    );
    expect((await store.getAppUpdateInfo(urn)).latestVersion).toBe(1);
    await write(path.join(repository, 'data', 'initial.txt'), 'changed scaffold');
    expect((await store.getAppUpdateInfo(urn)).latestVersion).toBe(2);
  });
  it.each(['exports.sh', 'hooks/pre-install'])('refuses hooks without deleting installed state: %s', async (hook) => {
    const { store, installed, repository } = managers();
    await packageFiles(repository);
    await store.copyAppFromRepoToInstalled(urn);
    const configPath = path.join(installed.getAppPaths(urn).appInstalledDir, 'config.json');
    const prior = await fs.promises.readFile(configPath, 'utf8');
    await write(path.join(repository, hook), 'exit 1');
    expect((await store.getAppInfoFromAppStore(urn))?.compatibility?.supported).toBe(false);
    await expect(store.copyAppFromRepoToInstalled(urn)).rejects.toThrow(/hooks|exports/);
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(prior);
  });
  it('blocks symlinked definitions and data files instead of reading host contents', async () => {
    const { store, repository } = managers();
    await packageFiles(repository);
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), path.join(repository, 'data', 'secret'));
    expect((await store.getAppInfoFromAppStore(urn))?.compatibility?.supported).toBe(false);
    await expect(store.copyAppFromRepoToInstalled(urn)).rejects.toThrow(/symbolic/);
    await fs.promises.unlink(path.join(repository, 'umbrel-app.yml'));
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), path.join(repository, 'umbrel-app.yml'));
    expect(await store.getAppInfoFromAppStore(urn)).toBeUndefined();
  });

  it('captures all package bytes under the shared repository writer gate', async () => {
    const { store, repository } = managers();
    await packageFiles(repository);
    let releaseRead: () => void = () => undefined;
    const resume = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let enteredRead: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve;
    });
    const open = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(repository, 'docker-compose.yml')) {
        enteredRead();
        await resume;
      }
      return open(...args);
    });
    const reading = store.getAppInfoFromAppStore(urn);
    await entered;
    let writerEntered = false;
    const writing = withAppRepositoryCustody(path.resolve(DATA_DIR, 'repos', 'umbrel'), async () => {
      writerEntered = true;
      await write(path.join(repository, 'docker-compose.yml'), stringify(web({ privileged: true })));
    });
    await Promise.resolve();
    expect(writerEntered).toBe(false);
    releaseRead();
    expect((await reading)?.compatibility?.supported).toBe(true);
    await writing;
    spy.mockRestore();
    expect((await store.getAppInfoFromAppStore(urn))?.compatibility?.supported).toBe(false);
  });
  it('preserves the existing native catalog', async () => {
    const { store } = managers();
    const native = path.join(DATA_DIR, 'repos', 'umbrel', 'apps', 'native');
    await write(
      path.join(native, 'config.json'),
      JSON.stringify({
        id: 'native',
        available: true,
        name: 'Native',
        tipi_version: 42,
        short_desc: 'Existing app',
        author: 'Team',
        source: 'https://example.com',
      }),
    );
    expect(await store.getAvailableAppUrns()).toEqual(['native:umbrel']);
    expect((await store.getAppInfoFromAppStore('native:umbrel' as AppUrn))?.tipi_version).toBe(42);
  });
});
