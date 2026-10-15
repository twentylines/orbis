import http from 'node:http';
import path from 'node:path';
import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type HostUpdateStatus = {
  available: boolean;
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

@Injectable()
export class HostUpdatesService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;

  private requireSocket(): string {
    if (!this.socketPath || !path.isAbsolute(this.socketPath) || this.socketPath.includes('\0')) {
      throw new ServiceUnavailableException('The Orbis host service is not connected.');
    }
    return this.socketPath;
  }

  private async call<T>(
    endpoint: '/v1/status' | '/v1/plan' | '/v1/apply' | '/v1/recover' | '/v1/packages' | `/v1/packages/changelog?name=${string}`,
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
          timeout: endpoint === '/v1/plan' ? 90_000 : endpoint.startsWith('/v1/packages/changelog') ? 25_000 : 10_000,
          headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > (endpoint === '/v1/packages' ? 1024 * 1024 : MAX_RESPONSE_BYTES)) {
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

  packages(): Promise<HostPackageInventory> {
    return this.call<HostPackageInventory>('/v1/packages');
  }

  packageChangelog(name: unknown): Promise<HostPackageChangelog> {
    if (typeof name !== 'string' || name.length > 180 || !PACKAGE_NAME.test(name)) {
      throw new BadRequestException('Choose a valid package name.');
    }
    return this.call<HostPackageChangelog>(`/v1/packages/changelog?name=${encodeURIComponent(name)}`);
  }

  plan(tag: unknown): Promise<HostUpdatePlan> {
    if (typeof tag !== 'string' || !TAG.test(tag) || tag.length > 80) {
      throw new BadRequestException('Choose a valid Orbis release tag.');
    }
    return this.call<HostUpdatePlan>('/v1/plan', { tag });
  }

  apply(planId: unknown): Promise<{ jobId: string; state: string }> {
    if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
      throw new BadRequestException('Create a new update plan first.');
    }
    return this.call('/v1/apply', { planId });
  }

  recover(jobId: unknown): Promise<{ jobId: string; state: string }> {
    if (typeof jobId !== 'string' || !PLAN_ID.test(jobId)) {
      throw new BadRequestException('Choose an interrupted update job.');
    }
    return this.call('/v1/recover', { jobId });
  }
}
