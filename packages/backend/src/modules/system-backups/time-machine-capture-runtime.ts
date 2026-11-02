import { CaptureFenceJournal, type CaptureFenceAttempt } from './time-machine-capture-fence';
import type { StoredTimeMachinePoint } from './time-machine-store';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { parse } from 'yaml';
import { type } from 'arktype';
import { convertLegacyToYaml, dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';
import { DOCKERODE } from '../docker/docker.module';
import { appImagePinSourceSha256 } from '../docker/app-image-pins';
import { HostUpdatesService } from '../host-updates/host-updates.service';
import type { ControllerConfigurationCapture } from '../host-updates/host-controller-config';
import {
  copyControllerPublicationExpectation,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from '../host-updates/host-controller-publication';
import { prepareTimeMachineImages, captureTimeMachineImages, type ImageCaptureDocker, type PreparedTimeMachineImages } from './backup-image-capture';
import { finalizeProtectedImageCaptureV2, prepareProtectedImageCaptureV2, type ProtectedImageCaptureV2 } from './backup-image-capture-v2';
import { retainedImageLimits } from './backup-image-retention';
import { parseFullBackupManifest } from './backup-import';
import type { LocalCapturePlan, LocalBackupSnapshot } from './system-backups.service';
import { privateBackupDirectory } from './backup-files';
import { runtimeImageBytesLimit, verifyCapturedControllerPublication, type CapturedRuntimeInput } from './time-machine-runtime-payload';
import { backupGcmPlaintextLimit } from './backup-crypto';
import { timeMachineConflict } from './time-machine-policy';

export const TIME_MACHINE_CAPTURE_FORMAT = 'TIME_MACHINE_CAPTURE_FORMAT';
export const TIME_MACHINE_CAPTURE_IMAGES = 'TIME_MACHINE_CAPTURE_IMAGES';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// The protected enrollment anchors the published index; a separate local image inspection supplies its source metadata.
export function controllerPublicationSource(
  configuration: ControllerConfigurationCapture,
  sourceImageId: string,
  inspected: unknown,
  architecture: string,
) {
  const controller = configuration.metadata.controller;
  if (
    !record(inspected) ||
    inspected.Id !== sourceImageId ||
    controller.imageId !== sourceImageId ||
    (configuration.metadata.version === 1 && (!Array.isArray(inspected.RepoDigests) || !inspected.RepoDigests.includes(controller.imageReference))) ||
    (configuration.metadata.version === 2 &&
      (controller.imageReference !== configuration.metadata.retainedIdentity.creationReference ||
        sourceImageId !== configuration.metadata.retainedIdentity.creationReference ||
        configuration.metadata.retainedIdentity.platform.architecture !== architecture)) ||
    !record(inspected.Labels) ||
    inspected.Os !== 'linux' ||
    inspected.Architecture !== architecture ||
    !['amd64', 'arm64'].includes(architecture)
  )
    throw new Error('Controller publication source is unavailable');
  const labels = inspected.Labels;
  if (
    labels['org.opencontainers.image.source'] !== 'https://github.com/twentylines/orbis' ||
    labels['org.opencontainers.image.version'] !== controller.releaseTag
  )
    throw new Error('Controller publication source changed');
  return copyControllerPublicationExpectation({
    configuration: configuration.metadata,
    publication: {
      schema: 'orbis.release.v1',
      image: 'ghcr.io/twentylines/orbis',
      tag: controller.releaseTag,
      digest: controller.releaseDigest,
      commit: labels['org.opencontainers.image.revision'] as string,
      runtipiCompatibility: '4.10.1',
      ...(labels['io.orbis.installation-protocol'] === undefined
        ? {}
        : {
            installationProtocol: labels['io.orbis.installation-protocol'] as 'orbis.installation-state.v1',
          }),
    },
    platform: {
      os: 'linux',
      architecture: architecture as 'amd64' | 'arm64',
      ...(inspected.Variant ? { variant: inspected.Variant as string } : {}),
    },
  });
}
async function readBounded(file: string, maximum: number, signal: AbortSignal, optional = false) {
  let handle: fs.FileHandle;
  try {
    if ((await fs.realpath(path.dirname(file))) !== path.resolve(path.dirname(file))) throw new Error('Unsafe capture source');
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error('Unsafe capture source');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - bytes));
      const part = await handle.read(buffer, 0, buffer.length, bytes);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
      if (bytes > maximum) throw new Error('Capture source exceeds its limit');
      chunks.push(buffer.subarray(0, part.bytesRead));
    }
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      bytes !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw new Error('Capture source changed');
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

@Injectable()
export class TimeMachineCaptureRuntime {
  private readonly selections = new WeakMap<
    object,
    { format: 3 | 4 | 6; capability?: Awaited<ReturnType<HostUpdatesService['requireV6CaptureCapability']>> }
  >();
  constructor(
    private readonly config: ConfigurationService,
    private readonly host: HostUpdatesService,
    private readonly apps: DockerService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    @Inject(TIME_MACHINE_CAPTURE_IMAGES) private readonly images: ImageCaptureDocker,
    @Optional() @Inject(TIME_MACHINE_CAPTURE_FORMAT) private readonly format: 3 | 4 | 6 = 4,
  ) {}

  async recoverCaptureFences(points: readonly StoredTimeMachinePoint[]) {
    const journals = new CaptureFenceJournal(this.config.get('directories').dataDir);
    for (const attempt of await journals.list()) {
      const point = points.find((value) => value.id === attempt.expected.configuration.pointId);
      if (
        !point ||
        point.version !== 2 ||
        (point.status === 'sealed' && point.configurationSetSha256 !== attempt.expected.configuration.configurationSetSha256)
      )
        throw new Error('Private capture fence point binding requires review.');
      await this.host.reconcileControllerCaptureFence(attempt.expected, attempt.receipt, attempt.clientKey);
      await journals.remove(attempt);
    }
  }

  async requireSupport(signal?: AbortSignal, requireV6 = false) {
    let format = this.format;
    let capability: Awaited<ReturnType<HostUpdatesService['requireV6CaptureCapability']>> | undefined;
    try {
      await this.host.requireControllerConfigurationSupport(signal);
      await this.host.requireControllerPublicationSupport(signal);
      await this.host.requireControllerCaptureFenceSupport(signal);
      if (format !== 3) {
        try {
          capability = await this.host.requireV6CaptureCapability(signal);
          format = 6;
        } catch (error) {
          if (requireV6 || format === 6 || !(error instanceof HttpException) || error.getStatus() !== 404) throw error;
        }
      }
      if (requireV6 && format !== 6) throw new Error('v6 capture capability is required');
      if (format !== 6) await this.host.requireControllerCaptureAuthoritySupport(signal, format === 4 ? 2 : 1);
    } catch {
      throw timeMachineConflict('host-capture-support-required');
    }
    if (format === 4 || format === 6) {
      try {
        await this.host.requireProxyHostIdentity(signal);
      } catch {
        throw timeMachineConflict('proxy-layout-migration-required');
      }
    }
    const selection = Object.freeze({});
    this.selections.set(selection, { format, capability });
    return selection;
  }
  requireV6RestoreCapability(signal?: AbortSignal) {
    return this.host.requireV6RestoreCapability(signal);
  }
  private async source(urn: string, userEnabled: boolean, signal: AbortSignal) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}:[a-z0-9][a-z0-9_-]{0,127}$/.test(urn)) throw new Error('Unsupported app identity');
    const [name, store] = urn.split(':');
    const root = path.join(this.config.get('directories').dataDir, 'apps', store ?? '', name ?? '');
    const yaml = await readBounded(path.join(root, 'docker-compose.yml'), 2 * 1024 * 1024, signal, true);
    let source: unknown = yaml ? parse(yaml.toString()) : null;
    if (!record(source) || !('x-runtipi' in source)) {
      const json = await readBounded(path.join(root, 'docker-compose.json'), 2 * 1024 * 1024, signal);
      if (!json) throw new Error('App source is unavailable');
      source = convertLegacyToYaml(JSON.parse(json.toString()));
    }
    const parsed = dynamicComposeSchemaYaml(source);
    if (parsed instanceof type.errors) throw new Error('App source is unsupported');
    const user = userEnabled
      ? await readBounded(
          path.join(this.config.get('directories').dataDir, 'user-config', store ?? '', name ?? '', 'docker-compose.yml'),
          2 * 1024 * 1024,
          signal,
          true,
        )
      : null;
    const generated = await readBounded(path.join(root, 'docker-compose.generated.yml'), 2 * 1024 * 1024, signal);
    const services = new Set<string>();
    for (const bytes of [generated, user]) {
      if (!bytes) continue;
      const value = parse(bytes.toString());
      if (!record(value) || value.include !== undefined || !record(value.services)) throw new Error('App service coverage is unsupported');
      for (const key of Object.keys(value.services)) services.add(key);
    }
    if (!services.size || services.size > 256) throw new Error('App service coverage is unsupported');
    const pins = await this.apps.readAppImagePins(urn as AppUrn);
    return {
      urn,
      userConfigEnabled: userEnabled,
      sourceSha256: appImagePinSourceSha256(parsed, user?.toString() ?? null),
      services: [...services].sort(),
      pinSourceSha256: pins?.pins.sourceSha256 ?? null,
    };
  }

  operation(pointId: string, signal: AbortSignal, progress: (stage: string, completed: number, total: number | null) => void, selection?: object) {
    const selected = selection ? this.selections.get(selection) : undefined;
    if (selection && !selected) throw new Error('Capture selection is unavailable.');
    if (selection) this.selections.delete(selection);
    const format = selected?.format ?? this.format;
    const capability = selected?.capability;
    let self: Dockerode.ContainerInspectInfo;
    let baseline: ControllerConfigurationCapture;
    let publication: ControllerPublicationReceipt;
    let publicationExpectation: ControllerPublicationExpectation;
    let preparation: PreparedTimeMachineImages | undefined;
    let preparationV2: ProtectedImageCaptureV2 | undefined;
    let appRuntime:
      | Awaited<ReturnType<Awaited<ReturnType<HostUpdatesService['acquireControllerCaptureFence']>>['prepareAppRuntime']>>['appRuntime']
      | undefined;
    let finalized: CapturedRuntimeInput['images'] | undefined;
    let bytes = 0;
    let fence: Awaited<ReturnType<HostUpdatesService['acquireControllerCaptureFence']>> | undefined;
    const journals = new CaptureFenceJournal(this.config.get('directories').dataDir);
    let attempt: CaptureFenceAttempt | undefined;
    let renewal: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const fenceFailure = new AbortController();
    const combined = (own: AbortSignal) => AbortSignal.any([signal, own, fenceFailure.signal]);
    return {
      maximumPlaintextBytes: backupGcmPlaintextLimit,
      hostPreflight: async (own: AbortSignal) => {
        const active = combined(own);
        active.throwIfAborted();
        await this.apps.requireNoPendingAppImageUpdates();
        self = await this.docker.getContainer(os.hostname()).inspect();
        active.throwIfAborted();
        baseline = await this.host.captureControllerConfiguration({ pointId, controllerId: self.Id, imageId: self.Image }, active);
        if (!this.images.inspectControllerSource) throw new Error('Controller publication inspection is unavailable');
        const source = await this.images.inspectControllerSource(self.Image, active);
        active.throwIfAborted();
        publicationExpectation = controllerPublicationSource(baseline, self.Image, source, this.config.get('architecture'));
        const prepared = await this.host.prepareControllerPublication(publicationExpectation, active);
        publication = decodeControllerPublicationReceipt(parseControllerPublicationResponse(prepared.read()), publicationExpectation);
        attempt = await journals.create(publicationExpectation, publication);
        active.throwIfAborted();
        fence = await this.host.acquireControllerCaptureFence(
          publicationExpectation,
          publication,
          active,
          attempt.clientKey,
          format === 4 || format === 6,
          format === 6,
          capability,
        );
        if (format === 4) await fence.prepareProxyHostIdentity(active);
        timer = setInterval(() => {
          if (renewal || !fence) return;
          renewal = fence
            .renew(combined(own))
            .catch(() => {
              fenceFailure.abort(new Error('Controller capture fence renewal failed'));
            })
            .finally(() => {
              renewal = undefined;
            });
        }, 30_000);
        timer.unref();
      },
      beforeQuiesce: async (plan: LocalCapturePlan, own: AbortSignal) => {
        const active = combined(own);
        const staging = path.join(this.config.get('directories').dataDir, 'backups', 'time-machine', 'staging');
        await privateBackupDirectory(staging);
        const selected: Awaited<ReturnType<TimeMachineCaptureRuntime['source']>>[] = [];
        if (format !== 6)
          for (const app of plan.apps) {
            active.throwIfAborted();
            selected.push(await this.source(app.urn, app.userConfigEnabled, active));
          }
        const labels = self.Config.Labels ?? {};
        const imageDocker: ImageCaptureDocker = {
          ...this.images,
          saveImage: async (...args) => {
            const source = await this.images.saveImage(...args);
            const tap = new Transform({
              transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                progress('images', bytes, null);
                callback(null, chunk);
              },
            });
            source.on('error', (error) => tap.destroy(error));
            tap.on('close', () => source.destroy());
            return source.pipe(tap);
          },
        };
        if (format === 6) {
          if (!fence) throw new Error('Controller capture fence is missing');
          ({ appRuntime } = await fence.prepareAppRuntime(active));
          preparationV2 = await prepareProtectedImageCaptureV2({
            stagingDirectory: staging,
            platform: publicationExpectation.platform,
            controller: {
              containerId: self.Id,
              project: labels['com.docker.compose.project'] ?? '',
              service: labels['com.docker.compose.service'] ?? '',
            },
            databaseId: plan.runtime.databaseId,
            appRuntime,
            docker: imageDocker,
            signal: active,
            preflight: async () => this.apps.requireNoPendingAppImageUpdates(),
          });
        } else
          preparation = await prepareTimeMachineImages({
            stagingDirectory: staging,
            platform: publicationExpectation.platform,
            controller: {
              containerId: self.Id,
              project: labels['com.docker.compose.project'] ?? '',
              service: labels['com.docker.compose.service'] ?? '',
            },
            databaseId: plan.runtime.databaseId,
            apps: selected,
            plannedContainers: plan.runtime.containers,
            docker: imageDocker,
            signal: active,
            preflight: async () => this.apps.requireNoPendingAppImageUpdates(),
            readAppSource: async (urn, check) => {
              const app = selected.find((app) => app.urn === urn);
              if (!app) throw new Error('App identity changed');
              return this.source(urn, app.userConfigEnabled, check);
            },
            limits: { ...retainedImageLimits, totalBytes: runtimeImageBytesLimit },
          });
        progress('', 0, null);
      },
      finalize: async (snapshot: LocalBackupSnapshot): Promise<CapturedRuntimeInput> => {
        if ((!preparation && !preparationV2) || !baseline || !self || !publication || !publicationExpectation)
          throw new Error('Capture preparation is missing');
        const active = combined(signal);
        active.throwIfAborted();
        if (!fence) throw new Error('Controller capture fence is missing');
        await fence.renew(active);
        const configuration = await fence.capture(active);
        if (configuration.metadata.configurationSetSha256 !== baseline.metadata.configurationSetSha256)
          throw new Error('Controller configuration changed');
        const manifestBytes = await readBounded(path.join(snapshot.content, 'manifest.json'), 4 * 1024 * 1024, active);
        if (!manifestBytes || sha(manifestBytes) !== snapshot.manifestSha256) throw new Error('Backup manifest changed');
        const manifest = parseFullBackupManifest(JSON.parse(manifestBytes.toString()));
        const hostPath = (destination: string) => {
          const mount = self.Mounts.filter(
            (mount) => mount.Type === 'bind' && (destination === mount.Destination || destination.startsWith(`${mount.Destination}/`)),
          ).sort((a, b) => b.Destination.length - a.Destination.length)[0];
          return mount ? path.posix.join(mount.Source, path.posix.relative(mount.Destination, destination)) : null;
        };
        const env = hostPath(this.config.get('envFilePath'));
        if (!env || path.posix.basename(env) !== '.env' || sha(path.posix.dirname(env)) !== configuration.metadata.rootIdentity.pathSha256)
          throw new Error('Controller environment ownership could not be established');
        for (const relative of ['.env', 'user-config/tipi-compose.yml']) {
          const sameRoot =
            relative === '.env' || sha(hostPath(this.config.get('directories').dataDir) ?? '') === configuration.metadata.rootIdentity.pathSha256;
          if (!sameRoot) continue;
          const original = configuration.metadata.files.find((file) => file.path === relative);
          const copied = manifest.files.find((file) => file.name === `data/${relative}`);
          if (
            !original ||
            (original.present ? !copied || original.sha256 !== copied.sha256 || original.bytes !== copied.bytes : copied !== undefined)
          )
            throw new Error('Duplicate controller configuration changed');
        }
        finalized = preparationV2
          ? await finalizeProtectedImageCaptureV2({
              prepared: preparationV2,
              snapshotContent: snapshot.content,
              manifestSha256: snapshot.manifestSha256,
              signal: active,
            })
          : await captureTimeMachineImages({
              preparation: preparation as PreparedTimeMachineImages,
              snapshotContent: snapshot.content,
              manifestSha256: snapshot.manifestSha256,
              pointId,
              signal: active,
            });
        const expected = copyControllerPublicationExpectation({ ...publicationExpectation, configuration: configuration.metadata });
        const receipt = decodeControllerPublicationReceipt(parseControllerPublicationResponse(publication.read()), expected);
        const result = { images: finalized, configuration, publication: receipt, publicationExpectation: expected };
        const checkedPublication = verifyCapturedControllerPublication(result);
        if (!snapshot.sealCoherence) throw new Error('Capture coherence barrier is unavailable');
        const controllerImage = finalized.capture.inventory.images.find((image) => image.imageId === self.Image);
        const controllerFile = controllerImage && finalized.files.find((file) => file.name === `images/${controllerImage.archive}`);
        if (!controllerImage || !controllerFile) throw new Error('Retained controller archive is missing');
        const controllerAuthority = await fence.finalizeControllerArchive(controllerImage, () => controllerFile.open(active), active);
        if (controllerAuthority.metadata.version === 2 || controllerAuthority.metadata.version === 4) {
          const staticFile = manifest.files.find((file) => file.name === 'data/traefik/traefik.yml');
          if (!staticFile || staticFile.sha256 !== controllerAuthority.metadata.proxyHostIdentity.configuration.staticSha256)
            throw new Error('Captured proxy configuration differs from the protected host identity policy.');
        }
        await fence.renew(active);
        const finalConfiguration = await fence.capture(active);
        if (JSON.stringify(finalConfiguration.metadata) !== JSON.stringify(configuration.metadata))
          throw new Error('Controller changed before coherence sealing');
        const coherence = await snapshot.sealCoherence(
          {
            pointId,
            publicationProofSha256: sha(checkedPublication.read()),
            imageCaptureSha256: finalized.sha256,
            controllerAuthoritySha256: sha(controllerAuthority.read()),
            imageInventorySha256: finalized.capture.inventorySha256,
            hostFence: {
              configurationSetSha256: configuration.metadata.configurationSetSha256,
              preparationSha256: checkedPublication.metadata.preparationSha256,
              verifiedAt: Date.now(),
            },
          },
          active,
        );
        active.throwIfAborted();
        return { ...result, coherence, controllerAuthority, ...(appRuntime ? { appRuntime } : {}) };
      },
      dispose: async () => {
        clearInterval(timer);
        await renewal;
        try {
          if (fence) await fence.release();
          else if (attempt) await this.host.reconcileControllerCaptureFence(attempt.expected, attempt.receipt, attempt.clientKey);
          if (attempt) await journals.remove(attempt);
        } finally {
          try {
            await finalized?.dispose();
          } finally {
            await preparation?.dispose();
            await preparationV2?.dispose();
          }
        }
      },
    };
  }
}
