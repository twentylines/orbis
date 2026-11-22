import { readOrdinaryUpdateResult } from '../app-lifecycle/update-result';
import { activeAppServices } from './app-compose-profiles';
import { readComposeServiceHashes } from './app-compose-hashes';
import { APP_GENERATED_COMPOSE_FILENAME } from '@/common/constants';
import { appComposeEnvironment } from './app-compose-environment';
import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import * as Sentry from '@sentry/nestjs';
import type Dockerode from 'dockerode';
import { parse } from 'yaml';
import {
  type AppImagePinInput,
  type AppImagePinUpdate,
  type PulledUpdateImages,
  STAGED_UPDATE_DEFAULT_PLATFORM,
  beginAppImagePinUpdate,
  readStagedAppUpdate,
  requireAppImagePinUpdate,
  requireNoAppImagePinUpdates,
  requireStagedAppUpdateActivation,
  appImagePinSourceSha256,
  readAppImagePins,
  writeAppImagePins,
  removeAppImagePins,
  withStagedUpdateOverrides,
  appUpdateStorage,
} from './app-image-pins';
import { readAppVolumeAuthority } from './app-volume-authority';
import { AppUpdateStage, type AppUpdateStageInput } from './app-update-stage';
import { migrationEngineRequest, migrationRecord } from './app-migration-engine';
import { prepareAppVolumeInvocation, prepareFrozenUpdateInvocation, readEffectiveAppCompose } from './app-volume-invocation';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';

export type RestoreComposeStart = <T>(effect: () => T) => Promise<T>;
type AppComposeOptions = { imagePins?: 'explicit-update'; imagePinUpdate?: string; signal?: AbortSignal; restoreStart?: RestoreComposeStart };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digestReference = /^[^@\s]+@sha256:[a-f0-9]{64}$/;
const localImageId = /^sha256:[a-f0-9]{64}$/;
const updateImageError = () => new Error('Every staged app service requires a pullable image with a verifiable immutable identity.');

