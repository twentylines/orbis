import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostUpdatesService } from './host-updates.service';

describe('host update Unix socket transport', () => {
  let directory: string;
  let server: http.Server;
  let service: HostUpdatesService;
  const originalSocket = process.env.ORBIS_HOST_SOCKET;
  const originalVersion = process.env.ORBIS_VERSION;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let restartSupported = true;

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
              ? { available: true, enrolled: true }
              : request.url === '/v1/packages'
                ? { available: true, packageCount: 1, packages: [] }
                : request.url === '/v1/packages/job'
                  ? { available: true, job: null }
                  : request.url === '/v1/packages/plan'
                    ? { planId: '00000000-0000-4000-8000-000000000000', selected: [], operations: [] }
                    : request.url === '/v1/packages/apply'
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
    service = new HostUpdatesService();
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
    await service.plan('v0.1.0-beta.90', true);
    const count = requests.length;
    expect(() => service.apply(id)).toThrow('new update or downgrade review');
    expect(() => new HostUpdatesService().apply(id)).toThrow('new update or downgrade review');
    expect(requests).toHaveLength(count);
    await service.apply(id, true);
    expect(requests.at(-1)).toEqual({ method: 'POST', path: '/v1/apply', body: { planId: id } });
    expect(() => service.apply(id, true)).toThrow('new update or downgrade review');
  });

  it('rejects ordinary downgrade plans and unverifiable installed versions before contacting the host', () => {
    const count = requests.length;
    try {
      for (const version of ['', 'development', 'not-a-version']) {
        process.env.ORBIS_VERSION = version;
        expect(() => service.plan('v0.1.0-beta.8')).toThrow('could not be verified');
      }
      process.env.ORBIS_VERSION = 'v0.1.0-beta.7';
      for (const target of ['v0.1.0-beta.7', 'v0.1.0-beta.6']) expect(() => service.plan(target)).toThrow('downgrade review');
      expect(requests).toHaveLength(count);
    } finally {
      process.env.ORBIS_VERSION = 'v0.1.0-beta.7';
    }
  });

  it('rejects untrusted tags before contacting the host service', async () => {
    const count = requests.length;
    expect(() => service.plan('v0.1.0-beta.8; rm -rf /')).toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
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
