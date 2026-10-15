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
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

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
        response.end(JSON.stringify(request.url === '/v1/status' ? { available: true, enrolled: true } : { planId: 'fixture-plan' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.ORBIS_HOST_SOCKET = socketPath;
    service = new HostUpdatesService();
  });

  afterAll(async () => {
    process.env.ORBIS_HOST_SOCKET = originalSocket;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('sends fixed status and plan requests through the local socket', async () => {
    expect(await service.status()).toMatchObject({ available: true, enrolled: true });
    expect(await service.plan('v0.1.0-beta.8')).toMatchObject({ planId: 'fixture-plan' });
    expect(requests).toContainEqual({ method: 'GET', path: '/v1/status', body: null });
    expect(requests).toContainEqual({ method: 'POST', path: '/v1/plan', body: { tag: 'v0.1.0-beta.8' } });
  });

  it('rejects untrusted tags before contacting the host service', async () => {
    const count = requests.length;
    expect(() => service.plan('v0.1.0-beta.8; rm -rf /')).toThrow(BadRequestException);
    expect(requests).toHaveLength(count);
  });
});
