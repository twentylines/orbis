import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppEventsQueue, appEventResultSchema } from '@/modules/queue/entities/app-events';
import { createMockApp } from '@/tests/helpers/app-mocks';
import type { AppUrn } from '@runtipi/common/types';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { StatusManagerService } from '../services/status-manager.service';
import { StartAppHandler } from './start-app.handler';
import { BackupAppHandler } from './backup-app.handler';

describe('BackupAppHandler runtime preservation', () => {
  it.each([
    { success: true, statePreserved: true, initial: 'running', expected: 'running' },
    { success: true, statePreserved: true, initial: 'stopped', expected: 'stopped' },
    { success: false, statePreserved: true, initial: 'running', expected: 'running' },
    { success: false, statePreserved: true, initial: 'stopped', expected: 'stopped' },
    { success: false, statePreserved: false, initial: 'running', expected: 'stopped' },
    { success: false, statePreserved: undefined, initial: 'running', expected: 'stopped' },
  ] as const)('reports $expected after success=$success preserved=$statePreserved initial=$initial', async (test) => {
    const repository = mock<AppsRepository>();
    const queue = mock<AppEventsQueue>();
    const status = mock<StatusManagerService>();
    const start = mock<StartAppHandler>();
    const config = mock<ConfigurationService>();
    const urn = 'demo:store' as AppUrn;
    repository.getAppByUrn.mockResolvedValue(createMockApp({ id: 12, status: test.initial }));
    const reply = appEventResultSchema.assert({
      success: test.success,
      message: test.success ? 'Backup completed' : 'Backup failed',
      ...(test.statePreserved === undefined ? {} : { statePreserved: test.statePreserved }),
    });
    queue.publish.mockResolvedValue(reply);
    const handler = new BackupAppHandler(repository, queue, status, start, config);

    await handler.execute(urn);
    const emit = test.success ? status.emitSuccess : status.emitError;
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ appId: 12, appUrn: urn, status: test.expected }));
    expect(start.execute).not.toHaveBeenCalled();
  });

  it('still handles a successful legacy worker response without preservation metadata', async () => {
    const repository = mock<AppsRepository>();
    const queue = mock<AppEventsQueue>();
    const status = mock<StatusManagerService>();
    const start = mock<StartAppHandler>();
    const config = mock<ConfigurationService>();
    const urn = 'demo:store' as AppUrn;
    repository.getAppByUrn.mockResolvedValue(createMockApp({ status: 'running' }));
    queue.publish.mockResolvedValue({ success: true, message: 'Backup completed' });
    await new BackupAppHandler(repository, queue, status, start, config).execute(urn);
    await vi.waitFor(() => expect(start.execute).toHaveBeenCalledExactlyOnceWith(urn));
  });
});
