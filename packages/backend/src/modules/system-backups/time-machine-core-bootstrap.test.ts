import type { INestApplication } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { continueCoreCaptureAfterListen } from './time-machine-core-bootstrap';

const captured = vi.hoisted(() => ({ options: undefined as undefined | { startup: Record<string, () => Promise<void>>; signal: AbortSignal } }));
vi.mock('./time-machine-core-recovery', () => ({
  CoreCaptureRecovery: class {
    constructor(options: typeof captured.options) {
      captured.options = options;
    }
    continue = vi.fn(async () => undefined);
  },
}));
vi.mock('./time-machine-retained-images', () => ({ retainedImageDocker: vi.fn(() => ({})) }));
afterEach(() => {
  vi.unstubAllEnvs();
  captured.options = undefined;
});

it('replays exactly the skipped hooks and uses capture-specific presentation without ordinary bootstrap', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  const calls: string[] = [];
  const get = vi.fn((token: { name?: string } | string) => {
    const name = typeof token === 'string' ? token : token.name;
    return {
      onModuleInit: async () => {
        calls.push(`${name}.init`);
      },
      prepareStartup: async () => {
        calls.push(`${name}.prepare`);
      },
      prepareCoreCapturePresentation: async () => {
        calls.push(`${name}.presentation`);
      },
      activateCoreCaptureTimers: () => {
        calls.push(`${name}.timers`);
      },
      bootstrap: () => {
        throw Error('Ordinary bootstrap must not run.');
      },
      resumeApps: () => {
        throw Error('Managed apps must not restart.');
      },
    };
  });
  const signal = new AbortController().signal;
  await continueCoreCaptureAfterListen({ get } as unknown as INestApplication, '/data', signal);
  const options = captured.options;
  expect(options?.signal).toBe(signal);
  expect(options).toBeDefined();
  await options?.startup.initializeRecovery?.();
  await options?.startup.initializeServices?.();
  await options?.startup.preparePresentation?.();
  await options?.startup.activateTimers?.();
  expect(calls).toEqual([
    'SettingsBackupApplyService.prepare',
    'SystemBackupsService.init',
    'BackupRestoresService.prepare',
    'ResetService.init',
    'TasksService.init',
    'BackupDatabaseService.init',
    'BackupImportsService.init',
    'TimeMachineService.init',
    'AutomaticUpdatesService.init',
    'MetricHistoryService.init',
    'HostDeviceHistoryService.init',
    'NearbyDiscoveryService.init',
    'ClusterSyncService.init',
    'AppService.presentation',
    'AppService.timers',
  ]);
});

it('refuses unavailable host support without touching any service hook', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '');
  const get = vi.fn();
  await expect(continueCoreCaptureAfterListen({ get } as unknown as INestApplication, '/data', new AbortController().signal)).rejects.toThrow(
    'host service',
  );
  expect(get).not.toHaveBeenCalled();
});
