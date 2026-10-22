import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { fromAny } from '@total-typescript/shoehorn';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ConflictException } from '@nestjs/common';
import { TranslatableError } from '@/common/error/translatable-error';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { AppStoreRepository } from '../app-stores/app-store.repository';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { ClusterInstallService } from './cluster-install.service';

const fixture = () => {
  const config = mock<ConfigurationService>();
  const stores = mock<AppStoreRepository>();
  const apps = mock<AppsRepository>();
  const ports = mock<AppsService>();
  const marketplace = mock<MarketplaceService>();
  const lifecycle = mock<AppLifecycleService>();
  const store = { slug: 'target-store', url: 'https://github.com/example/apps.git', branch: 'main', enabled: true };
  stores.getEnabledAppStores.mockResolvedValue(fromAny([store]));
  const settings = {
    guestDashboard: true,
    localDomain: 'peer.local',
    internalIp: '192.168.1.20',
    domain: 'peer.example.com',
    maxBackups: 3,
    apiKey: 'private',
  };
  config.get.mockReturnValue(fromAny(settings));
  config.getConfig.mockReturnValue(fromAny({ architecture: 'arm64' }));
  const info = createMockAppInfo({
    urn: fromAny('tools:target-store'),
    available: true,
    supported_architectures: ['arm64'],
    form_fields: [{ type: 'password', env_variable: 'PASSWORD', label: 'Password', required: true, min: 8 }],
  });
  marketplace.getAppInfoFromAppStore.mockResolvedValue(info);
  lifecycle.installApp.mockResolvedValue({ requestId: 'a-request-id' });
  const service = new ClusterInstallService(config, stores, apps, ports, marketplace, lifecycle);
  return { service, config, stores, apps, ports, marketplace, lifecycle, store, info };
};

