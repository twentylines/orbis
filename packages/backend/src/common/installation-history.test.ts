import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { TasksService } from '@/modules/tasks/tasks.service';
import { MetricHistoryService } from '@/modules/system/metric-history.service';
import { HostDeviceHistoryService } from '@/modules/system/host-device-history.service';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import { SystemService } from '@/modules/system/system.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('history during installation', () => {
  it('does not recover task records or start persistent metric collectors while held', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    vi.useFakeTimers();
    const config = mock<ConfigurationService>();
    const logger = mock<LoggerService>();
    const tasks = new TasksService(config, logger);
    const metrics = new MetricHistoryService(mock<SystemService>(), config, logger);
    const devices = new HostDeviceHistoryService(mock<HostTelemetryService>(), config, logger);
    await tasks.onModuleInit();
    await metrics.onModuleInit();
    await devices.onModuleInit();
    expect(config.get).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await metrics.onModuleDestroy();
    await devices.onModuleDestroy();
    expect(config.get).not.toHaveBeenCalled();
  });
});
