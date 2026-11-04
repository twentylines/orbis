import { decodeCaptureV6Capability, decodeRestoreV6Capability } from './host-v6-capabilities';
import { decodeProxyHostIdentity, type ProxyHostIdentity } from './host-proxy-identity';
import { appRuntimeEntryLimit, appRuntimeImageBindings, decodeAppRuntimeCapture } from '../system-backups/time-machine-app-runtime-capture';
import { pipeline } from 'node:stream/promises';
import { readRootCoreState } from '@/common/restoration-root-status';
import { Transform, type Readable } from 'node:stream';
import {
  controllerAuthorityLimit,
  decodeControllerCaptureAuthority,
  type ControllerCaptureAuthorityReceipt,
} from './host-controller-capture-authority';
import type { RetainedImage } from '../system-backups/backup-image-retention';
import { randomBytes, createHash } from 'node:crypto';

const protectedV6Receipts = new WeakMap<
  ControllerCaptureAuthorityReceipt,
  { pointId: string; appRuntimeSha256: string; daemonSha256: string; appRuntime: ReturnType<typeof decodeAppRuntimeCapture> }
>();
export function requireProtectedV6CaptureAuthority(
  authority: ControllerCaptureAuthorityReceipt,
  appRuntime: ReturnType<typeof decodeAppRuntimeCapture>,
  pointId: string,
) {
  const binding = protectedV6Receipts.get(authority);
  if (
    !binding ||
    binding.pointId !== pointId ||
    binding.appRuntime !== appRuntime ||
    authority.metadata.version !== 4 ||
    binding.appRuntimeSha256 !== createHash('sha256').update(appRuntime.read()).digest('hex') ||
    binding.appRuntimeSha256 !== authority.metadata.appRuntimeSha256 ||
    binding.daemonSha256 !== authority.metadata.appRuntimeDaemonSha256 ||
    binding.daemonSha256 !== appRuntime.metadata.daemonSha256
  )
    throw new ServiceUnavailableException('Protected v6 capture authority is unavailable.');
}