describe('paired app installation', () => {
  it('maps store origin and branch to the target slug, never the source host slug', async () => {
    const f = fixture();
    const result = await f.service.context({ appName: 'tools', storeUrl: 'https://github.com/example/apps/', branch: 'main' });
    expect(f.marketplace.getAppInfoFromAppStore).toHaveBeenCalledExactlyOnceWith('tools:target-store');
    expect(result.source).toEqual({ appName: 'tools', storeUrl: 'https://github.com/example/apps', branch: 'main' });
    expect(result.settings).toEqual({
      guestDashboard: true,
      localDomain: 'peer.local',
      internalIp: '192.168.1.20',
      domain: 'peer.example.com',
      maxBackups: 3,
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reports installation status without returning saved configuration', async () => {
    const f = fixture();
    f.apps.getAppByUrn.mockResolvedValue(createMockApp({ config: { PASSWORD: 'saved-secret' } }));
    const result = await f.service.context({ urn: 'tools:target-store' });
    expect(result.installed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('saved-secret');
  });

  it.each([
    { appName: 'tools', storeUrl: 'https://github.com/other/apps', branch: 'main' },
    { appName: 'tools', storeUrl: 'https://github.com/example/apps', branch: 'other' },
    { urn: 'tools:controller-store' },
    { urn: 'tools:_user' },
  ])('refuses a store not enabled on the target: %j', async (params) => {
    const f = fixture();
    await expect(f.service.context(params)).rejects.toThrow('not enabled');
    expect(f.marketplace.getAppInfoFromAppStore).not.toHaveBeenCalled();
    expect(f.lifecycle.installApp).not.toHaveBeenCalled();
  });

  it.each(['https://user:secret@github.com/example/apps', 'file:///etc/passwd', 'https://github.com/example/apps?key=secret'])(
    'refuses unsafe store identities %s without fetching',
    async (storeUrl) => {
      const f = fixture();
      await expect(f.service.context({ appName: 'tools', storeUrl, branch: 'main' })).rejects.toThrow('already configured');
      expect(f.marketplace.getAppInfoFromAppStore).not.toHaveBeenCalled();
    },
  );

  it('requires an unambiguous matching target store', async () => {
    const f = fixture();
    f.stores.getEnabledAppStores.mockResolvedValue(fromAny([f.store, { ...f.store, slug: 'another' }]));
    await expect(f.service.context({ appName: 'tools', storeUrl: 'https://github.com/example/apps', branch: 'main' })).rejects.toThrow(
      'More than one',
    );
  });

  it.each([{ available: false }, { deprecated: true }, { supported_architectures: ['amd64'] }])(
    'rejects unavailable or incompatible catalogue entries %j',
    async (changes) => {
      const f = fixture();
      f.marketplace.getAppInfoFromAppStore.mockResolvedValue(fromAny({ ...f.info, ...changes }));
      await expect(f.service.context({ urn: 'tools:target-store' })).rejects.toThrow();
      expect(f.lifecycle.installApp).not.toHaveBeenCalled();
    },
  );

  it('bounds catalogue pages and omits full forms and descriptions from list responses', async () => {
    const f = fixture();
    f.marketplace.searchApps.mockResolvedValue({ data: [f.info], total: 70, nextCursor: fromAny('next:target-store') });
    const page = await f.service.catalogue({ search: 'tools', pageSize: 100000, cursor: 'last:target-store' });
    expect(f.marketplace.searchApps).toHaveBeenCalledExactlyOnceWith({ search: 'tools', cursor: 'last:target-store', pageSize: 24 });
    expect(page.data[0]).not.toHaveProperty('form_fields');
    expect(page.data[0]).not.toHaveProperty('description');
    expect(page.nextCursor).toBe('next:target-store');
    await expect(f.service.catalogue({ search: 'x'.repeat(161) })).rejects.toThrow('search');
  });

  it('allocates ports on the target server', async () => {
    const f = fixture();
    f.ports.getRandomPort.mockResolvedValue(18765);
    expect(await f.service.randomPort()).toEqual({ port: 18765 });
    expect(f.ports.getRandomPort).toHaveBeenCalledOnce();
  });

  it('uses the target lifecycle and atomic new-only reservation, preserving normal force-pull support', async () => {
    const f = fixture();
    const result = await f.service.install({ urn: 'tools:target-store', form: { PASSWORD: 'supplied-secret', port: 18765, forcePull: true } });
    expect(f.lifecycle.installApp).toHaveBeenCalledWith({
      appUrn: 'tools:target-store',
      requireNew: true,
      form: expect.objectContaining({ PASSWORD: 'supplied-secret', port: 18765, forcePull: true }),
    });
    expect(result).toEqual({ requestId: 'a-request-id', urn: 'tools:target-store', accepted: true });
    expect(JSON.stringify(result)).not.toContain('supplied-secret');
  });

  it.each(
    [
      null,
      [],
      { PASSWORD: 'short' },
      { PASSWORD: { nested: 'value' } },
      { PASSWORD: 'long-enough', skipRun: false },
      { PASSWORD: 'long-enough', skipEnv: true },
      { PASSWORD: 'long-enough', skipPull: true },
      { PASSWORD: 'long-enough', UNKNOWN: 'value' },
      { PASSWORD: 'long-enough', port: 18765.5 },
      { PASSWORD: 'long-enough', maxBackups: 101 },
      { PASSWORD: 'long-enough', constructor: 'bad' },
      { PASSWORD: 'x'.repeat(65536) },
    ].map((form) => ({ form })),
  )('rejects malformed or bypass configuration before dispatch: %#', async ({ form }) => {
    const f = fixture();
    await expect(f.service.install({ urn: 'tools:target-store', form })).rejects.toThrow();
    expect(f.lifecycle.installApp).not.toHaveBeenCalled();
  });

  it('validates false and zero as values, and does not accept invalid field options', async () => {
    const f = fixture();
    f.info.form_fields = [
      { type: 'boolean', env_variable: 'ENABLED', label: 'Enabled', required: true },
      { type: 'number', env_variable: 'COUNT', label: 'Count', required: true, min: 0, max: 10 },
      { type: 'text', env_variable: 'MODE', label: 'Mode', required: true, options: [{ label: 'One', value: 'one' }] },
      { type: 'random', env_variable: 'GENERATED', label: 'Generated', required: true },
    ];
    await expect(f.service.install({ urn: 'tools:target-store', form: { ENABLED: false, COUNT: 0, MODE: 'one' } })).resolves.toMatchObject({
      accepted: true,
    });
    await expect(f.service.install({ urn: 'tools:target-store', form: { ENABLED: false, COUNT: 0, MODE: 'two' } })).rejects.toThrow('Check Mode');
    await expect(f.service.install({ urn: 'tools:target-store', form: { ENABLED: 'false', COUNT: 0, MODE: 'one' } })).rejects.toThrow(
      'Check Enabled',
    );
  });

  it('returns actionable remote validation failures without exposing submitted values or stored configuration', async () => {
    const f = fixture();
    f.lifecycle.installApp.mockRejectedValue(new TranslatableError('APP_ERROR_PORT_ALREADY_IN_USE', { port: 'secret-value', id: 'private-app' }));
    const result = await f.service.install({ urn: 'tools:target-store', form: { PASSWORD: 'supplied-secret', port: 18765 } });
    expect(result).toEqual({ accepted: false, message: 'That port is already in use on the selected server. Choose another port.' });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-app/);
    f.lifecycle.installApp.mockRejectedValue(new ConflictException('private detail'));
    expect(await f.service.install({ urn: 'tools:target-store', form: { PASSWORD: 'supplied-secret' } })).toEqual({
      accepted: false,
      message: 'This app is already installed on the selected server.',
    });
  });
});
