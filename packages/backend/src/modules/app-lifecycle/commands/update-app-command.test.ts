import { AppValidationService } from '../services/app-validation.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import type { StagedAppImageUpdate } from '@/modules/docker/app-image-pins';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import { createMockApp, createMockAppInfo } from '@/tests/helpers/app-mocks';
import type { ModuleRef } from '@nestjs/core';
import { convertLegacyToYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { UpdateAppCommand } from './update-app-command';
import { TasksService } from '@/modules/tasks/tasks.service';
import { AppLifecycleCommandFactory } from '../app-lifecycle-command.factory';
import type { AppJobContext } from '../services/app-job.service';

vi.mock('@sentry/nestjs', () => ({ captureException: vi.fn() }));

const appUrn = 'app:test' as AppUrn;
const architecture = 'arm64';
const targetImage = 'example.test/target:fixture-only';
const previousImageId = `sha256:${'4'.repeat(64)}`;
const capturedImageId = `sha256:${'5'.repeat(64)}`;
const binding = { activationSha256: '6'.repeat(64), imageIds: { web: capturedImageId, worker: capturedImageId } };
const expectedRecovery = 'App update requires explicit recovery. Its metadata and any new app writes were preserved.';

const fixture = ({
  retained = false,
  performBackup = false,
  states = [{ Running: true }],
  subnet = '10.128.23.0/24',
  maxBackups = null,
}: {
  retained?: boolean;
  performBackup?: boolean;
  states?: Partial<Dockerode.ContainerInspectInfo['State']>[];
  subnet?: string | null;
  maxBackups?: number | null;
} = {}) => {
  const steps: string[] = [];
  const logger = mock<LoggerService>();
  const files = mock<AppFilesManager>();
  const dockerService = mock<DockerService>();
  const marketplace = mock<MarketplaceService>();
  const helpers = mock<AppHelpers>();
  const backups = mock<BackupManager>();
  const tasks = mock<TasksService>();
  const apps = mock<AppsRepository>();
  const config = mock<ConfigurationService>();
  const validation = mock<AppValidationService>();
  const allocator = mock<SubnetManagerService>();
  const docker = mock<Dockerode>();
  const transaction = mock<StagedAppImageUpdate>({ id: 'owned-transaction', targetDirectory: '/data/owned-stage/target' });
  const plan = mock<Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>>>();
  let stored = createMockApp({ id: 4, version: 1, subnet, status: 'updating', pendingRestart: true, maxBackups });
  let installed = 'original';
  files.getAppMigrationIds.mockResolvedValue([]);
  const containers = states.map((initial, index) => {
    const container = mock<Dockerode.Container>({ id: `owned-${index}` });
    const state = { Running: false, Paused: false, Restarting: false, ...initial };
    const identity = { image: previousImageId };
    const labels = {
      'com.docker.compose.project': 'app_test',
      'com.docker.compose.service': index === 0 ? 'web' : 'worker',
      'runtipi.managed': 'true',
      'runtipi.appurn': appUrn,
    };
    container.inspect.mockImplementation(
      async () =>
        ({ Id: container.id, Config: { Labels: labels }, State: { ...state }, Image: identity.image }) as unknown as Dockerode.ContainerInspectInfo,
    );
    container.stop.mockImplementation(async () => {
      steps.push(`stop:${container.id}`);
      Object.assign(state, { Running: false, Paused: false, Restarting: false });
    });
    container.start.mockImplementation(async () => {
      steps.push(`resume:${container.id}`);
      state.Running = true;
    });
    container.unpause.mockImplementation(async () => {
      state.Paused = false;
    });
    container.pause.mockImplementation(async () => {
      state.Paused = true;
    });
    return { container, state, labels, identity };
  });
  docker.listContainers.mockImplementation(async () => containers.map(({ container }) => ({ Id: container.id })) as Dockerode.ContainerInfo[]);
  docker.getContainer.mockImplementation((id) => containers.find(({ container }) => container.id === id)?.container as Dockerode.Container);
  dockerService.beginStagedAppUpdate.mockResolvedValue({ transaction, retained });
  dockerService.prepareStagedAppUpdate.mockResolvedValue(plan);
  plan.isCurrent.mockResolvedValue(true);
  plan.release.mockResolvedValue(undefined);
  plan.pull.mockImplementation(async () => {
    steps.push('pull-target');
    expect(installed).toBe('original');
    return binding;
  });
  plan.activate.mockImplementation(async () => {
    steps.push('activate-target');
    expect(installed).toBe('target');
    if (containers[0]) {
      containers[0].state.Running = true;
      containers[0].identity.image = capturedImageId;
    }
  });
  dockerService.retireAppImagePinsAfterUpdate.mockImplementation(async () => {
    steps.push('retire-pin');
  });
  marketplace.stageAppUpdate.mockImplementation(async () => {
    steps.push('stage-package');
  });
  files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ tipi_version: 2 }));
  files.getSourceDockerComposeYaml.mockResolvedValue({
    path: '/data/owned-stage/target/docker-compose.yml',
    content: convertLegacyToYaml({
      schemaVersion: 2,
      services: [
        { name: 'web', image: targetImage, isMain: true, internalPort: 80 },
        { name: 'worker', image: targetImage },
      ],
    }),
  });
  helpers.renderAppEnv.mockResolvedValue('TEST_SETTING=synthetic-only');
  transaction.stageTarget.mockImplementation(async () => {
    steps.push('seal-target');
  });
  transaction.recordPulledImages.mockImplementation(async () => {
    steps.push('record-image-binding');
  });
  transaction.publishTarget.mockImplementation(async () => {
    steps.push('publish-target');
    installed = 'target';
  });
  transaction.activationAttempted.mockImplementation(async () => {
    steps.push('activation-marker');
  });
  transaction.restoreMetadata.mockImplementation(async () => {
    steps.push('restore-custody');
    installed = 'original';
  });
  transaction.commit.mockImplementation(async (commit) => {
    await commit();
    steps.push('durable-commit');
  });
  apps.getAppByUrn.mockImplementation(async () => stored);
  apps.updateAppById.mockImplementation(async (_id, patch) => {
    stored = { ...stored, ...patch };
    return stored;
  });
  allocator.planUpdateSubnet.mockResolvedValue(subnet ?? '10.128.41.0/24');
  allocator.reserveUpdateSubnet.mockImplementation(async (_urn, existing, candidate) => {
    if (existing === null) {
      steps.push('reserve-subnet');
      stored = { ...stored, subnet: candidate };
    }
  });
  backups.backupApp.mockImplementation(async () => {
    steps.push('backup-original');
    expect(installed).toBe('original');
    expect(containers.every(({ state }) => !state.Running && !state.Paused && !state.Restarting)).toBe(true);
  });
  config.get.calledWith('architecture').mockReturnValue(architecture);
  config.get.calledWith('userSettings').mockReturnValue({ maxBackups: 7 } as never);
  const services = new Map<unknown, unknown>([
    [LoggerService, logger],
    [AppFilesManager, files],
    [DockerService, dockerService],
    [MarketplaceService, marketplace],
    [AppHelpers, helpers],
    [BackupManager, backups],
    [AppsRepository, apps],
    [ConfigurationService, config],
    [SubnetManagerService, allocator],
    [TasksService, tasks],
    [AppValidationService, validation],
  ]);
  const moduleRef = { get: (token: unknown) => services.get(token) } as ModuleRef;
  return {
    command: new UpdateAppCommand(moduleRef, docker, performBackup),
    moduleRef,
    tasks,
    validation,
    docker,
    dockerService,
    transaction,
    plan,
    marketplace,
    files,
    helpers,
    backups,
    apps,
    allocator,
    steps,
    containers,
    current: () => stored,
    installed: () => installed,
  };
};

