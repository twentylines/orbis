import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import { AppLifecycleCommandFactory } from '@/modules/app-lifecycle/app-lifecycle-command.factory';
import { AppLifecycleCommand } from '@/modules/app-lifecycle/commands/command';
import {
  hasInstallRequestHold,
  installRequestDirectory,
  reserveInstallRequest,
  takeInstallRequestReceipt,
} from '@/modules/app-lifecycle/install-request-receipt';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

const urn = createAppUrn('demo', 'store');
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { force: true, recursive: true });
});
async function fixture() {
  const request = { requestId: randomUUID(), owner: randomUUID(), skipRun: false };
  const app = createMockApp({ id: 7, createdAt: 123, appName: 'demo', appStoreSlug: 'store', status: 'installing', version: 1 });
  await reserveInstallRequest(root, urn, request, async () => app);
  const cleanup = await takeInstallRequestReceipt(root, { ...request, app });
  if (!cleanup) throw new Error('Missing install claim');
  const directory = installRequestDirectory(root, urn);
  const spentDirectory = (await fs.readdir(directory)).find((name) => name.startsWith('spent-'));
  if (!spentDirectory) throw new Error('Missing spent receipt');
  const spent = path.join(directory, spentDirectory, request.requestId);
  const repository = mock<AppsRepository>();
  repository.getAppByUrn.mockResolvedValue(app);
  const files = mock<AppFilesManager>();
  files.getAppMigrationIds.mockResolvedValue([]);
  files.getAppEnv.mockResolvedValue({ path: path.join(root, 'app.env'), content: '' });
  files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ tipi_version: app.version }));
  const compose = convertLegacyToYaml({
    schemaVersion: 2,
    services: [{ name: 'web', image: 'example.test/demo:1', isMain: true, internalPort: 80 }],
  });
  files.getSourceDockerComposeYaml.mockResolvedValue({ path: path.join(root, 'installed/compose.yml'), content: compose });
  const marketplace = mock<MarketplaceService>();
  marketplace.getSourceDockerComposeYaml.mockResolvedValue({ path: path.join(root, 'catalogue/compose.yml'), content: compose });
  const docker = mock<DockerService>();
  const helpers = mock<AppHelpers>();
  const env = mock<EnvUtils>();
  env.envStringToMap.mockReturnValue(new Map());
  const services = new Map<unknown, unknown>([
    [LoggerService, mock<LoggerService>()],
    [AppFilesManager, files],
    [AppsRepository, repository],
    [DockerService, docker],
    [MarketplaceService, marketplace],
    [AppHelpers, helpers],
    [EnvUtils, env],
  ]);
  const factory = new AppLifecycleCommandFactory({ get: (token: unknown) => services.get(token) } as ModuleRef, mock<Dockerode>());
  vi.spyOn(AppLifecycleCommand.prototype as unknown as { ensureAppDir: () => Promise<void> }, 'ensureAppDir').mockResolvedValue(undefined);
  const event = { command: 'install' as const, requestId: request.requestId, appUrn: urn, form: {} };
  return { request, app, cleanup, ownership: cleanup.ownership, spent, repository, files, marketplace, docker, helpers, factory, event, compose };
}
it.each([false, true])('carries a real claimed receipt through the factory and installation, skipRun=%s', async (skipRun) => {
  const f = await fixture();
  const result = await f.factory.createCommand(f.event, f.ownership).execute(urn, { skipRun });
  expect(result.success).toBe(true);
  expect(f.marketplace.copyAppFromRepoToInstalled).toHaveBeenCalledExactlyOnceWith(urn);
  expect(f.repository.getAppByUrn).toHaveBeenCalledTimes(4);
  expect(f.docker.composeApp).toHaveBeenCalledTimes(skipRun ? 1 : 2);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
  await f.cleanup();
});
it.each(['id', 'createdAt', 'status', 'appName', 'appStoreSlug', 'version'] as const)(
  'does not write when the reserved SQL row changed: %s',
  async (field) => {
    const f = await fixture();
    const changed = { id: 8, createdAt: 124, status: 'running', appName: 'other', appStoreSlug: 'other', version: 2 };
    f.repository.getAppByUrn.mockResolvedValue({ ...f.app, [field]: changed[field] });
    const result = await f.factory.createCommand(f.event, f.ownership).execute(urn, {});
    expect(result).toMatchObject({ success: false, statePreserved: true });
    expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
    expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
    expect(f.docker.composeApp).not.toHaveBeenCalled();
  },
);
it('refuses request substitution and copied ownership without writing installed files', async () => {
  const f = await fixture();
  for (const [event, ownership] of [
    [{ ...f.event, requestId: randomUUID() }, f.ownership],
    [f.event, { ...f.ownership }],
  ] as const) {
    expect(await f.factory.createCommand(event, ownership).execute(urn, {})).toMatchObject({ success: false, statePreserved: true });
  }
  expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});
it('rechecks the receipt after catalogue reads and before the first install write', async () => {
  const f = await fixture();
  const retained = path.join(root, 'retained-claim');
  f.marketplace.getSourceDockerComposeYaml.mockImplementationOnce(async () => {
    await fs.rename(f.spent, retained);
    return { path: path.join(root, 'catalogue/compose.yml'), content: f.compose };
  });
  expect(await f.factory.createCommand(f.event, f.ownership).execute(urn, {})).toMatchObject({ success: false, statePreserved: true });
  expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  expect(await fs.stat(retained)).toBeTruthy();
});
it('preserves changed install state and issues no container commands when custody changes during file preparation', async () => {
  const f = await fixture();
  f.marketplace.copyDataDir.mockImplementation(async () => {
    await fs.chmod(f.spent, 0o644);
  });
  expect(await f.factory.createCommand(f.event, f.ownership).execute(urn, {})).toMatchObject({ success: false, statePreserved: false });
  expect(f.marketplace.copyAppFromRepoToInstalled).toHaveBeenCalledOnce();
  expect(f.marketplace.copyDataDir).toHaveBeenCalledOnce();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
  expect(await fs.stat(f.spent)).toBeTruthy();
});
it('does not use install ownership alone as proof of clean migration storage', async () => {
  const f = await fixture();
  f.files.getAppMigrationIds.mockResolvedValue(['001-initial']);
  expect(await f.factory.createCommand(f.event, f.ownership).execute(urn, {})).toMatchObject({ success: false, statePreserved: true });
  expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
  expect(f.repository.replaceMigrationLedger).not.toHaveBeenCalled();
});

it('does not activate a package that advanced beyond the version reserved for this request', async () => {
  const f = await fixture();
  f.files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ tipi_version: f.app.version + 1 }));
  expect(await f.factory.createCommand(f.event, f.ownership).execute(urn, {})).toMatchObject({ success: false, statePreserved: false });
  expect(f.marketplace.copyAppFromRepoToInstalled).toHaveBeenCalledOnce();
  expect(f.helpers.generateEnvFile).not.toHaveBeenCalled();
  expect(f.marketplace.copyDataDir).not.toHaveBeenCalled();
  expect(f.docker.composeApp).not.toHaveBeenCalled();
});
