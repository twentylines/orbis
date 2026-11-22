import type { Stats } from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentinelService } from './sentinel.service';

const planId = '11111111-2222-4333-8444-555555555555';
const base = '/v1/sentinel/controller-handoff';
const endpoint = '/run/orbis/host.sock';
const planned = {
  version: 1,
  planId,
  state: 'planned',
  phase: 'planned',
  portalUrl: 'https://sentinel.example.test:9443/sentinel/recovery/',
  expiresAtMs: 1700000000000,
};
const goodSocket = { isSocket: () => true, uid: 0, mode: 0o140600, dev: 1, ino: 2, ctimeMs: 3 } as Stats;

class FixtureService extends SentinelService {
  inspections = 0;
  replaced = false;

  protected override async socketInfo() {
    this.inspections++;
    return this.replaced && this.inspections > 1 ? { ...goodSocket, ino: 3 } : goodSocket;
  }
}

function exchange(payload: unknown, statusCode = 200) {
  const seen: { options: http.RequestOptions; body: string | undefined }[] = [];
  const request = (options: http.RequestOptions, respond: (response: http.IncomingMessage) => void) => {
    const outgoing = new PassThrough();
    const response = Object.assign(new PassThrough(), { statusCode });
    outgoing.on('data', (body: Buffer) => {
      const next = seen.at(-1);
      if (next) next.body = body.toString('utf8');
    });
    outgoing.on('finish', () => {
      respond(response as unknown as http.IncomingMessage);
      response.end(JSON.stringify(payload));
    });
    seen.push({ options, body: undefined });
    return outgoing;
  };
  vi.stubEnv('ORBIS_HOST_SOCKET', endpoint);
  const spy = vi.spyOn(http, 'request');
  spy.mockImplementation(request as unknown as typeof http.request);
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('fixed Main controller handoff adapter', () => {
  it('reviews an empty body on the fixed protected path', async () => {
    const seen = exchange(planned);
    const { version: _, ...result } = planned;
    await expect(new FixtureService().reviewControllerHandoff({})).resolves.toEqual(result);
    expect(seen).toEqual([
      {
        options: expect.objectContaining({
          socketPath: endpoint,
          path: `${base}/plan`,
          method: 'POST',
          headers: { Host: 'orbis', 'Content-Type': 'application/json', 'Content-Length': 2 },
        }),
        body: '{}',
      },
    ]);
  });

  it('applies only the reviewed ID and accepts a durable 202', async () => {
    const seen = exchange({ ...planned, state: 'accepted', phase: 'accepted' }, 202);
    await expect(new FixtureService().applyControllerHandoff({ planId })).resolves.toMatchObject({ planId, state: 'accepted' });
    expect(seen[0]?.options.path).toBe(`${base}/apply`);
    expect(seen[0]?.body).toBe(JSON.stringify({ planId }));
  });

  it('projects attention on a fixed read-only URL', async () => {
    const seen = exchange({ ...planned, state: 'attention', phase: 'stopping' });
    await expect(new FixtureService().controllerHandoffStatus(planId)).resolves.toMatchObject({ state: 'attention', phase: 'stopping' });
    expect(seen[0]?.options).toMatchObject({ path: `${base}/${planId}/status`, method: 'GET', headers: { Host: 'orbis' } });
    expect(seen[0]?.body).toBeUndefined();
  });

  it('refuses a different receipt ID and a swapped protected socket', async () => {
    exchange({ ...planned, planId: '11111111-2222-4333-8444-555555555556' });
    await expect(new FixtureService().controllerHandoffStatus(planId)).rejects.toThrow('Unable to verify');
    const replaced = new FixtureService();
    replaced.replaced = true;
    await expect(replaced.reviewControllerHandoff({})).rejects.toThrow('Unable to verify');
  });

  it('rejects client destinations and malformed IDs before making a request', async () => {
    const seen = exchange(planned);
    const client = new FixtureService();
    await expect(client.reviewControllerHandoff({ portalUrl: planned.portalUrl })).rejects.toThrow('does not accept options');
    await expect(client.applyControllerHandoff({ planId, command: 'restart' })).rejects.toThrow('Confirm one reviewed');
    await expect(client.controllerHandoffStatus(`${planId}/../../status`)).rejects.toThrow('Choose one reviewed');
    expect(seen).toEqual([]);
  });
});