describe('staged app update', () => {
  function controlled(f: ReturnType<typeof fixture>) {
    const controller = new AbortController();
    const original = f.containers[0];
    if (!original) throw new Error('Missing original container');
    const context: AppJobContext = {
      signal: controller.signal,
      check: () => controller.signal.throwIfAborted(),
      seal: vi.fn(async () => controller.signal.throwIfAborted()),
      recover: vi.fn(async () => undefined),
      progress: vi.fn(async () => undefined),
    };
    f.command.setJobContext(context);
    return { controller, context, original };
  }

  it('cancels image preparation without stopping or publishing the current app', async () => {
    const f = fixture();
    const { controller, context, original } = controlled(f);
    f.plan.pull.mockImplementation(async () => {
      controller.abort(new Error('Operation cancelled.'));
      controller.signal.throwIfAborted();
      return binding;
    });
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(f.dockerService.prepareStagedAppUpdate).toHaveBeenCalledWith(appUrn, f.transaction.id, f.docker, { signal: context.signal });
    expect(original.container.stop).not.toHaveBeenCalled();
    expect(f.transaction.publishTarget).not.toHaveBeenCalled();
    expect(f.transaction.restoreMetadata).toHaveBeenCalledOnce();
    expect(f.plan.release).toHaveBeenCalledOnce();
    expect(context.recover).toHaveBeenCalledOnce();
  });

  it('restores the original runtime when cancellation arrives during shutdown before publication', async () => {
    const f = fixture();
    const { controller, context, original } = controlled(f);
    original.container.stop.mockImplementation(async () => {
      original.state.Running = false;
      controller.abort(new Error('Operation cancelled.'));
    });
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(f.transaction.publishTarget).not.toHaveBeenCalled();
    expect(original.container.start).toHaveBeenCalledOnce();
    expect(original.state.Running).toBe(true);
    expect(context.recover).toHaveBeenCalledOnce();
  });

  it('does not claim preservation when restoring a cancelled update fails', async () => {
    const f = fixture();
    const { controller, original } = controlled(f);
    original.container.stop.mockImplementation(async () => {
      original.state.Running = false;
      controller.abort(new Error('Operation cancelled.'));
    });
    original.container.start.mockRejectedValue(new Error('Runtime unavailable.'));
    const result = await f.command.execute(appUrn, {});
    expect(result.success).toBe(false);
    expect(result.statePreserved).not.toBe(true);
    expect(f.transaction.publishTarget).not.toHaveBeenCalled();
  });

  it('disables cancellation before publishing the target', async () => {
    const f = fixture();
    const { context } = controlled(f);
    f.transaction.publishTarget.mockImplementation(async () => {
      expect(context.seal).toHaveBeenCalledOnce();
      throw new Error('Publication stopped for test.');
    });
    expect((await f.command.execute(appUrn, {})).success).toBe(false);
    expect(context.seal).toHaveBeenCalledOnce();
    expect(f.plan.activate).not.toHaveBeenCalled();
  });

  it('binds progress to the accepted request through the real command factory', async () => {
    const f = fixture();
    const event = { requestId: '00000000-0000-4000-8000-000000000001', command: 'update' as const, appUrn, form: {}, performBackup: false };
    const command = new AppLifecycleCommandFactory(f.moduleRef, f.docker).createCommand(event);
    expect((await command.execute(appUrn, event.form)).success).toBe(true);
    expect(f.tasks.progress.mock.calls.map(([request]) => request)).toEqual(Array(7).fill(event));
    expect(f.tasks.progress.mock.calls.map(([, phase]) => phase)).toEqual([
      'preparing',
      'pulling_images',
      'stopping',
      'publishing',
      'starting',
      'verifying',
      'committing',
    ]);
    expect(f.dockerService.requireAppImagePinUpdate).toHaveBeenCalledExactlyOnceWith(appUrn);
    expect(f.dockerService.beginStagedAppUpdate).toHaveBeenCalledExactlyOnceWith(appUrn, event.requestId);
  });

  it('admits a package with only previously recorded migrations', async () => {
    const f = fixture();
    f.apps.getAppByUrn.mockResolvedValueOnce({ ...f.current(), migrationsBaselined: true });
    f.apps.getMigrationLedger.mockResolvedValue({ baselined: true, migrationIds: ['001-history', '002-history'] });
    f.files.getAppMigrationIds.mockResolvedValueOnce(['002-history']);
    expect((await f.command.execute(appUrn, {})).success).toBe(true);
    expect(f.plan.activate).toHaveBeenCalledOnce();
    expect(f.apps.replaceMigrationLedger).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects pending migrations without stopping or backing up an app (baseline=%s)', async (baselined) => {
    const f = fixture();
    f.apps.getAppByUrn.mockResolvedValueOnce({ ...f.current(), migrationsBaselined: baselined });
    f.apps.getMigrationLedger.mockResolvedValue({ baselined, migrationIds: [] });
    f.files.getAppMigrationIds.mockResolvedValueOnce(['003-new']);
    expect(await f.command.execute(appUrn, {})).toMatchObject({
      success: false,
      statePreserved: true,
      message: baselined
        ? 'This update requires app migrations that Orbis cannot run yet.'
        : 'This update requires verified application migration history.',
    });
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.backups.backupApp).not.toHaveBeenCalled();
    expect(f.plan.pull).not.toHaveBeenCalled();
    expect(f.transaction.restoreMetadata).toHaveBeenCalledOnce();
  });

  it('does not infer that historical migrations ran when an older app has no ledger', async () => {
    const f = fixture();
    f.files.getAppMigrationIds.mockResolvedValueOnce([]).mockResolvedValueOnce(['001-unverified']);
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true });
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.apps.replaceMigrationLedger).not.toHaveBeenCalled();
  });

  it('still completes the operation if the task reporter rejects', async () => {
    const f = fixture();
    f.tasks.progress.mockRejectedValue(new Error('Task reporter unavailable'));
    const event = { requestId: '00000000-0000-4000-8000-000000000001', command: 'update' as const, appUrn, form: {}, performBackup: false };
    const command = new AppLifecycleCommandFactory(f.moduleRef, f.docker).createCommand(event);
    expect((await command.execute(appUrn, event.form)).success).toBe(true);
    expect(f.tasks.progress).toHaveBeenCalledWith(event, 'committing');
  });

  it('reports phases at actual work boundaries and never reports a skipped backup or start', async () => {
    const running = fixture({ performBackup: true });
    const stages: string[] = [];
    running.command.setProgressReporter(async (phase) => {
      stages.push(phase);
      if (phase === 'pulling_images') expect(running.steps).not.toContain('pull-target');
      if (phase === 'backing_up') {
        expect(running.steps).toContain('stop:owned-0');
        expect(running.steps).not.toContain('backup-original');
      }
      if (phase === 'verifying') expect(running.steps).toContain('activate-target');
      if (phase === 'committing') expect(running.steps).not.toContain('durable-commit');
    });
    expect((await running.command.execute(appUrn, {})).success).toBe(true);
    expect(stages).toEqual(['preparing', 'pulling_images', 'stopping', 'backing_up', 'publishing', 'starting', 'verifying', 'committing']);

    const stopped = fixture({ states: [{ Running: false }] });
    const report = vi.fn(async () => undefined);
    stopped.command.setProgressReporter(report);
    expect((await stopped.command.execute(appUrn, {})).success).toBe(true);
    expect(report.mock.calls.flat()).toEqual(['preparing', 'pulling_images', 'stopping', 'publishing', 'verifying', 'committing']);
  });

  it('reports recovery after a pull failure without claiming successful progress', async () => {
    const f = fixture();
    const report = vi.fn(async () => undefined);
    f.command.setProgressReporter(report);
    f.plan.pull.mockRejectedValue(new Error('pull failed'));
    expect((await f.command.execute(appUrn, {})).success).toBe(false);
    expect(report.mock.calls.flat()).toEqual(['preparing', 'pulling_images', 'recovering']);
    expect(f.plan.activate).not.toHaveBeenCalled();
  });

  it.each([false, true])('pre-pulls the exact target before downtime and commits one ready start (retained=%s)', async (retained) => {
    const f = fixture({ retained, performBackup: true });
    const form = { SERVICE_LABEL: 'keep', openPort: true, custom: { nested: ['keep', 7] } };
    const before = structuredClone(form);
    await expect(f.command.execute(appUrn, form)).resolves.toEqual({
      success: true,
      message: `App ${appUrn} updated successfully`,
      updateStatus: 'running',
    });
    expect(f.steps).toEqual([
      'stage-package',
      'seal-target',
      'pull-target',
      'record-image-binding',
      'stop:owned-0',
      'backup-original',
      'publish-target',
      'activation-marker',
      'activate-target',
      ...(retained ? ['retire-pin'] : []),
      'durable-commit',
    ]);
    expect(f.transaction.stageTarget).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(targetImage), 'TEST_SETTING=synthetic-only');
    expect(f.transaction.stageTarget.mock.lastCall?.[0]).toContain('10.128.23.0/24');
    expect(f.helpers.renderAppEnv.mock.lastCall?.[2]).toMatchObject(form);
    expect(f.helpers.renderAppEnv.mock.lastCall?.[2]).not.toBe(form);
    expect(form).toEqual(before);
    expect(f.dockerService.prepareStagedAppUpdate).toHaveBeenCalledExactlyOnceWith(appUrn, 'owned-transaction', f.docker);
    expect(f.transaction.recordPulledImages).toHaveBeenCalledExactlyOnceWith(binding);
    expect(f.plan.pull).toHaveBeenCalledOnce();
    expect(f.plan.activate).toHaveBeenCalledOnce();
    expect(f.plan.release).toHaveBeenCalledOnce();
    expect(f.dockerService.composeApp).not.toHaveBeenCalled();
    expect(f.files.deleteAppFolder).not.toHaveBeenCalled();
    expect(f.marketplace.copyAppFromRepoToInstalled).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ version: 2, status: 'running', pendingRestart: false, subnet: '10.128.23.0/24' });
  });

  it.each([false, true])('leaves actually stopped deployments stopped (retained=%s)', async (retained) => {
    const f = fixture({ retained, states: [{ Running: false }] });
    await expect(f.command.execute(appUrn, {})).resolves.toMatchObject({ success: true, updateStatus: 'stopped' });
    expect(f.plan.pull).toHaveBeenCalledOnce();
    expect(f.plan.activate).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.transaction.activationAttempted).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ version: 2, status: 'stopped', pendingRestart: true });
  });

  it.each([null, 0, 9])('preserves backup retention override %s', async (maxBackups) => {
    const f = fixture({ maxBackups, performBackup: true });
    expect((await f.command.execute(appUrn, {})).success).toBe(true);
    expect(f.backups.cleanupOldBackups).toHaveBeenCalledExactlyOnceWith(appUrn, maxBackups ?? 7);
  });

  it.each(['copy', 'render', 'pull', 'record-image-binding'] as const)('keeps the old running deployment on %s failure', async (failure) => {
    const f = fixture({ retained: true, performBackup: true, subnet: null });
    const cause = new Error('Target not ready');
    if (failure === 'copy') f.marketplace.stageAppUpdate.mockRejectedValueOnce(cause);
    if (failure === 'render') f.helpers.renderAppEnv.mockRejectedValueOnce(cause);
    if (failure === 'pull') f.plan.pull.mockRejectedValueOnce(cause);
    if (failure === 'record-image-binding') f.transaction.recordPulledImages.mockRejectedValueOnce(cause);
    expect(await f.command.execute(appUrn, {})).toEqual({ success: false, message: cause.message, statePreserved: true, updateStatus: 'running' });
    expect(f.transaction.restoreMetadata).toHaveBeenCalledOnce();
    expect(f.transaction.publishTarget).not.toHaveBeenCalled();
    expect(f.allocator.reserveUpdateSubnet).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.start).not.toHaveBeenCalled();
    expect(f.containers[0]?.state.Running).toBe(true);
    expect(f.backups.backupApp).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ version: 1, subnet: null });
  });

  it('refuses a foreign container claiming the Compose project', async () => {
    const f = fixture();
    if (f.containers[0]) f.containers[0].labels['runtipi.appurn'] = 'foreign:test' as AppUrn;
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true, updateStatus: undefined });
    expect(f.dockerService.beginStagedAppUpdate).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
  });

  it('leaves runtime status unreported when Docker inspection is unavailable', async () => {
    const f = fixture();
    f.docker.listContainers.mockRejectedValueOnce(new Error('Docker unavailable'));
    const result = await f.command.execute(appUrn, {});
    expect(result).toMatchObject({ success: false, statePreserved: true, updateStatus: undefined });
    expect(f.dockerService.composeApp).not.toHaveBeenCalled();
  });

  it('keeps the current runtime when overrides change while the staged image pull is running', async () => {
    const f = fixture({ subnet: null });
    f.plan.isCurrent.mockResolvedValueOnce(false);
    const result = await f.command.execute(appUrn, {});
    expect(result).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(f.plan.pull).toHaveBeenCalledOnce();
    expect(f.allocator.reserveUpdateSubnet).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.plan.activate).not.toHaveBeenCalled();
  });

  it('activates the prepared plan once and keeps a restart pending for later override edits', async () => {
    const f = fixture();
    f.plan.isCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: true, updateStatus: 'running' });
    expect(f.dockerService.prepareStagedAppUpdate).toHaveBeenCalledOnce();
    expect(f.plan.activate).toHaveBeenCalledOnce();
    expect(f.current()).toMatchObject({ status: 'running', version: 2, pendingRestart: true });
  });

  it('leaves the current deployment running when another app claims the planned subnet', async () => {
    const f = fixture({ subnet: null });
    f.allocator.reserveUpdateSubnet.mockRejectedValueOnce(new Error('The planned app subnet is no longer available.'));
    const result = await f.command.execute(appUrn, {});
    expect(result).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(f.plan.pull).toHaveBeenCalledOnce();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.current().subnet).toBeNull();
  });

  it('resumes exactly the old active containers when stopping only partly succeeds', async () => {
    const f = fixture({ states: [{ Running: true, Paused: true }, { Running: true }, { Running: false }] });
    f.containers[1]?.container.stop.mockRejectedValueOnce(new Error('Second container could not stop'));
    expect(await f.command.execute(appUrn, {})).toEqual({
      success: false,
      message: 'Second container could not stop',
      statePreserved: true,
      updateStatus: 'running',
    });
    expect(f.containers.map(({ state }) => [state.Running, state.Paused])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    expect(f.containers[0]?.container.start).toHaveBeenCalledOnce();
    expect(f.containers[1]?.container.start).not.toHaveBeenCalled();
    expect(f.containers[2]?.container.start).not.toHaveBeenCalled();
  });

  it.each(['backup', 'publish'] as const)('restores old metadata/runtime on %s failure and keeps its safe reservation', async (failure) => {
    const f = fixture({ subnet: null, performBackup: true });
    const cause = new Error('Preparation failed');
    if (failure === 'backup') f.backups.backupApp.mockRejectedValueOnce(cause);
    else f.transaction.publishTarget.mockRejectedValueOnce(cause);
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true, updateStatus: 'running' });
    expect(f.steps.indexOf('pull-target')).toBeLessThan(f.steps.indexOf('reserve-subnet'));
    expect(f.transaction.stageTarget.mock.calls[0]?.[0]).toContain('10.128.41.0/24');
    expect(f.transaction.restoreMetadata).toHaveBeenCalledOnce();
    expect(f.installed()).toBe('original');
    expect(f.containers[0]?.state.Running).toBe(true);
    expect(f.current()).toMatchObject({ version: 1, subnet: '10.128.41.0/24' });
    expect(f.plan.activate).not.toHaveBeenCalled();
  });

  it('holds recovery without restarting originals after possible new writes', async () => {
    const f = fixture({ retained: true });
    f.plan.activate.mockRejectedValueOnce(new Error('Target failed'));
    expect(await f.command.execute(appUrn, {})).toEqual({ success: false, message: expectedRecovery });
    expect(f.transaction.activationAttempted).toHaveBeenCalledOnce();
    expect(f.transaction.restoreMetadata).not.toHaveBeenCalled();
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(f.dockerService.retireAppImagePinsAfterUpdate).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.start).not.toHaveBeenCalled();
    expect(f.installed()).toBe('target');
    expect(f.current()).toMatchObject({ version: 1, status: 'updating' });
  });

  it('holds recovery when the ready container reports a different immutable image', async () => {
    const f = fixture({ retained: true });
    f.plan.activate.mockImplementationOnce(async () => {
      if (f.containers[0]) f.containers[0].state.Running = true;
    });
    expect(await f.command.execute(appUrn, {})).toEqual({ success: false, message: expectedRecovery });
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(f.transaction.restoreMetadata).not.toHaveBeenCalled();
    expect(f.dockerService.retireAppImagePinsAfterUpdate).not.toHaveBeenCalled();
  });

  it('retains the transaction when the old state cannot be restored', async () => {
    const f = fixture({ performBackup: true });
    f.backups.backupApp.mockRejectedValueOnce(new Error('Backup failed'));
    f.transaction.restoreMetadata.mockRejectedValueOnce(new Error(expectedRecovery));
    expect(await f.command.execute(appUrn, {})).toEqual({ success: false, message: expectedRecovery });
    expect(f.containers[0]?.container.start).not.toHaveBeenCalled();
  });
});

