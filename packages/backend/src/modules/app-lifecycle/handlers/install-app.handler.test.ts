import { TranslatableError } from '@/common/error/translatable-error';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import type { AppUrn } from '@runtipi/common/types';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppValidationService } from '../services/app-validation.service';
import { StatusManagerService } from '../services/status-manager.service';
import { InstallAppHandler } from './install-app.handler';
import { StartAppHandler } from './start-app.handler';

const appUrn = 'rehearsal-app:orbis-qa' as AppUrn;

const createFixture = () => {
  const appRepository = mock<AppsRepository>();
  const appEventsQueue = mock<AppEventsQueue>();
  const statusManager = mock<StatusManagerService>();
  const validationService = mock<AppValidationService>();
  const marketplaceService = mock<MarketplaceService>();
  const startAppHandler = mock<StartAppHandler>();
  const appInfo = createMockAppInfo({ tipi_version: 1, port: 18991 });
  appRepository.getAppByUrn.mockResolvedValue(undefined);
  marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfo);
  appRepository.createApp.mockImplementation(async (row) => createMockApp({ ...row, id: 12 }));
  appEventsQueue.publish.mockResolvedValue({ success: true, message: 'installed' });
  const handler = new InstallAppHandler(appRepository, appEventsQueue, statusManager, validationService, marketplaceService, startAppHandler);
  return { handler, appRepository, appEventsQueue, statusManager, validationService, appInfo };
};

describe('InstallAppHandler backup retention', () => {
  it.each([
    { label: 'global default', input: {}, expected: null },
    { label: 'disabled retention', input: { maxBackups: 0 }, expected: 0 },
    { label: 'per-app override', input: { maxBackups: 9 }, expected: 9 },
  ])('persists $label in the operational row as well as the form config', async ({ input, expected }) => {
    const fixture = createFixture();
    const form = { SERVICE_LABEL: 'preserved label', custom: { nested: ['keep', 7] }, ...input };

    const result = await fixture.handler.execute(appUrn, { form, skipRun: true });
    await vi.waitFor(() => expect(fixture.statusManager.emitSuccess).toHaveBeenCalledOnce());

    expect(fixture.appRepository.createApp).toHaveBeenCalledOnce();
    const row = fixture.appRepository.createApp.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      appName: 'rehearsal-app',
      appStoreSlug: 'orbis-qa',
      maxBackups: expected,
      config: form,
      status: 'installing',
    });
    expect(fixture.validationService.validateInstallSettings).toHaveBeenCalledExactlyOnceWith(appUrn, fixture.appInfo, row?.config);
    expect(fixture.validationService.validateInstallSettings.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.appRepository.createApp.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fixture.appEventsQueue.publish).toHaveBeenCalledExactlyOnceWith({
      appUrn,
      command: 'install',
      requestId: result.requestId,
      form: { ...row?.config, skipRun: true },
    });
    expect(fixture.statusManager.emitSuccess).toHaveBeenCalledExactlyOnceWith({
      appId: 12,
      appUrn,
      event: 'install_success',
      status: 'stopped',
    });
  });

  it.each([null, -1, 101])('rejects invalid retention %s before creating or queuing an app', async (maxBackups) => {
    const fixture = createFixture();

    const error = await fixture.handler.execute(appUrn, { form: { maxBackups } }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(TranslatableError);
    expect((error as TranslatableError).getStatus()).toBe(400);
    expect((error as TranslatableError).getResponse()).toEqual({ message: 'SYSTEM_ERROR_INVALID_BODY', intlParams: undefined });
    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
    expect(fixture.validationService.validateInstallSettings).not.toHaveBeenCalled();
  });

  it('preserves install-settings validation before storing a valid retention override', async () => {
    const fixture = createFixture();
    const failure = new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, 400);
    fixture.validationService.validateInstallSettings.mockRejectedValue(failure);

    await expect(fixture.handler.execute(appUrn, { form: { maxBackups: 9 } })).rejects.toBe(failure);

    expect(fixture.appRepository.createApp).not.toHaveBeenCalled();
    expect(fixture.appEventsQueue.publish).not.toHaveBeenCalled();
  });
});
