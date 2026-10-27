import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DriveHealthService } from '../system/drive-health.service';
import { HostUpdatesService } from './host-updates.service';

describe('host update Unix socket transport', () => {
  let directory: string;
  let server: http.Server;
  let service: HostUpdatesService;
  const originalSocket = process.env.ORBIS_HOST_SOCKET;
  const originalVersion = process.env.ORBIS_VERSION;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let selectedChannel: { version: 1; channel: 'stable' | 'nightly'; revision: string } = { version: 1, channel: 'nightly', revision: 'initial' };
  const channels = {
    read: vi.fn(async () => selectedChannel),
    status: vi.fn(),
  };
  let restartSupported = true;
  let packageReview: Record<string, unknown> = {
    planId: '00000000-0000-4000-8000-000000000000',
    createdAt: 1_700_000_000,
    selected: [{ name: 'base-files:arm64' }],
    operations: [],
  };
  let driveResponse: 'accepted' | 'declined' | 'failed' = 'accepted';
  const drives = mock<DriveHealthService>();

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-host-transport-'));
    const socketPath = path.join(directory, 'host.sock');
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        requests.push({ method: request.method || '', path: request.url || '', body });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/drives/test') {
          response.statusCode = driveResponse === 'failed' ? 503 : 202;
          response.end(JSON.stringify({ accepted: driveResponse === 'accepted', message: 'Self-test request result.' }));
          return;
        }
        if (request.url?.startsWith('/v1/restart')) {
          response.statusCode = restartSupported ? 200 : 404;
          response.end(
            JSON.stringify(
              restartSupported
                ? request.url === '/v1/restart'
                  ? { available: true, job: null }
                  : request.url === '/v1/restart/plan'
                    ? { planId: '00000000-0000-4000-8000-000000000000', expiresAt: 123, rebootRequired: true }
                    : { jobId: '00000000-0000-4000-8000-000000000000', state: 'restarting' }
                : { error: 'not found' },
            ),
          );
          return;
        }
        response.end(
          JSON.stringify(
            request.url === '/v1/status'
              ? { available: true, enrolled: true, capabilities: ['release-channels.v1'] }
              : request.url === '/v1/packages'
                ? { available: true, packageCount: 1, packages: [] }
                : request.url === '/v1/packages/job'
                  ? { available: true, job: null }
                  : request.url === '/v1/packages/plan'
                    ? packageReview
                    : request.url === '/v1/packages/apply' || request.url === '/v1/packages/refresh'
                      ? { jobId: '00000000-0000-4000-8000-000000000000', state: 'queued' }
                      : request.url?.startsWith('/v1/packages/changelog?')
                        ? { name: 'base-files:arm64', available: true, body: 'Ubuntu changelog' }
                        : { planId: '00000000-0000-4000-8000-000000000000' },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.ORBIS_HOST_SOCKET = socketPath;
    process.env.ORBIS_VERSION = 'v0.1.0-beta.7';
    service = new HostUpdatesService(channels as never, drives);
  });

  afterAll(async () => {
    process.env.ORBIS_HOST_SOCKET = originalSocket;
    if (originalVersion === undefined) delete process.env.ORBIS_VERSION;
    else process.env.ORBIS_VERSION = originalVersion;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('sends fixed status and plan requests through the local socket', async () => {
    expect(await service.status()).toMatchObject({ available: true, enrolled: true });
    expect(await service.plan('v0.1.0-beta.8')).toMatchObject({ planId: '00000000-0000-4000-8000-000000000000' });
    expect(requests).toContainEqual({ method: 'GET', path: '/v1/status', body: null });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/plan', body: { tag: 'v0.1.0-beta.8' } });
  });

  it('prevents generic apply from bypassing downgrade revalidation, including after a core restart', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const installed = process.env.ORBIS_VERSION;
    process.env.ORBIS_VERSION = 'v0.1.0-beta.92';
    try {
      await service.plan('v0.1.0-beta.90', true);
    } finally {
      process.env.ORBIS_VERSION = installed;
    }
    const count = requests.length;
    await expect(service.apply(id)).rejects.toThrow('new update or downgrade review');
    await expect(new HostUpdatesService(channels as never, drives).apply(id)).rejects.toThrow('new update or downgrade review');
    expect(requests).toHaveLength(count);
    await service.apply(id, true);
    expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/apply', body: { planId: id } });
    await expect(service.apply(id, true)).rejects.toThrow('new update or downgrade review');
  });

  it('rejects ordinary downgrade plans and unverifiable installed versions before contacting the host', async () => {
    const planCount = requests.filter((request) => request.path === '/v1/plan').length;
    try {
      for (const version of ['', 'development', 'not-a-version']) {
        process.env.ORBIS_VERSION = version;
        await expect(service.plan('v0.1.0-beta.8')).rejects.toThrow('could not be verified');
      }
      process.env.ORBIS_VERSION = 'v0.1.0-beta.7';
      for (const target of ['v0.1.0-beta.7', 'v0.1.0-beta.6']) await expect(service.plan(target)).rejects.toThrow('downgrade review');
      expect(requests.filter((request) => request.path === '/v1/plan')).toHaveLength(planCount);
    } finally {
      process.env.ORBIS_VERSION = 'v0.1.0-beta.7';
    }
  });

  it('rejects untrusted tags before contacting the host service', async () => {
    const count = requests.length;
    await expect(service.plan('v0.1.0-beta.8; rm -rf /')).rejects.toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
  });

  it('refreshes drive readings after accepted start and stop requests', async () => {
    const before = drives.invalidate.mock.calls.length;
    for (const kind of ['short', 'extended', 'abort']) {
      expect(await service.driveTest(`drive:${'a'.repeat(24)}`, kind)).toMatchObject({ accepted: true });
      expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/drives/test', body: { id: `drive:${'a'.repeat(24)}`, kind } });
    }
    expect(drives.invalidate).toHaveBeenCalledTimes(before + 3);
  });

  it('preserves cached readings when a self-test is rejected or fails', async () => {
    const before = drives.invalidate.mock.calls.length;
    try {
      driveResponse = 'declined';
      expect(await service.driveTest(`drive:${'a'.repeat(24)}`, 'short')).toMatchObject({ accepted: false });
      driveResponse = 'failed';
      await expect(service.driveTest(`drive:${'a'.repeat(24)}`, 'short')).rejects.toThrow();
      const count = requests.length;
      expect(() => service.driveTest('/dev/sda', 'short')).toThrow(BadRequestException);
      expect(requests).toHaveLength(count);
      expect(drives.invalidate).toHaveBeenCalledTimes(before);
    } finally {
      driveResponse = 'accepted';
    }
  });

  it('rejects tags outside the published channel grammar before contacting the host service', async () => {
    const count = requests.length;
    for (const tag of ['v0.1.0-nightly.20261025', 'v0.1.0-dev.1', 'v0.1.0-alpha.1']) {
      await expect(service.plan(tag)).rejects.toThrow(BadRequestException);
      await expect(service.plan(tag, true)).rejects.toThrow(BadRequestException);
    }
    expect(requests).toHaveLength(count);
  });

  it('rejects a beta target on Stable and invalidates a reviewed apply after the channel revision changes', async () => {
    const count = requests.length;
    selectedChannel = { version: 1, channel: 'stable', revision: 'stable-revision' };
    await expect(service.plan('v1.0.1-beta.2')).rejects.toThrow('selected update channel');
    expect(requests).toHaveLength(count);

    selectedChannel = { version: 1, channel: 'nightly', revision: 'nightly-before' };
    await service.plan('v1.0.1-beta.2');
    selectedChannel = { version: 1, channel: 'nightly', revision: 'nightly-after' };
    await expect(service.apply('00000000-0000-4000-8000-000000000000')).rejects.toThrow('new update or downgrade review');
    expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/plan', body: { tag: 'v1.0.1-beta.2' } });
  });

  it('reads packages and a fixed candidate changelog through the socket', async () => {
    expect(await service.packages()).toMatchObject({ available: true, packageCount: 1 });
    expect(await service.packageChangelog('base-files:arm64')).toMatchObject({ available: true, name: 'base-files:arm64' });
    expect(requests).toContainEqual({ method: 'GET', path: '/v1/packages', body: null });
    expect(requests).toContainEqual({ method: 'GET', path: '/v1/packages/changelog?name=base-files%3Aarm64', body: null });
  });

  it('rejects package names with query syntax before contacting the socket', async () => {
    const count = requests.length;
    expect(() => service.packageChangelog('base-files&name=other')).toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
  });

  it('sends reviewed package plan and apply requests with fixed fields', async () => {
    expect(await service.packageJob()).toMatchObject({ available: true, job: null });
    expect(await service.packagePlan(['base-files:arm64'])).toHaveProperty('planId');
    expect(await service.packageApply('00000000-0000-4000-8000-000000000000')).toMatchObject({ state: 'queued' });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/packages/plan', body: { names: ['base-files:arm64'] } });
    expect(requests).toContainEqual({
      method: 'POST',
      path: '/v1/packages/apply',
      body: { planId: '00000000-0000-4000-8000-000000000000' },
    });
  });

  it('adds the existing expiry contract for older package helpers', async () => {
    const plan = await service.packagePlan(['base-files:arm64']);
    expect(plan.createdAt).toBe(1_700_000_000);
    expect(plan.expiresAt).toBe(1_700_000_900);
  });

  it('preserves an explicit earlier package-review deadline in Unix seconds', async () => {
    const previous = packageReview;
    try {
      packageReview = { ...previous, expiresAt: 1_700_000_120 };
      expect((await service.packagePlan(['base-files:arm64'])).expiresAt).toBe(1_700_000_120);
    } finally {
      packageReview = previous;
    }
  });

  it('rejects invalid package reviews or a different selection before any apply request', async () => {
    const previous = packageReview;
    const count = requests.length;
    try {
      for (const change of [
        { createdAt: '1700000000' },
        { expiresAt: null },
        { expiresAt: 1_700_000_000 },
        { expiresAt: 1_700_001_000 },
        { selected: [{ name: 'other-package:arm64' }] },
        { operations: null },
      ]) {
        packageReview = { ...previous, ...change };
        await expect(service.packagePlan(['base-files:arm64'])).rejects.toThrow('invalid package review');
      }
      expect(requests.slice(count).every((item) => item.path === '/v1/packages/plan')).toBe(true);
    } finally {
      packageReview = previous;
    }
  });

  it('refreshes through the fixed host endpoint with no command or package options', async () => {
    expect(await service.packageRefresh()).toMatchObject({ jobId: '00000000-0000-4000-8000-000000000000', state: 'queued' });
    expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/packages/refresh', body: {} });
  });

  it('rejects malformed package plans before sending them to the host', () => {
    const count = requests.length;
    expect(() => service.packagePlan(['base-files:arm64', 'base-files:arm64'])).toThrow(BadRequestException);
    expect(() => service.packagePlan(['--option'])).toThrow(BadRequestException);
    expect(() => service.packageApply('anything')).toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
  });

  it('sends only the reviewed restart ID and fixed restart paths to the host', async () => {
    const planId = '00000000-0000-4000-8000-000000000000';
    expect(await service.restartStatus()).toEqual({ available: true, job: null });
    expect(await service.restartPlan()).toEqual({ planId, expiresAt: 123, rebootRequired: true });
    expect(await service.restartApply(planId)).toEqual({ jobId: planId, state: 'restarting' });
    expect(requests).toContainEqual({ method: 'GET', path: '/v1/restart', body: null });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/restart/plan', body: {} });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/restart/apply', body: { planId } });
    const count = requests.length;
    expect(() => service.restartApply('restart; shell')).toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
  });

  it('explains old helper capability instead of presenting an unusable restart', async () => {
    restartSupported = false;
    try {
      expect(await service.restartStatus()).toEqual({
        available: false,
        reason: 'Update the Orbis host service to enable server restarts.',
        job: null,
      });
      await expect(service.restartPlan()).rejects.toThrow('Update the Orbis host service to enable server restarts.');
      await expect(service.restartApply('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
        'Update the Orbis host service to enable server restarts.',
      );
    } finally {
      restartSupported = true;
    }
  });
});