import type { SmartToolsPlan } from '@runtipi/common/schemas/drive-health';
import http from 'node:http';
import path from 'node:path';
import { BadRequestException, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { gt, valid } from 'semver';
import {
  isPublishedOrbisReleaseTag,
  isStableOrbisReleaseTag,
  releaseAllowedOnChannel,
  downgradeAllowedOnChannel,
  type OrbisReleaseChannel,
} from '@runtipi/common/schemas/orbis-release-channel';
import { OrbisReleaseChannelsService } from '../system/orbis-release-channels.service';
import { DriveHealthService } from '../system/drive-health.service';
import {
  controllerCaptureSocketIdentity,
  decodeControllerConfigurationCapture,
  validateControllerCaptureIdentity,
  type ControllerCaptureIdentity,
} from './host-controller-config';
import {
  canonicalPublicationJson,
  controllerPublicationLimits,
  copyControllerPublicationExpectation,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from './host-controller-publication';

const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PACKAGE_PLAN_TTL_SECONDS = 15 * 60;

export type HostDownloadProgress = {
  schema: 'orbis.download-progress.v1';
  phase: 'downloading' | 'extracting' | 'complete';
  currentBytes: number;
  totalBytes: number | null;
  totalKnown: boolean;
  alreadyCached: boolean;
  layersComplete: number;
  layersTotal: number;
  updatedAt: number;
};

export type HostUpdateStatus = {
  available: boolean;
  capabilities?: string[];
  enrolled?: boolean;
  currentTag?: string | null;
  currentDigest?: string | null;
  coreState?: string;
  coreHealth?: string;
  imageMatches?: boolean;
  reason?: string;
  job?: {
    id: string;
    state: string;
    targetTag: string;
    startedAt: number;
    finishedAt?: number;
    message?: string;
    phase?: string | null;
    download?: HostDownloadProgress;
  } | null;
};

export type HostUpdatePlan = {
  planId: string;
  currentTag: string;
  targetTag: string;
  targetDigest: string;
  snapshotBytes: number;
  appsMustBeStopped: boolean;
};

export type HostPackage = {
  name: string;
  installedVersion: string;
  candidateVersion: string;
  downloadBytes: number | null;
  security: boolean;
  sources: Array<{ origin: string | null; archive: string | null; site: string | null; trusted: boolean }>;
};

export type HostPackageInventory = {
  available: boolean;
  reason?: string;
  manager?: 'apt';
  operatingSystem?: string;
  checkedAt?: string;
  indexesUpdatedAt?: string | null;
  rebootRequired?: boolean;
  packageCount?: number;
  truncated?: boolean;
  packages?: HostPackage[];
};

export type HostPackageChangelog = {
  name: string;
  candidateVersion: string;
  available: boolean;
  source: string;
  body?: string;
  truncated?: boolean;
  reason?: string;
};

export type HostPackageOperation = {
  name: string;
  installedVersion: string | null;
  candidateVersion: string;
  action: 'install' | 'upgrade';
};

export type HostPackagePlan = {
  planId: string;
  createdAt: number;
  expiresAt: number;
  selected: HostPackage[];
  operations: HostPackageOperation[];
};

export type HostPackageJobStatus = {
  available: boolean;
  job: null | {
    id: string;
    kind?: 'refresh' | 'smart-tools';
    state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    message?: string;
    exitCode?: number;
    rebootRequired?: boolean;
    operationCount?: number;
    output?: { text: string; bytes: number; truncated: boolean; updatedAt: number | null };
  };
};

export type HostRestartStatus = {
  available: boolean;
  reason?: string;
  rebootRequired?: boolean;
  job: null | {
    id: string;
    state: 'restarting' | 'complete' | 'failed';
    createdAt: number;
    finishedAt?: number;
    message: string;
  };
};

export type HostRestartPlan = { planId: string; expiresAt: number; rebootRequired: boolean };

@Injectable()
export class HostUpdatesService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  private readonly captureV6Capabilities = new WeakSet<object>();
  private readonly plans = new Map<string, { downgrade: boolean; returnToStable: boolean; revision: string; expiresAt: number }>();

  constructor(
    private readonly channels: OrbisReleaseChannelsService,
    @Inject(DriveHealthService) private readonly drives: DriveHealthService,
  ) {}

  private requireSocket(): string {
    if (!this.socketPath || !path.isAbsolute(this.socketPath) || this.socketPath.includes('\0')) {
      throw new ServiceUnavailableException('The Orbis host service is not connected.');
    }
    return this.socketPath;
  }

  private async call<T>(
    endpoint:
      | '/v1/status'
      | '/v1/channel'
      | '/v1/plan'
      | '/v1/apply'
      | '/v1/recover'
      | '/v1/packages'
      | '/v1/packages/job'
      | '/v1/packages/plan'
      | '/v1/packages/apply'
      | '/v1/packages/refresh'
      | '/v1/restart'
      | '/v1/restart/plan'
      | '/v1/restart/apply'
      | '/v1/drives/test'
      | '/v1/controller-config/capture'
      | '/v1/controller-config/capability'
      | '/v1/controller-publication/capability'
      | '/v1/controller-publication/prepare'
      | '/v1/controller-capture-fence/capability'
      | '/v1/controller-capture-authority/capability'
      | '/v2/controller-capture-authority/capability'
      | '/v3/controller-capture-authority/capability'
      | '/v1/retained-restore/capability'
      | '/v1/proxy-host-identity'
      | `/v3/controller-capture-authority/${string}/prepare`
      | `/v3/controller-capture-authority/${string}/recover`
      | `/v2/controller-capture-authority/${string}/prepare`
      | `/v2/controller-capture-authority/${string}/recover`
      | `/v1/controller-capture-authority/${string}/recover`
      | '/v1/controller-capture-fence/acquire'
      | '/v1/controller-capture-fence/renew'
      | '/v1/controller-capture-fence/release'
      | '/v1/controller-capture-fence/reconcile'
      | '/v1/drives/tools/plan'
      | '/v1/drives/tools/apply'
      | `/v1/packages/changelog?name=${string}`,
    body?: object,
    cancellation?: AbortSignal,
  ): Promise<T> {
    const socketPath = this.requireSocket();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          signal:
            endpoint.startsWith('/v1/controller-config/') ||
            endpoint.startsWith('/v1/controller-publication/') ||
            endpoint.startsWith('/v1/controller-capture-fence/') ||
            endpoint.startsWith('/v1/controller-capture-authority/') ||
            endpoint.startsWith('/v2/controller-capture-authority/') ||
            endpoint.startsWith('/v3/controller-capture-authority/') ||
            endpoint === '/v1/proxy-host-identity'
              ? AbortSignal.any([
                  AbortSignal.timeout(endpoint === '/v1/controller-publication/prepare' ? controllerPublicationLimits.deadlineMs : 30_000),
                  ...(cancellation ? [cancellation] : []),
                ])
              : undefined,
          path: endpoint,
          method: payload === undefined ? 'GET' : 'POST',
          timeout:
            endpoint === '/v1/controller-publication/prepare'
              ? controllerPublicationLimits.deadlineMs
              : endpoint === '/v1/controller-config/capture'
                ? 30_000
                : endpoint === '/v1/plan'
                  ? 90_000
                  : endpoint === '/v1/packages/plan' ||
                      endpoint === '/v1/packages/apply' ||
                      endpoint === '/v1/packages/refresh' ||
                      endpoint.startsWith('/v1/drives/tools/')
                    ? 60_000
                    : endpoint.startsWith('/v1/packages/changelog')
                      ? 25_000
                      : endpoint === '/v1/drives/test'
                        ? 35_000
                        : endpoint === '/v1/packages'
                          ? 30_000
                          : 10_000,
          headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (
              size >
              (endpoint === '/v1/controller-publication/prepare'
                ? controllerPublicationLimits.receiptBytes
                : endpoint === '/v1/controller-config/capture'
                  ? 6 * 1024 * 1024
                  : endpoint === '/v1/packages'
                    ? 1024 * 1024
                    : endpoint === '/v1/packages/plan'
                      ? 256 * 1024
                      : MAX_RESPONSE_BYTES)
            ) {
              res.destroy(new Error('Host service response was too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              const bytes = Buffer.concat(chunks);
              resolve({
                status: res.statusCode ?? 502,
                data:
                  endpoint.startsWith('/v1/controller-publication/') ||
                  endpoint === '/v3/controller-capture-authority/capability' ||
                  endpoint === '/v1/retained-restore/capability'
                    ? parseControllerPublicationResponse(bytes)
                    : JSON.parse(bytes.toString('utf-8')),
              });
            } catch {
              reject(new Error('Host service response was invalid'));
            }
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Host service timed out')));
      request.end(payload);
    }).catch(() => {
      throw new ServiceUnavailableException('The Orbis host service is unavailable.');
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 404 && endpoint.startsWith('/v1/restart')) {
        throw new ServiceUnavailableException('Update the Orbis host service to enable server restarts.');
      }
      const message =
        typeof response.data === 'object' && response.data !== null && 'error' in response.data && typeof response.data.error === 'string'
          ? response.data.error
          : 'The host operation was rejected.';
      throw new HttpException(message, response.status);
    }
    if (typeof response.data !== 'object' || response.data === null) {
      throw new ServiceUnavailableException('The Orbis host service returned an invalid response.');
    }
    return response.data as T;
  }

  async status(): Promise<HostUpdateStatus> {
    if (!this.socketPath) return { available: false, reason: 'The Orbis host service is not connected.' };
    try {
      return await this.call<HostUpdateStatus>('/v1/status');
    } catch {
      return { available: false, reason: 'The Orbis host service is unavailable.' };
    }
  }
  async requireControllerConfigurationSupport(signal?: AbortSignal) {
    try {
      const socket = this.requireSocket();
      const before = await controllerCaptureSocketIdentity(socket);
      const result = await this.call<{ version: number; capability: string }>('/v1/controller-config/capability', undefined, signal);
      if (
        (await controllerCaptureSocketIdentity(socket)) !== before ||
        result.version !== 1 ||
        result.capability !== 'controller-config.v1' ||
        Object.keys(result).length !== 2
      )
        throw new Error('Controller capture capability is invalid.');
    } catch {
      throw new ServiceUnavailableException('Update and verify the Orbis host service with controller-config.v1 support before capturing.');
    }
  }
  async captureControllerConfiguration(identity: ControllerCaptureIdentity, signal?: AbortSignal, fenceToken?: string) {
    try {
      validateControllerCaptureIdentity(identity);
      const expected = Object.freeze({ pointId: identity.pointId, controllerId: identity.controllerId, imageId: identity.imageId });
      const socket = this.requireSocket();
      const before = await controllerCaptureSocketIdentity(socket);
      const response = await this.call<unknown>('/v1/controller-config/capture', { ...expected, ...(fenceToken ? { fenceToken } : {}) }, signal);
      if ((await controllerCaptureSocketIdentity(socket)) !== before) throw new Error('Host socket identity changed.');
      return decodeControllerConfigurationCapture(response, expected);
    } catch {
      throw new ServiceUnavailableException(
        'Controller configuration capture requires a healthy enrolled host service with controller-config.v1 support and a protected socket.',
      );
    }
  }

  async requireControllerCaptureAuthoritySupport(signal?: AbortSignal, version: 1 | 2 = 1) {
    const socket = this.requireSocket();
    const before = await controllerCaptureSocketIdentity(socket);
    const result = await this.call<{ version: number; capability: string }>(
      `/v${version}/controller-capture-authority/capability`,
      undefined,
      signal,
    );
    if (
      (await controllerCaptureSocketIdentity(socket)) !== before ||
      result.version !== version ||
      result.capability !== `controller-capture-authority.v${version}` ||
      Object.keys(result).length !== 2
    )
      throw new ServiceUnavailableException(`Update and verify controller-capture-authority.v${version} host support before capturing.`);
  }

  async requireV6CaptureCapability(signal?: AbortSignal) {
    const socket = this.requireSocket();
    const before = await controllerCaptureSocketIdentity(socket);
    const result = decodeCaptureV6Capability(await this.call('/v3/controller-capture-authority/capability', undefined, signal));
    if ((await controllerCaptureSocketIdentity(socket)) !== before) throw new ServiceUnavailableException('Protected capture capability changed.');
    this.captureV6Capabilities.add(result);
    return result;
  }

  async requireV6RestoreCapability(signal?: AbortSignal) {
    const socket = this.requireSocket();
    const before = await controllerCaptureSocketIdentity(socket);
    const result = decodeRestoreV6Capability(await this.call('/v1/retained-restore/capability', undefined, signal));
    if ((await controllerCaptureSocketIdentity(socket)) !== before) throw new ServiceUnavailableException('Protected restore capability changed.');
    return result;
  }

  async requireProxyHostIdentity(signal?: AbortSignal) {
    const socket = this.requireSocket();
    const before = await controllerCaptureSocketIdentity(socket);
    const result = await this.call<{ version: number; descriptor: unknown }>('/v1/proxy-host-identity', undefined, signal);
    if ((await controllerCaptureSocketIdentity(socket)) !== before || result.version !== 1 || Object.keys(result).length !== 2)
      throw new ServiceUnavailableException('Protected proxy host identity is unavailable.');
    return decodeProxyHostIdentity(result.descriptor);
  }

  async requireControllerCaptureFenceSupport(signal?: AbortSignal) {
    try {
      const socket = this.requireSocket();
      const before = await controllerCaptureSocketIdentity(socket);
      const result = await this.call<{ version: number; capability: string }>('/v1/controller-capture-fence/capability', undefined, signal);
      if (
        (await controllerCaptureSocketIdentity(socket)) !== before ||
        result.version !== 1 ||
        result.capability !== 'controller-capture-fence.v1' ||
        Object.keys(result).length !== 2
      )
        throw new Error('Invalid capture fence capability');
    } catch {
      throw new ServiceUnavailableException('Update and verify controller-capture-fence.v1 host support before capturing.');
    }
  }

  async acquireControllerCaptureFence(
    supplied: ControllerPublicationExpectation,
    receipt: ControllerPublicationReceipt,
    signal?: AbortSignal,
    clientKey?: string,
    proxyPolicy = false,
    appRuntimePolicy = false,
    capability?: Awaited<ReturnType<HostUpdatesService['requireV6CaptureCapability']>>,
  ) {
    if (appRuntimePolicy && !proxyPolicy) throw new ServiceUnavailableException('Protected app runtime requires proxy identity.');
    if (capability && (!appRuntimePolicy || !this.captureV6Capabilities.has(capability)))
      throw new ServiceUnavailableException('Protected capture capability is unavailable.');
    if (capability) this.captureV6Capabilities.delete(capability);
    const expected = copyControllerPublicationExpectation(supplied);
    const proof = decodeControllerPublicationReceipt(parseControllerPublicationResponse(receipt.read()), expected).metadata;
    const identity = {
      pointId: expected.configuration.pointId,
      controllerId: expected.configuration.controller.id,
      imageId: expected.configuration.controller.imageId,
    };
    const socket = this.requireSocket();
    const socketIdentity = await controllerCaptureSocketIdentity(socket);
    // Retain the key before the first network call, including an ambiguous timeout or disconnect.
    const token = clientKey ?? randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ServiceUnavailableException('Invalid private capture recovery key.');
    const request = {
      ...identity,
      configurationSetSha256: expected.configuration.configurationSetSha256,
      preparationSha256: proof.preparationSha256,
      clientKey: token,
      ...(capability ? { captureContractSha256: capability.contractSha256 } : {}),
    };
    if (capability) {
      const current = await this.requireV6CaptureCapability(signal);
      if (current.contractSha256 !== capability.contractSha256) throw new ServiceUnavailableException('Protected capture capability changed.');
    }
    const releaseAttempt = () => this.reconcileControllerCaptureFence(expected, receipt, token);
    try {
      let response: { version: number; token: string; expiresAt: number; captureContractSha256?: string };
      try {
        response = await this.call('/v1/controller-capture-fence/acquire', request, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        response = await this.call('/v1/controller-capture-fence/acquire', request, signal);
      }
      if (
        (await controllerCaptureSocketIdentity(socket)) !== socketIdentity ||
        response.version !== (capability ? 2 : 1) ||
        (capability && response.captureContractSha256 !== capability.contractSha256) ||
        response.token !== token ||
        !Number.isFinite(response.expiresAt) ||
        response.expiresAt * 1000 <= Date.now() ||
        Object.keys(response).length !== (capability ? 4 : 3)
      )
        throw new ServiceUnavailableException('Controller capture fence could not be verified.');
    } catch (error) {
      try {
        await releaseAttempt();
      } catch {
        throw new ServiceUnavailableException('Controller capture fence acquisition and cleanup require reconciliation.');
      }
      throw error;
    }
    let released = false;
    let proxyHostIdentity: ProxyHostIdentity | undefined;
    let appRuntimeBinding: { entrySha256: string; daemonSha256: string; appRuntime: ReturnType<typeof decodeAppRuntimeCapture> } | undefined;
    let preparingAppRuntime = false;
    const authorityVersion = appRuntimePolicy ? 3 : proxyPolicy ? 2 : 1;
    const authorityBinding = {
      token,
      configurationSetSha256: expected.configuration.configurationSetSha256,
      preparationSha256: proof.preparationSha256,
      publicationProofSha256: createHash('sha256').update(receipt.read()).digest('hex'),
    };
    return Object.freeze({
      prepareProxyHostIdentity: async (cancellation?: AbortSignal) => {
        if (!proxyPolicy || released || (await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
          throw new ServiceUnavailableException('Protected proxy capture preparation is unavailable.');
        const response = await this.call<{ version: number; pointId: string; proxyHostIdentity: unknown; proxyPreparationSha256: string }>(
          `/v2/controller-capture-authority/${identity.pointId}/prepare`,
          authorityBinding,
          cancellation,
        );
        if (
          (await controllerCaptureSocketIdentity(socket)) !== socketIdentity ||
          response.version !== 2 ||
          response.pointId !== identity.pointId ||
          Object.keys(response).length !== 4 ||
          !/^[a-f0-9]{64}$/.test(response.proxyPreparationSha256)
        )
          throw new ServiceUnavailableException('Protected proxy capture preparation changed.');
        proxyHostIdentity = decodeProxyHostIdentity(response.proxyHostIdentity, expected.configuration.rootIdentity.pathSha256);
        return structuredClone(proxyHostIdentity);
      },
      prepareAppRuntime: async (cancellation?: AbortSignal) => {
        if (!appRuntimePolicy || released || preparingAppRuntime)
          throw new ServiceUnavailableException('Protected app capture preparation is unavailable.');
        preparingAppRuntime = true;
        appRuntimeBinding = undefined;
        proxyHostIdentity = undefined;
        try {
          if ((await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
            throw new ServiceUnavailableException('Protected app capture preparation is unavailable.');
          const prepared = await this.call<{
            version: number;
            pointId: string;
            proxyHostIdentity: unknown;
            proxyPreparationSha256: string;
            appRuntimeSha256: string;
            appRuntimeDaemonSha256: string;
            appRuntimeBytes: number;
          }>(`/v3/controller-capture-authority/${identity.pointId}/prepare`, authorityBinding, cancellation);
          if (
            (await controllerCaptureSocketIdentity(socket)) !== socketIdentity ||
            prepared.version !== 3 ||
            prepared.pointId !== identity.pointId ||
            Object.keys(prepared).sort().join('\0') !==
              [
                'appRuntimeBytes',
                'appRuntimeDaemonSha256',
                'appRuntimeSha256',
                'pointId',
                'proxyHostIdentity',
                'proxyPreparationSha256',
                'version',
              ].join('\0') ||
            !/^[a-f0-9]{64}$/.test(prepared.proxyPreparationSha256) ||
            !/^[a-f0-9]{64}$/.test(prepared.appRuntimeSha256) ||
            !/^[a-f0-9]{64}$/.test(prepared.appRuntimeDaemonSha256) ||
            !Number.isSafeInteger(prepared.appRuntimeBytes) ||
            prepared.appRuntimeBytes < 1 ||
            prepared.appRuntimeBytes > appRuntimeEntryLimit
          )
            throw new ServiceUnavailableException('Protected app capture preparation changed.');
          const policy = decodeProxyHostIdentity(prepared.proxyHostIdentity, expected.configuration.rootIdentity.pathSha256);
          const payload = JSON.stringify({ ...authorityBinding, appRuntimeSha256: prepared.appRuntimeSha256 });
          const blob = await new Promise<Buffer>((resolve, reject) => {
            const request = http.request(
              {
                socketPath: socket,
                method: 'POST',
                path: `/v3/controller-capture-authority/${identity.pointId}/app-runtime`,
                signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(cancellation ? [cancellation] : [])]),
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              },
              (reply) => {
                const chunks: Buffer[] = [];
                let size = 0;
                if (
                  reply.statusCode !== 200 ||
                  reply.headers['content-type'] !== 'application/json' ||
                  reply.headers['content-length'] !== String(prepared.appRuntimeBytes) ||
                  reply.headers['cache-control'] !== 'no-store'
                ) {
                  reply.resume();
                  reject(new Error('Protected app capture is unavailable.'));
                  return;
                }
                reply.on('data', (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > prepared.appRuntimeBytes) reply.destroy(new Error('Protected app capture exceeded its bound.'));
                  else chunks.push(chunk);
                });
                reply.on('error', reject);
                reply.on('aborted', () => reject(new Error('Protected app capture was interrupted.')));
                reply.on('end', () =>
                  size === prepared.appRuntimeBytes ? resolve(Buffer.concat(chunks)) : reject(new Error('Protected app capture was truncated.')),
                );
              },
            );
            request.on('error', reject);
            request.end(payload);
          });
          if (released || (await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
            throw new ServiceUnavailableException('Host socket identity changed.');
          const appRuntime = decodeAppRuntimeCapture(blob, {
            pointId: identity.pointId,
            rootSha256: expected.configuration.rootIdentity.pathSha256,
            dockerContextSha256: policy.dockerContextSha256,
            daemonSha256: prepared.appRuntimeDaemonSha256,
            configurationSetSha256: authorityBinding.configurationSetSha256,
            preparationSha256: authorityBinding.preparationSha256,
            entrySha256: prepared.appRuntimeSha256,
          });
          proxyHostIdentity = policy;
          appRuntimeBinding = { entrySha256: prepared.appRuntimeSha256, daemonSha256: prepared.appRuntimeDaemonSha256, appRuntime };
          return { proxyHostIdentity: structuredClone(policy), appRuntime, appImageBindings: appRuntimeImageBindings(appRuntime) };
        } finally {
          preparingAppRuntime = false;
        }
      },
      renew: async (cancellation?: AbortSignal) => {
        if (released) throw new ServiceUnavailableException('Controller capture fence is no longer held.');
        if ((await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
          throw new ServiceUnavailableException('Host socket identity changed.');
        const result = await this.call<{ version: number; expiresAt: number }>('/v1/controller-capture-fence/renew', { token }, cancellation);
        if (
          (await controllerCaptureSocketIdentity(socket)) !== socketIdentity ||
          result.version !== 1 ||
          Object.keys(result).length !== 2 ||
          !Number.isFinite(result.expiresAt) ||
          result.expiresAt * 1000 <= Date.now()
        )
          throw new ServiceUnavailableException('Controller capture fence maintenance failed.');
      },
      release: async () => {
        if (released) return;
        await releaseAttempt();
        released = true;
      },
      finalizeControllerArchive: async (image: RetainedImage, open: () => Promise<Readable>, cancellation?: AbortSignal) => {
        if (released || (await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
          throw new ServiceUnavailableException('Controller capture fence is no longer held.');
        if (proxyPolicy && !proxyHostIdentity) throw new ServiceUnavailableException('Protected proxy capture preparation is missing.');
        if (appRuntimePolicy && !appRuntimeBinding) throw new ServiceUnavailableException('Protected app capture preparation is missing.');
        if (!Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 68719476736)
          throw new ServiceUnavailableException('Controller archive size is invalid.');
        const source = await open();
        const signal = AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(cancellation ? [cancellation] : [])]);
        let response: unknown;
        let upload: Promise<void> | undefined;
        let uploaded = 0;
        let uploadVerified = false;
        const hash = createHash('sha256');
        const guard = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            uploaded += chunk.length;
            if (uploaded > image.bytes) return callback(new Error('Controller archive exceeded its verified size.'));
            hash.update(chunk);
            callback(null, chunk);
          },
          flush(callback) {
            uploadVerified = uploaded === image.bytes && hash.digest('hex') === image.sha256;
            callback(uploadVerified ? null : new Error('Controller archive changed during upload.'));
          },
        });
        try {
          response = await new Promise<unknown>((resolve, reject) => {
            const request = http.request(
              {
                socketPath: socket,
                method: 'POST',
                path: `/v${authorityVersion}/controller-capture-authority/${identity.pointId}/finalize`,
                signal,
                headers: { 'Content-Type': 'application/x-tar', 'Content-Length': image.bytes, 'X-Orbis-Capture-Token': token },
              },
              (reply) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                reply.on('data', (chunk: Buffer) => {
                  bytes += chunk.length;
                  if (bytes > controllerAuthorityLimit) reply.destroy();
                  else chunks.push(chunk);
                });
                reply.on('error', reject);
                reply.on('end', () => {
                  try {
                    if (reply.statusCode !== 200) throw new Error('Root capture authority is unavailable.');
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            request.on('error', reject);
            upload = pipeline(source, guard, request, { signal });
            void upload.catch(reject);
          });
          await upload;
        } catch (error) {
          if (signal.aborted || !uploadVerified) throw error;
          const recovered = await this.call<{ version: number; state: string; authority?: unknown }>(
            `/v${authorityVersion}/controller-capture-authority/${identity.pointId}/recover`,
            authorityBinding,
            cancellation,
          );
          if (
            recovered.version !== authorityVersion ||
            recovered.state !== 'finalized' ||
            Object.keys(recovered).length !== 3 ||
            !recovered.authority
          )
            throw error;
          response = recovered.authority;
        } finally {
          source.destroy();
        }
        if ((await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
          throw new ServiceUnavailableException('Host socket identity changed.');
        const authority = decodeControllerCaptureAuthority(response, expected, receipt, image);
        if (
          authority.metadata.version !== (authorityVersion === 3 ? 4 : authorityVersion) ||
          ((authority.metadata.version === 2 || authority.metadata.version === 4) &&
            canonicalPublicationJson(authority.metadata.proxyHostIdentity) !== canonicalPublicationJson(proxyHostIdentity)) ||
          (authority.metadata.version === 4 &&
            (!appRuntimeBinding ||
              authority.metadata.appRuntimeSha256 !== appRuntimeBinding.entrySha256 ||
              authority.metadata.appRuntimeDaemonSha256 !== appRuntimeBinding.daemonSha256))
        )
          throw new ServiceUnavailableException('Protected proxy capture authority changed.');
        if (authority.metadata.version === 4 && appRuntimeBinding)
          protectedV6Receipts.set(authority, {
            pointId: identity.pointId,
            appRuntimeSha256: appRuntimeBinding.entrySha256,
            daemonSha256: appRuntimeBinding.daemonSha256,
            appRuntime: appRuntimeBinding.appRuntime,
          });
        return authority;
      },
      capture: async (cancellation?: AbortSignal) => {
        if (released || (await controllerCaptureSocketIdentity(socket)) !== socketIdentity)
          throw new ServiceUnavailableException('Controller capture fence is no longer held.');
        return this.captureControllerConfiguration(identity, cancellation, token);
      },
    });
  }

  async reconcileControllerCaptureFence(supplied: ControllerPublicationExpectation, receipt: ControllerPublicationReceipt, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ServiceUnavailableException('Invalid private capture recovery key.');
    const expected = copyControllerPublicationExpectation(supplied);
    const verified = decodeControllerPublicationReceipt(parseControllerPublicationResponse(receipt.read()), expected).metadata;
    const body = {
      token,
      pointId: expected.configuration.pointId,
      controllerId: expected.configuration.controller.id,
      imageId: expected.configuration.controller.imageId,
      configurationSetSha256: expected.configuration.configurationSetSha256,
      preparationSha256: verified.preparationSha256,
    };
    const socket = this.requireSocket();
    const before = await controllerCaptureSocketIdentity(socket);
    let result: { version: number; released: boolean };
    try {
      result = await this.call('/v1/controller-capture-fence/release', body);
    } catch {
      result = await this.call('/v1/controller-capture-fence/reconcile', body);
    }
    if (
      (await controllerCaptureSocketIdentity(socket)) !== before ||
      result.version !== 1 ||
      result.released !== true ||
      Object.keys(result).length !== 2
    )
      throw new ServiceUnavailableException('Controller capture fence cleanup failed.');
  }

  async requireControllerPublicationSupport(signal?: AbortSignal) {
    try {
      const socket = this.requireSocket();
      const before = await controllerCaptureSocketIdentity(socket);
      const result = await this.call<{ version: number; capability: string }>('/v1/controller-publication/capability', undefined, signal);
      if (
        (await controllerCaptureSocketIdentity(socket)) !== before ||
        result.version !== 1 ||
        result.capability !== 'controller-publication.v1' ||
        Object.keys(result).length !== 2
      )
        throw new Error('Controller publication capability is invalid.');
    } catch {
      throw new ServiceUnavailableException(
        'Update and verify the Orbis host service with controller-publication.v1 support before preparing publication evidence.',
      );
    }
  }

  async prepareControllerPublication(supplied: ControllerPublicationExpectation, signal?: AbortSignal) {
    try {
      const expected = copyControllerPublicationExpectation(supplied);
      const request = {
        pointId: expected.configuration.pointId,
        controllerId: expected.configuration.controller.id,
        imageId: expected.configuration.controller.imageId,
        configurationSetSha256: expected.configuration.configurationSetSha256,
      };
      const socket = this.requireSocket();
      const before = await controllerCaptureSocketIdentity(socket);
      const response = await this.call<unknown>('/v1/controller-publication/prepare', request, signal);
      if ((await controllerCaptureSocketIdentity(socket)) !== before) throw new Error('Host socket identity changed.');
      return decodeControllerPublicationReceipt(response, expected);
    } catch {
      throw new ServiceUnavailableException(
        'Controller publication preparation requires a verified enrolled host, matching publication evidence and a protected socket.',
      );
    }
  }

  private async requireChannelSupport() {
    const status = await this.status();
    if (!status.available || !status.capabilities?.includes('release-channels.v1')) {
      throw new ServiceUnavailableException({
        code: 'host-channel-support-required',
        message: 'Connect or update the Orbis host service with the current installer to change update channels.',
      });
    }
  }

  async changeReleaseChannel(channel: OrbisReleaseChannel, revision: string, acknowledgeNightly = false) {
    await this.requireChannelSupport();
    await this.call('/v1/channel', { channel, revision, acknowledgeNightly });
    const result = await this.channels.status();
    if (result.current !== channel)
      throw new ServiceUnavailableException('The host did not confirm the selected release channel. Refresh its status.');
    return result;
  }

  packages(): Promise<HostPackageInventory> {
    return this.call<HostPackageInventory>('/v1/packages');
  }

  private async requireSmartToolsSupport() {
    const status = await this.status();
    if (!status.available || !status.capabilities?.includes('drives.tools-install.v1')) {
      throw new ServiceUnavailableException('Update the Orbis host service to install SMART tools on a supported Ubuntu 24.04 host.');
    }
  }

  async smartToolsPlan(): Promise<SmartToolsPlan> {
    await this.requireSmartToolsSupport();
    const plan = await this.call<SmartToolsPlan>('/v1/drives/tools/plan', {});
    if (
      !PLAN_ID.test(plan.planId) ||
      !Number.isFinite(plan.createdAt) ||
      !Number.isFinite(plan.expiresAt) ||
      plan.createdAt <= 0 ||
      plan.expiresAt <= plan.createdAt ||
      plan.expiresAt - plan.createdAt > PACKAGE_PLAN_TTL_SECONDS ||
      !Array.isArray(plan.selected) ||
      plan.selected.length < 1 ||
      plan.selected.length > 2 ||
      !plan.selected.every((item) => item && typeof item === 'object') ||
      new Set(plan.selected.map((item) => item.name)).size !== plan.selected.length ||
      !plan.selected.some((item) => item.name === 'smartmontools') ||
      !plan.selected.every(
        (item) =>
          ['smartmontools', 'libcap-ng0'].includes(item.name) &&
          item.installedVersion === null &&
          typeof item.candidateVersion === 'string' &&
          /^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(item.candidateVersion),
      ) ||
      !Array.isArray(plan.operations) ||
      plan.operations.length !== plan.selected.length ||
      !plan.operations.every((item) => item && typeof item === 'object') ||
      new Set(plan.operations.map((item) => item.name)).size !== plan.selected.length ||
      !plan.operations.every(
        (item) =>
          item.action === 'install' &&
          item.installedVersion === null &&
          plan.selected.some((selected) => selected.name === item.name && selected.candidateVersion === item.candidateVersion),
      )
    ) {
      throw new ServiceUnavailableException('The host returned an invalid SMART tools review. No installation was started.');
    }
    return plan;
  }

  async smartToolsApply(planId: unknown): Promise<{ jobId: string; state: string }> {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) throw new BadRequestException('Review the SMART tools installation before confirming.');
    await this.requireSmartToolsSupport();
    return this.call('/v1/drives/tools/apply', { planId });
  }

  driveTest(id: unknown, kind: unknown): Promise<{ accepted: boolean; message: string }> {
    if (typeof id !== 'string' || !/^drive:[a-f0-9]{24}$/.test(id) || typeof kind !== 'string' || !['short', 'extended', 'abort'].includes(kind)) {
      throw new BadRequestException('Choose one drive and a supported self-test.');
    }
    return this.call<{ accepted: boolean; message: string }>('/v1/drives/test', { id, kind }).then((result) => {
      if (result.accepted === true) this.drives.invalidate();
      return result;
    });
  }

  async restartStatus(): Promise<HostRestartStatus> {
    try {
      return await this.call<HostRestartStatus>('/v1/restart');
    } catch (error) {
      return {
        available: false,
        reason: error instanceof HttpException ? error.message : 'Server restart status is unavailable.',
        job: null,
      };
    }
  }

  restartPlan(): Promise<HostRestartPlan> {
    return this.call<HostRestartPlan>('/v1/restart/plan', {});
  }

  restartApply(planId: unknown): Promise<{ jobId: string; state: 'restarting' }> {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
      throw new BadRequestException('Review the server restart before confirming.');
    }
    return this.call('/v1/restart/apply', { planId });
  }

  packageChangelog(name: unknown): Promise<HostPackageChangelog> {
    if (typeof name !== 'string' || name.length > 180 || !PACKAGE_NAME.test(name)) {
      throw new BadRequestException('Choose a valid package name.');
    }
    return this.call<HostPackageChangelog>(`/v1/packages/changelog?name=${encodeURIComponent(name)}`);
  }

  packageJob(): Promise<HostPackageJobStatus> {
    return this.call<HostPackageJobStatus>('/v1/packages/job').then((status) => {
      if (status.job?.kind === 'smart-tools' && status.job.state === 'complete') this.drives.invalidate();
      return status;
    });
  }

  packageRefresh(): Promise<{ jobId: string; state: string }> {
    return this.call('/v1/packages/refresh', {});
  }

  packagePlan(names: unknown): Promise<HostPackagePlan> {
    if (
      !Array.isArray(names) ||
      names.length < 1 ||
      names.length > 250 ||
      !names.every((name) => typeof name === 'string' && name.length <= 180 && PACKAGE_NAME.test(name)) ||
      new Set(names).size !== names.length
    ) {
      throw new BadRequestException('Choose 1 to 250 distinct host packages.');
    }
    return this.call<Omit<HostPackagePlan, 'expiresAt'> & { expiresAt?: number }>('/v1/packages/plan', { names }).then((plan) => {
      // Earlier v1 helpers omit the deadline but use the same fifteen-minute lifetime.
      const expiresAt = plan.expiresAt === undefined ? plan.createdAt + PACKAGE_PLAN_TTL_SECONDS : plan.expiresAt;
      if (
        !PLAN_ID.test(plan.planId) ||
        typeof plan.createdAt !== 'number' ||
        !Number.isFinite(plan.createdAt) ||
        plan.createdAt <= 0 ||
        typeof expiresAt !== 'number' ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= plan.createdAt ||
        expiresAt - plan.createdAt > PACKAGE_PLAN_TTL_SECONDS ||
        !Array.isArray(plan.selected) ||
        plan.selected.length !== names.length ||
        new Set(plan.selected.map((item) => item?.name)).size !== names.length ||
        !plan.selected.every((item) => typeof item?.name === 'string' && names.includes(item.name)) ||
        !Array.isArray(plan.operations)
      ) {
        throw new ServiceUnavailableException('The host returned an invalid package review. No packages were changed.');
      }
      return { ...plan, expiresAt };
    });
  }

  packageApply(planId: unknown): Promise<{ jobId: string; state: string }> {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
      throw new BadRequestException('Choose a valid reviewed package plan.');
    }
    return this.call<{ jobId: string; state: string }>('/v1/packages/apply', { planId });
  }

  async plan(tag: unknown, reviewedDowngrade = false, returnToStable = false): Promise<HostUpdatePlan> {
    if (!isPublishedOrbisReleaseTag(tag)) {
      throw new BadRequestException('Choose a valid Orbis release tag.');
    }
    const channel = await this.channels.read();
    const installed = process.env.ORBIS_VERSION;
    if (returnToStable) {
      if (channel.channel !== 'nightly' || !isStableOrbisReleaseTag(tag))
        throw new BadRequestException('Review a Stable installation before changing channels.');
    } else if (!releaseAllowedOnChannel(tag, channel.channel))
      throw new BadRequestException('Choose a release available on the selected update channel.');
    if (reviewedDowngrade && !downgradeAllowedOnChannel(tag, installed, channel.channel))
      throw new BadRequestException('Choose an allowed earlier release on this update channel.');
    if (channel.channel === 'nightly' || returnToStable) await this.requireChannelSupport();
    if (!reviewedDowngrade) {
      if (!installed || !valid(installed)) {
        throw new BadRequestException('The installed Orbis version could not be verified. No update was started.');
      }
      if (!valid(tag) || !gt(tag, installed)) {
        throw new BadRequestException('Use the downgrade review to install an earlier Orbis release.');
      }
    }
    return this.call<HostUpdatePlan>('/v1/plan', { tag, ...(returnToStable ? { returnToStable: true } : {}) }).then((plan) => {
      if (typeof plan.planId !== 'string' || !PLAN_ID.test(plan.planId)) {
        throw new ServiceUnavailableException('The Orbis host service returned an invalid update plan.');
      }
      for (const [id, previous] of this.plans) if (previous.expiresAt < Date.now()) this.plans.delete(id);
      if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value as string);
      this.plans.set(plan.planId, { downgrade: reviewedDowngrade, returnToStable, revision: channel.revision, expiresAt: Date.now() + 15 * 60_000 });
      return plan;
    });
  }

  async requireOperationStatus() {
    if ((await readRootCoreState(this.socketPath)) !== 'idle')
      throw new ServiceUnavailableException('The host service must support verified operation status before starting an update.');
  }

  async apply(planId: unknown, reviewedDowngrade = false, returnToStable = false): Promise<{ jobId: string; state: string }> {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
      throw new BadRequestException('Create a new update plan first.');
    }
    const plan = this.plans.get(planId);
    if (
      !plan ||
      plan.expiresAt < Date.now() ||
      plan.downgrade !== reviewedDowngrade ||
      plan.returnToStable !== returnToStable ||
      plan.revision !== (await this.channels.read()).revision
    ) {
      throw new BadRequestException('Create a new update or downgrade review before continuing.');
    }
    await this.requireOperationStatus();
    this.plans.delete(planId);
    return this.call('/v1/apply', { planId });
  }

  recover(jobId: unknown): Promise<{ jobId: string; state: string }> {
    if (typeof jobId !== 'string' || !PLAN_ID.test(jobId)) {
      throw new BadRequestException('Choose an interrupted update job.');
    }
    return this.call('/v1/recover', { jobId });
  }
}