describe('target app settings', () => {
  it('validates before pulling or stopping the current app', async () => {
    const f = fixture();
    f.validation.validateUpdateConfigSettings.mockRejectedValue(new Error('Target settings are not compatible.'));
    expect(await f.command.execute(appUrn, {})).toMatchObject({ success: false, statePreserved: true });
    expect(f.helpers.renderAppEnv).not.toHaveBeenCalled();
    expect(f.plan.pull).not.toHaveBeenCalled();
    expect(f.containers[0]?.container.stop).not.toHaveBeenCalled();
    expect(f.transaction.publishTarget).not.toHaveBeenCalled();
    expect(f.apps.updateAppById).not.toHaveBeenCalled();
  });

  it('uses and saves the target exposure settings without changing the saved request', async () => {
    const f = fixture();
    f.files.getInstalledAppInfo.mockResolvedValue(createMockAppInfo({ tipi_version: 2, exposable: false, port: 8090 }));
    const validator = new AppValidationService(f.apps, mock<ConfigurationService>(), mock<LoggerService>());
    f.validation.validateUpdateConfigSettings.mockImplementation((...args) => validator.validateUpdateConfigSettings(...args));
    const form = { exposed: true, exposedLocal: true, enableAuth: true, domain: 'example.test', openPort: false, EXTRA: 'keep' };
    const original = structuredClone(form);
    expect((await f.command.execute(appUrn, form)).success).toBe(true);
    const rendered = f.helpers.renderAppEnv.mock.lastCall?.[2];
    expect(rendered).toMatchObject({ exposed: false, exposedLocal: false, enableAuth: false, EXTRA: 'keep' });
    expect(rendered?.domain).toBeUndefined();
    expect(f.current()).toMatchObject({
      exposed: false,
      exposedLocal: false,
      enableAuth: false,
      domain: null,
      port: 8090,
      config: { exposed: false, exposedLocal: false, enableAuth: false, EXTRA: 'keep' },
    });
    expect(form).toEqual(original);
  });
});
