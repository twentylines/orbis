import http from 'node:http';
import path from 'node:path';
import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { gt, valid } from 'semver';
import {
  isPublishedOrbisReleaseTag,
  isStableOrbisReleaseTag,
  releaseAllowedOnChannel,
  downgradeAllowedOnChannel,
  type OrbisReleaseChannel,
} from '@runtipi/common/schemas/orbis-release-channel';
import { OrbisReleaseChannelsService } from '../system/orbis-release-channels.service';

const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

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
  job?: { id: string; state: string; targetTag: string; startedAt: number; finishedAt?: number; message?: string } | null;
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
  selected: HostPackage[];
  operations: HostPackageOperation[];
};

export type HostPackageJobStatus = {
  available: boolean;
  job: null | {
    id: string;
    kind?: 'refresh';
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
  private readonly plans = new Map<string, { downgrade: boolean; returnToStable: boolean; revision: string; expiresAt: number }>();

  constructor(private readonly channels: OrbisReleaseChannelsService) {}

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
      | `/v1/packages/changelog?name=${string}`,
    body?: object,
  ): Promise<T> {
    const socketPath = this.requireSocket();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: endpoint,
          method: payload === undefined ? 'GET' : 'POST',
          timeout:
            endpoint === '/v1/plan'
              ? 90_000
              : endpoint === '/v1/packages/plan' || endpoint === '/v1/packages/apply' || endpoint === '/v1/packages/refresh'
                ? 60_000
                : endpoint.startsWith('/v1/packages/changelog')
                  ? 25_000
                  : 10_000,
          headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > (endpoint === '/v1/packages' ? 1024 * 1024 : endpoint === '/v1/packages/plan' ? 256 * 1024 : MAX_RESPONSE_BYTES)) {
              res.destroy(new Error('Host service response was too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 502, data: JSON.parse(Buffer.concat(chunks).toString('utf-8')) });
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

  private async requireChannelSupport() {
    const status = await this.status();
    if (!status.available || !status.capabilities?.includes('release-channels.v1')) {
      throw new ServiceUnavailableException('Update the Orbis host service to enable Nightly and reviewed channel changes.');
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
    return this.call<HostPackageJobStatus>('/v1/packages/job');
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
    return this.call<HostPackagePlan>('/v1/packages/plan', { names });
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
