import { beforeEach, expect, it, vi } from 'vitest';
import type { BackupRestoreJournal } from './backup-restore-journal';
import type { BackupRestoreDockerRuntime } from './backup-restore-runtime';
import type { RestoreBootstrap } from './backup-restore-bootstrap';
import { retainedPhaseRuntime } from './time-machine-retained-runtime';
import { prepareRestorePayload, discardRestorePayload, restoreTargetEnvironmentDigest } from './backup-restore-preparation';
import { loadRetainedV6Images, prepareRetainedImagePins } from './time-machine-retained-images';
vi.mock('./time-machine-retained-images', () => ({
  prepareRetainedImagePins: vi.fn(async () => []),
  loadRetainedV6Images: vi.fn(async () => undefined),
}));
vi.mock('./time-machine-runtime-payload', () => ({ decodeRuntimePayloadManifest: (value: unknown) => value }));
vi.mock('./backup-restore-preparation', () => ({
  prepareRestorePayload: vi.fn(async () => undefined),
  discardRestorePayload: vi.fn(async () => undefined),
  restoreTargetEnvironmentDigest: vi.fn(async () => 'a'.repeat(64)),
}));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const events: string[] = [];
  let phase = 'staging';
  const journal = {
    directory: `/data/backups/restores/${id}`,
    refresh: vi.fn(async () => ({ id, phase, decision: null })),
    advance: vi.fn(async (value: string) => {
      events.push(value);
      phase = value;
    }),
  } as unknown as BackupRestoreJournal;
  const runtime = {
    verifyWorker: vi.fn(async () => {
      events.push('worker');
    }),
    stopWriters: vi.fn(async () => {
      events.push('stop');
    }),
    installDatabasePointer: vi.fn(),
    verify: vi.fn(async () => {
      events.push('historical-verify');
    }),
    restoreDatabasePointer: vi.fn(),
    resumeOriginal: vi.fn(async () => {
      events.push('resume');
    }),
  };
  const bootstrap = {
    environmentSha256: 'a'.repeat(64),
    identity: { queue: { host: 'fixture' } },
    connection: { host: 'fixture' },
    source: { seal: 'fixture' },
  } as unknown as RestoreBootstrap;
  const options = {
    journal,
    runtime: runtime as unknown as BackupRestoreDockerRuntime,
    bootstrap,
    hostname: 'fixture-worker',
    directories: { data: '/data', appData: '/app-data', cache: '/cache' },
    migrationsPath: `/data/backups/restores/${id}/retained/migrations`,
    imageAdmission: {
      expectedManifest: { schema: 'orbis.time-machine-runtime.v4' },
      expectedManifestSha256: 'a'.repeat(64),
      expectedCapture: {},
      docker: {} as never,
    },
    confirmRootActivation: vi.fn(async () => undefined),
    progress: vi.fn(),
  };
  return { options, runtime, events };
}
it('prepares once under the existing lease with fixed historical migrations and writer quiescence', async () => {
  const test = fixture();
  await retainedPhaseRuntime(test.options).prepare(new AbortController().signal);
  expect(test.events).toEqual(['worker', 'preparing', 'stop']);
  expect(prepareRestorePayload).toHaveBeenCalledWith(
    expect.objectContaining({
      trustedMigrationsFolder: test.options.migrationsPath,
      source: expect.objectContaining({ directory: `/data/backups/restores/${id}/source/payload` }),
    }),
  );
  expect(loadRetainedV6Images).not.toHaveBeenCalled();
});
it('loads v6 replica images after materialization and before prepared without creating Compose pins', async () => {
  const test = fixture();
  const appRuntime = { fixture: 'protected app runtime' };
  vi.mocked(prepareRestorePayload).mockImplementationOnce(async (options) => {
    test.events.push('materialized');
    expect(options.retainedPins).toBeUndefined();
    await options.beforePrepared?.(options.signal);
    test.events.push('prepared');
    return {} as never;
  });
  vi.mocked(loadRetainedV6Images).mockImplementationOnce(async () => {
    test.events.push('loaded');
  });
  await retainedPhaseRuntime({
    ...test.options,
    imageAdmission: {
      ...test.options.imageAdmission,
      expectedManifest: { schema: 'orbis.time-machine-runtime.v6' },
      expectedAppRuntime: appRuntime as never,
    },
  }).prepare(new AbortController().signal);
  expect(test.events).toEqual(['worker', 'preparing', 'stop', 'materialized', 'loaded', 'prepared']);
  expect(prepareRetainedImagePins).not.toHaveBeenCalled();
});
it('does not mark v6 prepared when its protected descriptor is missing', async () => {
  const test = fixture();
  vi.mocked(prepareRestorePayload).mockImplementationOnce(async (options) => {
    await options.beforePrepared?.(options.signal);
    return {} as never;
  });
  await expect(
    retainedPhaseRuntime({
      ...test.options,
      imageAdmission: { ...test.options.imageAdmission, expectedManifest: { schema: 'orbis.time-machine-runtime.v6' } },
    }).prepare(new AbortController().signal),
  ).rejects.toThrow();
  expect(loadRetainedV6Images).not.toHaveBeenCalled();
});
it('refuses changed environment or an unbound migration path before stopping writers', async () => {
  const test = fixture();
  vi.mocked(restoreTargetEnvironmentDigest).mockResolvedValueOnce('b'.repeat(64));
  await expect(retainedPhaseRuntime(test.options).prepare(new AbortController().signal)).rejects.toThrow();
  await expect(retainedPhaseRuntime({ ...test.options, migrationsPath: '/attacker' }).prepare(new AbortController().signal)).rejects.toThrow();
  expect(test.runtime.stopWriters).not.toHaveBeenCalled();
});
it('delegates historical verification and guarded recovery to the bound runtime', async () => {
  const test = fixture();
  const runtime = retainedPhaseRuntime(test.options);
  await runtime.verifyCandidate(new AbortController().signal);
  await runtime.discardPreparation(new AbortController().signal);
  expect(test.events).toEqual(['historical-verify', 'stop', 'resume']);
  expect(discardRestorePayload).toHaveBeenCalled();
});
