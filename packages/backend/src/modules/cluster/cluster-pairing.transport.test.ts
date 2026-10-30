import { EventEmitter } from 'node:events';
import https from 'node:https';
import type http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { clusterRequest } from './cluster-transport';
afterEach(() => vi.restoreAllMocks());
function response(status: number, body: unknown) {
  return vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, callback: (stream: http.IncomingMessage) => void) => {
    expect(options.hostname).toBe('192.168.1.20');
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.path).toBe('/api/cluster/pairing/authorize');
    const request = new EventEmitter() as http.ClientRequest;
    request.end = (() => {
      queueMicrotask(() => {
        const stream = new PassThrough();
        const incoming = stream as unknown as http.IncomingMessage;
        incoming.statusCode = status;
        incoming.once('end', () => request.emit('close'));
        callback(incoming);
        stream.end(JSON.stringify(body));
      });
      return request;
    }) as typeof request.end;
    request.destroy = ((error?: Error) => {
      request.emit('close');
      if (error) request.emit('error', error);
      return request;
    }) as typeof request.destroy;
    return request;
  }) as typeof https.request);
}
const authorize = () =>
  clusterRequest('https://192.168.1.20', '/api/cluster/pairing/authorize', { challenge: 'a'.repeat(64), password: 'remote-unit-password' });
it('refuses plaintext before making an account request even with legacy LAN opt-in', async () => {
  const spy = vi.spyOn(https, 'request');
  await expect(clusterRequest('http://192.168.1.20', '/api/cluster/pairing/authorize', { password: 'unit-password' }, {}, true)).rejects.toThrow(
    'HTTPS',
  );
  expect(spy).not.toHaveBeenCalled();
});
it.each([301, 302, 307, 308])('never follows redirect%s with remote credentials', async (status) => {
  const spy = response(status, { location: 'https://unrelated.example' });
  await expect(authorize()).rejects.toThrow('not confirmed');
  expect(spy).toHaveBeenCalledTimes(1);
});
it.each([401, 403])('keeps remote rejection%s generic', async (status) => {
  response(status, { message: 'private authentication implementation password=hidden' });
  await expect(authorize()).rejects.toThrow('The other server could not authorize pairing.');
});
it('returns exact known expiry and rate-limit guidance only', async () => {
  response(401, { message: 'Pairing code or authorization expired. Generate a new code on the other server.' });
  await expect(authorize()).rejects.toThrow('expired');
  vi.restoreAllMocks();
  response(429, { message: 'private limiter details' });
  await expect(authorize()).rejects.toMatchObject({ status: 429 });
});
it('reports unsupported remote versions without exposing a proxy body', async () => {
  response(404, { message: 'private router details' });
  await expect(authorize()).rejects.toThrow('Update both servers');
});
it('uses only TLS verification and its pinned private destination for a successful response', async () => {
  const spy = response(200, { paired: true });
  await expect(authorize()).resolves.toEqual({ paired: true });
  const options = spy.mock.calls[0]?.[0] as https.RequestOptions;
  const callback = vi.fn();
  (options.lookup as (...args: unknown[]) => void)('192.168.1.20', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '192.168.1.20', 4);
});

it('identifies only the exact remote ingress setup refusal before asking for account credentials', async () => {
  response(403, { message: 'Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.' });
  await expect(authorize()).rejects.toThrow('other server needs private HTTPS and trusted proxy setup');
});