function updateAuthorityHash(value: unknown) {
  const bytes = JSON.stringify(value, (_key, entry) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
  if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw updateImageError();
  return createHash('sha256').update(bytes).digest('hex');
}

function capturePullConfiguration(effective: unknown, project: string, appUrn: AppUrn, transactionId: string, savedImages?: Record<string, string>) {
  if (!record(effective) || effective.name !== project || !record(effective.services) || effective.include !== undefined) throw updateImageError();
  const { [STAGED_UPDATE_DEFAULT_PLATFORM]: defaultPlatform = '', services, ...configuration } = effective;
  const entries = Object.entries(services);
  if (entries.length === 0 || entries.length > 256) throw updateImageError();
  if (savedImages && Object.keys(savedImages).sort().join('\0') !== Object.keys(services).sort().join('\0')) throw updateImageError();
  const requests = new Map<string, string>();
  const servicesToPull = entries.map(([name, service]) => {
    if (
      !record(service) ||
      typeof service.image !== 'string' ||
      (savedImages ? !localImageId.test(savedImages[name] ?? '') : !digestReference.test(service.image)) ||
      service.build !== undefined ||
      service.provider !== undefined ||
      service.env_file !== undefined ||
      service.label_file !== undefined ||
      service.extends !== undefined ||
      (Array.isArray(service.volumes) && service.volumes.some((volume) => record(volume) && volume.type === 'image'))
    )
      throw updateImageError();
    if (!record(service.labels) || service.labels['runtipi.managed'] !== 'true' || service.labels['runtipi.appurn'] !== appUrn)
      throw new Error('The staged Compose services do not have the required app ownership labels.');
    const platform = service.platform || defaultPlatform;
    if (typeof platform !== 'string' || (platform && !/^[a-z0-9_-]+\/[a-z0-9_-]+(?:\/[a-z0-9_.-]+)?$/.test(platform))) throw updateImageError();
    const requested = requests.get(service.image);
    // Compose pulls each distinct image reference once, regardless of platform.
    if (!savedImages && requested !== undefined && requested !== platform) throw updateImageError();
    if (!savedImages) requests.set(service.image, platform);
    return [
      name,
      {
        ...service,
        labels: { ...service.labels, 'io.orbis.app-update.stage': transactionId },
        image: savedImages?.[name] ?? service.image,
        ...(platform ? { platform } : {}),
      },
    ] as const;
  });
  return { configuration, servicesToPull, requests };
}

async function inspectPulledImages(docker: Pick<Dockerode, 'getImage'>, requests: Map<string, string>, signal?: AbortSignal) {
  const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  return new Map(
    await Promise.all(
      Array.from(requests, async ([reference, platform]) => {
        const [os, architecture, variant] = platform.split('/');
        const options: Dockerode.ImageInspectOptions & { abortSignal: AbortSignal; platform?: string } = { abortSignal };
        if (platform) options.platform = JSON.stringify({ os, architecture, ...(variant ? { variant } : {}) });
        const image = await docker
          .getImage(reference)
          .inspect(options)
          .catch(() => {
            throw updateImageError();
          });
        const defaultVariant = architecture === 'arm64' ? 'v8' : architecture === 'amd64' ? 'v1' : undefined;
        if (
          !image ||
          !localImageId.test(image.Id) ||
          (platform && (image.Os !== os || image.Architecture !== architecture || (variant && (image.Variant || defaultVariant) !== variant)))
        )
          throw updateImageError();
        return [reference, image.Id] as const;
      }),
    ),
  );
}

@Injectable()
export class DockerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    private readonly appsService: AppsService,
  ) {}

  private imagePinDirectory() {
    return path.join(this.config.get('directories').dataDir, 'state', 'time-machine', 'image-pins');
  }

  public async getAppImagePinSource(appUrn: AppUrn, transactionId?: string) {
    await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    const { app } = await this.appsService.getApp(appUrn);
    const source = await this.appFilesManager.getSourceDockerComposeYaml(appUrn);
    const user = await this.appFilesManager.getUserComposeFile(appUrn);
    return {
      appUrn,
      project: appUrn.replace(':', '_'),
      sourceSha256: appImagePinSourceSha256(source.content, (app?.userConfigEnabled ?? true) ? user.content : null),
    };
  }

  private async requirePinnedServices(appUrn: AppUrn, services: Record<string, string>) {
    const generated = await this.appFilesManager.getGeneratedDockerComposeYaml(appUrn);
    const user = await this.appFilesManager.getUserComposeFile(appUrn);
    const { app } = await this.appsService.getApp(appUrn);
    const expected = new Set<string>();
    for (const content of [generated.content, (app?.userConfigEnabled ?? true) ? user.content : null]) {
      if (!content) continue;
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Retained app Compose exceeds its size limit.');
      const document = parse(content);
      if (
        !document ||
        typeof document !== 'object' ||
        document.include !== undefined ||
        (document.services !== undefined && (document.services === null || typeof document.services !== 'object' || Array.isArray(document.services)))
      )
        throw new Error('Retained app services could not be verified.');
      for (const name of Object.keys(document.services ?? {})) expected.add(name);
    }
    if (!expected.size || [...expected].sort().join('\0') !== Object.keys(services).sort().join('\0'))
      throw new Error('Retained images do not cover this app configuration.');
  }

  public async readAppImagePins(appUrn: AppUrn, transactionId?: string) {
    await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    const stored = await readAppImagePins(this.imagePinDirectory(), { appUrn, project: appUrn.replace(':', '_') });
    if (!stored) return null;
    const source = await this.getAppImagePinSource(appUrn, transactionId);
    if (stored.pins.sourceSha256 !== source.sourceSha256) throw new Error('App configuration differs from its retained image pins.');
    await this.requirePinnedServices(appUrn, stored.pins.services);
    return stored;
  }

  public async writeAppImagePins(appUrn: AppUrn, input: AppImagePinInput) {
    await this.requirePinnedServices(appUrn, input.services);
    return writeAppImagePins(this.imagePinDirectory(), await this.getAppImagePinSource(appUrn), input);
  }

  public readAppImageUpdateGuard(appUrn: AppUrn) {
    return appUpdateStorage.updateGuard(this.imagePinDirectory(), appUrn);
  }

  public requireAppImagePinUpdate(appUrn: AppUrn, transactionId?: string) {
    return requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
  }

  public requireNoPendingAppImageUpdates() {
    return requireNoAppImagePinUpdates(this.imagePinDirectory());
  }

  /** Retire only this deployment's active pins after a successful, guarded uninstall. Backup inventories are separate. */
  public async prepareAppUninstallCleanup(appUrn: AppUrn) {
    await this.requireAppImagePinUpdate(appUrn);
    const retained = await this.readAppImagePins(appUrn);
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const directory = this.imagePinDirectory();
    return async () => {
      await this.requireAppImagePinUpdate(appUrn);
      for (const target of [appInstalledDir, appDataDir]) {
        try {
          await fs.lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        throw new Error('App files remain after uninstall. Retained images were preserved.');
      }
      const current = await readAppImagePins(directory, { appUrn, project: appUrn.replace(':', '_') });
      if (JSON.stringify(current?.pins ?? null) !== JSON.stringify(retained?.pins ?? null))
        throw new Error('App image records changed during uninstall. Retained images were preserved.');
      await removeAppImagePins(directory, appUrn);
    };
  }

  public async beginRetainedAppImageUpdate(appUrn: AppUrn): Promise<AppImagePinUpdate> {
    if (!(await this.readAppImagePins(appUrn))) throw new Error('This app has no retained image pins.');
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    return beginAppImagePinUpdate(this.imagePinDirectory(), appUrn, appInstalledDir, path.join(appDataDir, 'app.env'));
  }

  public async beginStagedAppUpdate(appUrn: AppUrn, requestId?: string, freshPreparation?: AppUpdateStageInput['freshPreparation']) {
    if (freshPreparation && !requestId) throw updateImageError();
    const retained = Boolean(await this.readAppImagePins(appUrn));
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const transaction = requestId
      ? await AppUpdateStage.create({
          directory: this.imagePinDirectory(),
          appUrn,
          metadata: appInstalledDir,
          env: path.join(appDataDir, 'app.env'),
          requestId,
          ...(freshPreparation ? { freshPreparation } : {}),
        })
      : await beginAppImagePinUpdate(this.imagePinDirectory(), appUrn, appInstalledDir, path.join(appDataDir, 'app.env'), true);
    return { transaction, retained };
  }

  public async reopenStagedAppUpdate(appUrn: AppUrn, requestId: string, stageId?: string) {
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const transaction = await AppUpdateStage.open({
      directory: this.imagePinDirectory(),
      appUrn,
      metadata: appInstalledDir,
      env: path.join(appDataDir, 'app.env'),
      requestId,
      stageId,
    });
    return { transaction, retained: (await transaction.read()).retainedPinsSha256 !== null };
  }

  private async readUpdateOverrides(appUrn: AppUrn) {
    const app = await this.appsService.getInstalledApp(appUrn);
    if (!app) throw new Error('The app configuration could not be read for update.');
    const enabled = app.userConfigEnabled ?? true;
    const [compose, env, volumes] = await Promise.all([
      this.appFilesManager.getUserComposeFile(appUrn),
      this.appFilesManager.getUserEnv(appUrn),
      readAppVolumeAuthority(this.config.get('directories').dataDir, { appUrn, project: appUrn.replace(':', '_') }),
    ]);
    return { id: app.id, enabled, compose: enabled ? compose.content : null, env: enabled ? env.content : null, volumes };
  }

  public async prepareExistingBaselineConfiguration(appUrn: AppUrn, stage: AppUpdateStage, markers: Record<string, string>) {
    const source = await stage.readOriginalBaseline();
    const original = await this.readUpdateOverrides(appUrn);
    const authoritySha256 = updateAuthorityHash(original);
    const project = appUrn.replace(':', '_');
    return stage.withOverrides(original, async (view) => {
      const args = [
        '--profile',
        '*',
        '--project-name',
        project,
        '--project-directory',
        source.projectDirectory,
        '--env-file',
        source.env,
        '--file',
        path.join(source.metadata, APP_GENERATED_COMPOSE_FILENAME),
      ];
      if (view.env) args.push('--env-file', view.env);
      if (view.compose) args.push('--file', view.compose);
      if (source.imagePins) args.push('--file', source.imagePins);
      const effective = await readEffectiveAppCompose(args, undefined, { localSocket: true });
      if (!record(effective) || !record(effective.services) || effective.name !== project) throw updateImageError();
      for (const [name, marker] of Object.entries(markers)) {
        const selected = effective.services[name];
        if (!record(selected) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(marker)) throw updateImageError();
        if (selected.labels !== undefined && !record(selected.labels)) throw updateImageError();
        selected.labels = { ...(record(selected.labels) ? selected.labels : {}), 'io.orbis.app-update.stage': marker };
      }
      const app = dotenv.parse(await appUpdateStorage.readOwned(source.env, 1024 * 1024));
      const user = view.env ? dotenv.parse(await appUpdateStorage.readOwned(view.env, 1024 * 1024)) : {};
      const profiles = (user.COMPOSE_PROFILES ?? app.COMPOSE_PROFILES ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const activeServices = activeAppServices(effective, profiles);
      const frozen = await prepareFrozenUpdateInvocation({
        effective,
        pins: original.volumes?.pins,
        project,
        projectDirectory: source.projectDirectory,
        directory: path.join(this.config.get('directories').dataDir, 'state', 'app-volume-invocations'),
      });
      try {
        const serviceHashes = await readComposeServiceHashes(['--env-file', '/dev/null', '--profile', '*', ...frozen.args], frozen.fd);
        if (updateAuthorityHash(await this.readUpdateOverrides(appUrn)) !== authoritySha256) throw updateImageError();
        return { authoritySha256, configurationSha256: frozen.sha256, activeServices, serviceHashes };
      } finally {
        await frozen.release();
      }
    });
  }

  public async verifyExistingBaselineInputs(appUrn: AppUrn, authoritySha256: string) {
    if (updateAuthorityHash(await this.readUpdateOverrides(appUrn)) !== authoritySha256) throw updateImageError();
  }

  public async verifyFreshInstallInputs(appUrn: AppUrn, stage: AppUpdateStage) {
    const state = await stage.verifyFreshInstall();
    if (state.appUrn !== appUrn || updateAuthorityHash(await this.readUpdateOverrides(appUrn)) !== state.context?.authoritySha256)
      throw updateImageError();
  }

  public async prepareStagedAppUpdate(
    appUrn: AppUrn,
    transactionId: string,
    docker: Pick<Dockerode, 'getImage'>,
    options?: { freshInstall?: true; stage?: AppUpdateStage; signal?: AbortSignal },
  ) {
    options?.signal?.throwIfAborted();
    const pinDirectory = this.imagePinDirectory();
    const staged = await readStagedAppUpdate(pinDirectory, appUrn, transactionId);
    const project = appUrn.replace(':', '_');
    const original = await this.readUpdateOverrides(appUrn);
    const inputsSha256 = updateAuthorityHash(original);
    const isCurrent = async () => JSON.stringify(await this.readUpdateOverrides(appUrn)) === JSON.stringify(original);
    let freshProfiles: string[] = [];
    const saved = options?.stage ? (await options.stage.read()).freshPreparation?.pullPlan : undefined;
    if (options?.stage && (options.stage.id !== transactionId || (await options.stage.read()).appUrn !== appUrn)) throw updateImageError();
    if (saved && (!options?.freshInstall || saved.authoritySha256 !== inputsSha256)) throw updateImageError();
    const effective = saved
      ? structuredClone(saved.configuration)
      : await withStagedUpdateOverrides(pinDirectory, appUrn, transactionId, original, async (override) => {
          if (options?.freshInstall) {
            const app = dotenv.parse(await appUpdateStorage.readOwned(staged.env, 1024 * 1024));
            const user = override.env ? dotenv.parse(await appUpdateStorage.readOwned(override.env, 1024 * 1024)) : {};
            freshProfiles = (user.COMPOSE_PROFILES ?? app.COMPOSE_PROFILES ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean);
          }
          const args = ['--project-name', project, '--project-directory', staged.target, '--env-file', staged.env, '--file', staged.compose];
          if (override.env) args.push('--env-file', override.env);
          if (override.compose) args.push('--file', override.compose);
          args.push('--file', override.platform);
          return readEffectiveAppCompose(args, options?.signal, {
            keepRelativePaths: true,
            resolveImageDigests: true,
            ...(options?.freshInstall ? { localSocket: true as const } : {}),
          });
        });
    if (options?.freshInstall && !saved) {
      if (!record(effective)) throw updateImageError();
      effective['x-orbis-fresh-active-services'] = activeAppServices(effective, freshProfiles);
    }
    const { configuration, servicesToPull, requests } = capturePullConfiguration(effective, project, appUrn, transactionId);
    const directory = path.join(this.config.get('directories').dataDir, 'state', 'app-volume-invocations');
    const invocation = (services: Record<string, unknown>, projectDirectory: string) =>
      prepareFrozenUpdateInvocation({
        effective: { ...configuration, services },
        pins: original.volumes?.pins,
        project,
        projectDirectory,
        directory,
      });
    const pull = await invocation(Object.fromEntries(servicesToPull), staged.target);
    const installed = this.appFilesManager.getAppPaths(appUrn).appInstalledDir;
    const args = (plan: Awaited<ReturnType<typeof invocation>>, ...commands: string[]) => [
      '--env-file',
      '/dev/null',
      '--profile',
      '*',
      ...plan.args,
      ...commands,
    ];
    let pullingStarted = false;
    let prepared: { plan: Awaited<ReturnType<typeof invocation>>; binding: PulledUpdateImages; effective: Record<string, unknown> } | undefined;
    let freshCreateIssued = false;
    return {
      inputsSha256,
      release: async () => {
        await Promise.allSettled([pull.release(), prepared?.plan.release()]);
      },
      isCurrent,
      freshPullConfiguration: async () => {
        if (!options?.freshInstall || !(await isCurrent())) throw updateImageError();
        return structuredClone({ ...configuration, services: Object.fromEntries(servicesToPull) });
      },
      pull: async () => {
        options?.signal?.throwIfAborted();
        if (pullingStarted) throw updateImageError();
        pullingStarted = true;
        try {
          await readStagedAppUpdate(pinDirectory, appUrn, transactionId);
          await this.runCompose(args(pull, 'pull', '--policy', 'always'), {
            fd: pull.fd,
            privateOperation: 'pull',
            localSocket: options?.freshInstall,
            signal: options?.signal,
          });
          const ids = await inspectPulledImages(docker, requests, options?.signal);
          options?.signal?.throwIfAborted();
          const servicesToActivate = servicesToPull.map(([name, service]) => {
            const image = ids.get(service.image);
            if (!image) throw updateImageError();
            return [name, { ...service, image }] as const;
          });
          const plan = await invocation(Object.fromEntries(servicesToActivate), installed);
          const binding = {
            activationSha256: plan.sha256,
            imageIds: Object.fromEntries(servicesToActivate.map(([name, value]) => [name, value.image])),
          };
          prepared = { plan, binding, effective: { ...configuration, services: Object.fromEntries(servicesToActivate) } };
          return binding;
        } finally {
          await pull.release().catch(() => undefined);
        }
      },
      freshConfiguration: async () => {
        if (!prepared || !options?.freshInstall || original.volumes || !(await isCurrent())) throw updateImageError();
        if (createHash('sha256').update(JSON.stringify(prepared.effective)).digest('hex') !== prepared.binding.activationSha256)
          throw updateImageError();
        return structuredClone(prepared.effective);
      },
      createFresh: async (stage: AppUpdateStage) => {
        if (
          !prepared ||
          !options?.freshInstall ||
          freshCreateIssued ||
          original.volumes ||
          !(stage instanceof AppUpdateStage) ||
          stage.id !== transactionId ||
          !(await isCurrent())
        )
          throw updateImageError();
        const state = await stage.read();
        if (
          state.phase !== 'prepared' ||
          state.context?.purpose !== 'fresh-install' ||
          state.freshInstall?.phase !== 'allocating' ||
          state.freshInstall.createAttempted
        )
          throw updateImageError();
        await stage.readTarget();
        await stage.freshCreationAttempted();
        freshCreateIssued = true;
        await this.runCompose(args(prepared.plan, 'create', '--no-build', '--pull', 'never'), {
          fd: prepared.plan.fd,
          privateOperation: 'activate',
          localSocket: options?.freshInstall,
        });
      },
      activate: async () => {
        if (!prepared) throw updateImageError();
        await requireStagedAppUpdateActivation(pinDirectory, appUrn, transactionId, prepared.binding);
        const { plan, binding } = prepared;
        const activeServices = freshCreateIssued ? prepared.effective['x-orbis-fresh-active-services'] : undefined;
        if (
          freshCreateIssued &&
          (!Array.isArray(activeServices) ||
            !activeServices.length ||
            activeServices.some((name) => typeof name !== 'string' || !Object.hasOwn(binding.imageIds, name)))
        )
          throw updateImageError();
        const activationArgs = args(
          plan,
          'up',
          '--detach',
          '--wait',
          '--wait-timeout',
          '120',
          ...(freshCreateIssued ? ['--no-recreate'] : ['--force-recreate', '--remove-orphans']),
          '--no-build',
          '--pull',
          'never',
          ...(Array.isArray(activeServices) ? activeServices : []),
        );
        await this.runCompose(activationArgs, { fd: plan.fd, privateOperation: 'activate', localSocket: options?.freshInstall });
      },
    };
  }

  /** Only explicit staged app/user values enter migration interpolation; the core process environment is never copied. */
  public async readAppUpdateMigrationInputs(appUrn: AppUrn, stage: AppUpdateStage, pendingIds: readonly string[]) {
    const state = await stage.read();
    const original = await this.readUpdateOverrides(appUrn);
    if (state.appUrn !== appUrn || !state.context || state.context.authoritySha256 !== updateAuthorityHash(original)) throw updateImageError();
    const selected = await stage.withOverrides(original, async (view) => {
      const environment = {
        ...dotenv.parse(await appUpdateStorage.readOwned(view.targetEnv, 1024 * 1024)),
        ...(view.env ? dotenv.parse(await appUpdateStorage.readOwned(view.env, 1024 * 1024)) : {}),
      };
      const sources = await this.appFilesManager.getAppMigrations(appUrn, view.target, pendingIds);
      return { environment, sources };
    });
    if (state.context.authoritySha256 !== updateAuthorityHash(await this.readUpdateOverrides(appUrn))) throw updateImageError();
    return selected;
  }

  public async prepareResumedAppUpdate(appUrn: AppUrn, stage: AppUpdateStage, docker: Pick<Dockerode, 'modem'>, options?: { freshInstall: true }) {
    const state = await stage.read();
    if (
      state.appUrn !== appUrn ||
      !state.pulledImages ||
      !state.context ||
      (state.context.purpose === 'fresh-install') !== (options?.freshInstall === true) ||
      !['target-ready', 'switching', 'prepared', 'activation-attempted'].includes(state.phase)
    )
      throw updateImageError();
    const original = await this.readUpdateOverrides(appUrn);
    if ((options?.freshInstall && original.volumes) || updateAuthorityHash(original) !== state.context.authoritySha256) throw updateImageError();
    const project = appUrn.replace(':', '_');
    const effective = await stage.withOverrides(original, async (view) => {
      const args = ['--project-name', project, '--project-directory', view.target, '--env-file', view.targetEnv, '--file', view.targetCompose];
      if (view.env) args.push('--env-file', view.env);
      if (view.compose) args.push('--file', view.compose);
      args.push('--file', view.platform);
      // Saved per-service IDs replace refs below. A retry never resolves a newer registry tag.
      const configuration = await readEffectiveAppCompose(args, undefined, {
        keepRelativePaths: true,
        ...(options?.freshInstall ? { localSocket: true as const } : {}),
      });
      if (options?.freshInstall) {
        if (!record(configuration)) throw updateImageError();
        const app = dotenv.parse(await appUpdateStorage.readOwned(view.targetEnv, 1024 * 1024));
        const user = view.env ? dotenv.parse(await appUpdateStorage.readOwned(view.env, 1024 * 1024)) : {};
        const profiles = (user.COMPOSE_PROFILES ?? app.COMPOSE_PROFILES ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        configuration['x-orbis-fresh-active-services'] = activeAppServices(configuration, profiles);
      }
      return configuration;
    });
    const { configuration, servicesToPull } = capturePullConfiguration(effective, project, appUrn, state.id, state.pulledImages.imageIds);
    const signal = AbortSignal.timeout(30_000);
    for (const [, service] of servicesToPull) {
      const inspected = await migrationEngineRequest(docker, `/images/${service.image}/json`, 'GET', {}, signal);
      const platform = typeof service.platform === 'string' ? service.platform : '';
      const [os, architecture, variant] = platform.split('/');
      if (
        !migrationRecord(inspected) ||
        Buffer.byteLength(JSON.stringify(inspected)) > 2 * 1024 * 1024 ||
        inspected.Id !== service.image ||
        typeof inspected.Os !== 'string' ||
        typeof inspected.Architecture !== 'string' ||
        (platform &&
          (inspected.Os !== os ||
            inspected.Architecture !== architecture ||
            (variant && (inspected.Variant || (architecture === 'arm64' ? 'v8' : architecture === 'amd64' ? 'v1' : '')) !== variant)))
      )
        throw updateImageError();
    }
    const installed = this.appFilesManager.getAppPaths(appUrn).appInstalledDir;
    const invocation = await prepareFrozenUpdateInvocation({
      effective: { ...configuration, services: Object.fromEntries(servicesToPull) },
      pins: original.volumes?.pins,
      project,
      projectDirectory: installed,
      directory: path.join(this.config.get('directories').dataDir, 'state', 'app-volume-invocations'),
    });
    if (invocation.sha256 !== state.pulledImages.activationSha256) {
      await invocation.release();
      throw updateImageError();
    }
    const isCurrent = async () => updateAuthorityHash(await this.readUpdateOverrides(appUrn)) === state.context?.authoritySha256;
    let activationIssued = false;
    let createIssued = false;
    const frozen: Record<string, unknown> = { ...configuration, services: Object.fromEntries(servicesToPull) };
    const args = (...commands: string[]) => ['--env-file', '/dev/null', '--profile', '*', ...invocation.args, ...commands];
    return {
      inputsSha256: state.context.authoritySha256,
      binding: structuredClone(state.pulledImages),
      isCurrent,
      release: invocation.release,
      freshConfiguration: async () => {
        if (!options?.freshInstall || !(await isCurrent())) throw updateImageError();
        return structuredClone(frozen);
      },
      createFresh: async (selected: AppUpdateStage) => {
        if (!options?.freshInstall || createIssued || selected !== stage || !(await isCurrent())) throw updateImageError();
        const current = await stage.verifyFreshInstall();
        if (
          current.phase !== 'prepared' ||
          current.freshInstall?.phase !== 'allocating' ||
          current.freshInstall.createAttempted ||
          (current.freshInstall.seed !== undefined && current.freshInstall.seed !== 'ready')
        )
          throw updateImageError();
        await stage.freshCreationAttempted();
        createIssued = true;
        await this.runCompose(args('create', '--no-build', '--pull', 'never'), {
          fd: invocation.fd,
          privateOperation: 'activate',
          localSocket: true,
        });
      },
      activate: async () => {
        if (activationIssued) throw updateImageError();
        activationIssued = true;
        if (!(await isCurrent())) throw updateImageError();
        await requireStagedAppUpdateActivation(this.imagePinDirectory(), appUrn, state.id, state.pulledImages as PulledUpdateImages);
        const active = options?.freshInstall ? frozen['x-orbis-fresh-active-services'] : undefined;
        if (
          options?.freshInstall &&
          (!Array.isArray(active) ||
            !active.length ||
            active.some((name) => typeof name !== 'string' || !Object.hasOwn(state.pulledImages?.imageIds ?? {}, name)))
        )
          throw updateImageError();
        await this.runCompose(
          args(
            'up',
            '--detach',
            '--wait',
            '--wait-timeout',
            '120',
            ...(options?.freshInstall ? ['--no-recreate'] : ['--force-recreate', '--remove-orphans']),
            '--no-build',
            '--pull',
            'never',
            ...(Array.isArray(active) ? active : []),
          ),
          { fd: invocation.fd, privateOperation: 'activate', ...(options?.freshInstall ? { localSocket: true as const } : {}) },
        );
      },
    };
  }

  /** Only exposes a retained completion intent after positive absence of the active app barrier. SQL still has to confirm it. */
  public async readCompletedOrdinaryAppUpdate(appUrn: AppUrn, requestId: string) {
    if (await this.readAppImageUpdateGuard(appUrn)) return;
    return readOrdinaryUpdateResult(this.imagePinDirectory(), appUrn, requestId);
  }

  public async retireAppImagePinsAfterUpdate(appUrn: AppUrn, transactionId: string) {
    const guard = await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    if (guard?.phase !== 'committing') throw new Error('Retained app update has not committed.');
    await removeAppImagePins(this.imagePinDirectory(), appUrn);
  }

  /**
   * Get the base compose args for an app
   * @param {string} appUrn - App name
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn, options?: AppComposeOptions) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    const { app } = await this.appsService.getApp(appUrn);
    const userConfigEnabled = app?.userConfigEnabled ?? true;

    // User custom env file
    const userEnvFile = await this.appFilesManager.getUserEnv(appUrn);
    if (userEnvFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--env-file', userEnvFile.path);
    }

    args.push('--project-name', appUrn.replace(':', '_'));

    const composeFile = await this.appFilesManager.getGeneratedDockerComposeYaml(appUrn);
    args.push('-f', composeFile.path);

    // User defined overrides
    const userComposeFile = await this.appFilesManager.getUserComposeFile(appUrn);
    if (userComposeFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--file', userComposeFile.path);
    }

    const guard = await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, options?.imagePinUpdate);
    if (options?.imagePins === 'explicit-update' && !guard) throw new Error('Explicit image replacement needs a retained app update transaction.');
    const retained = options?.imagePins === 'explicit-update' ? null : await this.readAppImagePins(appUrn, options?.imagePinUpdate);
    if (retained) args.push('--file', retained.path);
    const volumes = await readAppVolumeAuthority(this.config.get('directories').dataDir, {
      appUrn,
      project: appUrn.replace(':', '_'),
    });
    return { args, isCustomConfig, retainedImages: Boolean(retained), volumePins: volumes?.pins, projectDirectory: path.dirname(composeFile.path) };
  };

  private async prepareVolumeInvocation(base: Awaited<ReturnType<DockerService['getBaseComposeArgsApp']>>, signal?: AbortSignal) {
    if (!base.volumePins) return undefined;
    signal?.throwIfAborted();
    const effective = await readEffectiveAppCompose(base.args, signal);
    signal?.throwIfAborted();
    return prepareAppVolumeInvocation({
      effective,
      pins: base.volumePins,
      projectDirectory: base.projectDirectory,
      directory: path.join(this.config.get('directories').dataDir, 'state', 'app-volume-invocations'),
    });
  }

  public getBaseComposeArgsRuntipi = async () => {
    const { dataDir } = this.config.get('directories');
    const args: string[] = ['--env-file', path.join(dataDir, '.env')];

    args.push('--project-name', 'runtipi');

    const composeFile = path.join(dataDir, 'docker-compose.yml');
    args.push('-f', composeFile);

    // User defined overrides
    const userComposeFile = path.join(dataDir, 'user-config', 'tipi-compose.yml');
    if (await this.filesystem.isFile(userComposeFile)) {
      args.push('--file', userComposeFile);
    }

    return { args };
  };

  /**
   * Helpers to execute docker compose commands
   * @param {string} appUrn - App name
   * @param {string} command - Command to execute
   */
  public async composeApp(appUrn: AppUrn, command: string, options?: AppComposeOptions) {
    const base = await this.getBaseComposeArgsApp(appUrn, options);
    const { args, isCustomConfig, retainedImages } = base;
    const operation = command.split(' ').filter(Boolean);
    if (retainedImages) {
      if (operation[0] === 'pull' || operation[0] === 'build' || operation[0] === 'run' || operation.some((part) => part === '--build'))
        throw new Error('Explicitly update this app before replacing its retained images.');
      for (let index = operation.length - 1; index >= 0; index--) {
        if (operation[index] === '--pull' || operation[index] === '--rmi') operation.splice(index, 2);
        else if (operation[index]?.startsWith('--pull=') || operation[index]?.startsWith('--rmi=')) operation.splice(index, 1);
      }
      if (operation[0] === 'up' || operation[0] === 'create') {
        if (!operation.includes('--no-build')) operation.push('--no-build');
        operation.push('--pull', 'never');
      }
    }
    const frozen = await this.prepareVolumeInvocation(base, options?.signal);
    try {
      return await this.runCompose([...(frozen?.args ?? args), ...operation], {
        fd: frozen?.fd,
        signal: options?.signal,
        isCustomConfig,
        appEnvironment: true,
        restoreStart: options?.restoreStart,
      });
    } finally {
      await frozen?.release();
    }
  }

  private async runCompose(
    rawArgs: string[],
    options: {
      fd?: number;
      signal?: AbortSignal;
      isCustomConfig?: boolean;
      privateOperation?: 'pull' | 'activate';
      restoreStart?: RestoreComposeStart;
      restoreSocket?: true;
      appEnvironment?: true;
      localSocket?: true;
    },
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    if (options.restoreStart) {
      const { restoreStart, ...launchOptions } = options;
      return restoreStart(() => this.runCompose(rawArgs, { ...launchOptions, restoreSocket: true }));
    }
    const args = rawArgs.filter(Boolean);
    this.logger.info(
      options.privateOperation ? `Running frozen app update ${options.privateOperation}` : `Running docker compose with args ${args.join(' ')}`,
    );
    options.signal?.throwIfAborted();
    const scoped = options.appEnvironment || options.fd !== undefined || options.privateOperation || options.restoreSocket;
    const env = scoped
      ? appComposeEnvironment(Boolean(options.restoreSocket || options.localSocket || (options.fd !== undefined && !options.privateOperation)))
      : undefined;
    const spawnOptions: SpawnOptions = options.fd === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe', options.fd] };
    const cmd = env
      ? spawn('docker-compose', args, { ...spawnOptions, env })
      : options.fd === undefined
        ? spawn('docker-compose', args)
        : spawn('docker-compose', args, spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        cmd.kill('SIGTERM');
        escalation = setTimeout(() => cmd.kill('SIGKILL'), 5000);
        escalation.unref();
      };
      const cleanup = () => {
        options.signal?.removeEventListener('abort', abort);
        if (escalation) clearTimeout(escalation);
      };
      const receive = (output: Buffer[]) => (data: unknown) => {
        if (options.privateOperation) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (!args.includes('config')) this.logger.debug(`docker-compose: ${chunk.toString().trim()}`);
        output.push(chunk);
      };
      cmd.stdout?.on('data', receive(stdout));
      cmd.stderr?.on('data', receive(stderr));
      cmd.once('error', (error) => {
        cleanup();
        reject(error);
      });
      cmd.once('close', (code) => {
        cleanup();
        if (options.signal?.aborted) reject(options.signal.reason);
        else resolve(code);
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });

    if (exitCode !== 0) {
      if (options.privateOperation === 'pull') throw new Error('Docker Compose could not pull the staged app images.');
      if (options.privateOperation === 'activate') throw new Error('Docker Compose could not activate the staged app.');
      this.logger.info(`Docker-compose exited with code ${exitCode}`);
      if (options.isCustomConfig) this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
      throw new Error(Buffer.concat(stderr).toString().trim());
    }
    return { success: true, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  }

  public getLogsStream = async (maxLines: number, appUrn?: AppUrn) => {
    let frozen: Awaited<ReturnType<DockerService['prepareVolumeInvocation']>>;
    try {
      const base = appUrn ? await this.getBaseComposeArgsApp(appUrn) : undefined;
      frozen = base ? await this.prepareVolumeInvocation(base) : undefined;
      const args = frozen?.args ?? (base ?? (await this.getBaseComposeArgsRuntipi())).args;

      args.push('logs', '--follow', '-n', maxLines.toString());

      const logs = spawn('docker-compose', args, {
        ...(appUrn ? { env: appComposeEnvironment(Boolean(frozen)) } : {}),
        stdio: frozen ? ['pipe', 'pipe', 'pipe', frozen.fd] : 'pipe',
      });
      logs.once('close', () => {
        void frozen?.release();
      });

      logs.on('error', () => {
        logs.kill('SIGINT');
        void frozen?.release();
      });
      if (!logs.stdout) throw new Error('App log stream is unavailable.');

      return {
        on: logs.stdout.on.bind(logs.stdout),
        kill: () => logs.kill('SIGINT'),
      };
    } catch (error) {
      await frozen?.release();
      this.logger.error('Error getting log stream', error);
      Sentry.captureException(error, { tags: { source: 'docker log stream', appUrn } });
      throw new InternalServerErrorException('Error getting log stream');
    }
  };
}
