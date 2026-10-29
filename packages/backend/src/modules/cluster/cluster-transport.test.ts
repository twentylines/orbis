import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clusterRequest } from './cluster-transport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function respond(status: number, body: string) {
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    expect(options.hostname).toBe('192.168.1.20');
    expect(options.path).toBe('/api/cluster/peer');
    const request = new EventEmitter() as http.ClientRequest;
    request.end = (() => {
      queueMicrotask(() => {
        const stream = new PassThrough();
        const response = stream as unknown as http.IncomingMessage;
        response.statusCode = status;
        response.once('end', () => request.emit('close'));
        callback(response);
        stream.end(body);
      });
      return request;
    }) as typeof request.end;
    request.destroy = ((error?: Error) => {
      request.emit('close');
      if (error) request.emit('error', error);
      return request;
    }) as typeof request.destroy;
    return request;
  }) as typeof http.request);
}

const read = () => clusterRequest('http://192.168.1.20', '/api/cluster/peer', { action: 'command', command: 'plan-orbis' }, {}, true);

describe('paired server responses', () => {
  it('bounds a stalled request by its absolute deadline', async () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const destroy = vi.fn((error?: Error) => {
      emitter.emit('close');
      if (error) emitter.emit('error', error);
    });
    vi.spyOn(http, 'request').mockReturnValue(Object.assign(emitter, { end: vi.fn(), destroy }) as unknown as http.ClientRequest);
    const pending = read();
    const rejected = expect(pending).rejects.toThrow('Cannot reach the paired server');
    await vi.advanceTimersByTimeAsync(11999);
    expect(destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await rejected;
    expect(destroy).toHaveBeenCalledTimes(1);
  });
  it('preserves the actionable host-update refusal returned by a member', async () => {
    respond(409, JSON.stringify({ statusCode: 409, message: 'Stop installed apps before updating Orbis.' }));
    await expect(read()).rejects.toThrow('Paired server: Stop installed apps before updating Orbis.');
  });

  it.each([400, 403, 404, 422, 429])('reports a structured member refusal for status %s', async (status) => {
    respond(status, JSON.stringify({ message: 'The reviewed plan expired. Create a new plan.' }));
    await expect(read()).rejects.toThrow('Paired server: The reviewed plan expired. Create a new plan.');
  });

  it.each([
    '<html>Proxy error</html>',
    JSON.stringify({ message: ['Invalid parameter'] }),
    JSON.stringify({ message: 'x'.repeat(513) }),
    JSON.stringify({ message: 'Do this\nthen that' }),
    JSON.stringify({ message: '   ' }),
  ])('keeps the status fallback for malformed or unbounded error details', async (body) => {
    respond(409, body);
    await expect(read()).rejects.toThrow('The paired server refused the request (409).');
  });

  it.each([301, 401, 500, 502])('does not expose internal or unauthenticated details for status %s', async (status) => {
    respond(status, JSON.stringify({ message: 'Internal implementation details' }));
    await expect(read()).rejects.toThrow(`The paired server refused the request (${status}).`);
  });

  it('continues returning successful JSON responses', async () => {
    respond(200, JSON.stringify({ planId: 'reviewed-plan' }));
    await expect(read()).resolves.toEqual({ planId: 'reviewed-plan' });
  });
});
