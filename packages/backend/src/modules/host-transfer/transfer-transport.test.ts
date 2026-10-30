import { lookup } from 'node:dns/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { privateTransferAddress, TransferTransport, transferOrigin } from './transfer-transport';

const state = vi.hoisted(() => ({
  addresses: [{ address: '192.168.20.5', family: 4 }],
  requests: [] as Record<string, unknown>[],
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' } as Record<string, string>,
    chunks: ['{"status":"approved"}'] as (string | Buffer)[],
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => state.addresses) }));
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  return {
    default: {
      request: (options: Record<string, unknown>, callback: (response: unknown) => void) => {
        state.requests.push(options);
        const request = Object.assign(new EventEmitter(), {
          setTimeout: vi.fn(),
          destroy: (error?: Error) => {
            if (error) request.emit('error', error);
            request.emit('close');
          },
          end: () => {
            queueMicrotask(() => {
              const response = Object.assign(Readable.from(state.response.chunks.map((chunk) => Buffer.from(chunk))), {
                statusCode: state.response.status,
                headers: state.response.headers,
              });
              response.once('close', () => request.emit('close'));
              callback(response);
            });
          },
        });
        return request;
      },
    },
  };
});
const transport = new TransferTransport();
beforeEach(() => {
  vi.clearAllMocks();
  state.addresses = [{ address: '192.168.20.5', family: 4 }];
  state.requests = [];
  state.response = { status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"status":"approved"}'] };
});
afterEach(() => vi.useRealTimers());

it.each(['8.8.8.8', '127.0.0.1', '169.254.1.1', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
  'refuses non-LAN addresses: %s',
  (address) => {
    expect(privateTransferAddress(address)).toBe(false);
  },
);
it.each(['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', 'fd12::1234', 'fc12:1234::1', '::ffff:192.168.1.1'])(
  'recognizes private LAN addresses: %s',
  (address) => {
    expect(privateTransferAddress(address)).toBe(true);
  },
);
it.each([
  'http://192.168.1.1',
  'https://user:pass@192.168.1.1',
  'https://192.168.1.1/path',
  'https://192.168.1.1/?token=secret',
  'https://192.168.1.1/#fragment',
  'file:///tmp/file',
  'not-an-address',
])('rejects origins that can expose pairing data: %s', (origin) => {
  expect(() => transferOrigin(origin)).toThrow();
});
it('requires every DNS answer to be private before making any request', async () => {
  state.addresses = [
    { address: '192.168.20.5', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ];
  await expect(transport.resolve('https://source.example.test')).rejects.toThrow('mixed DNS');
  expect(state.requests).toHaveLength(0);
});
it('pins the original resolved address across requests and preserves verified HTTPS identity', async () => {
  const target = await transport.resolve('https://source.example.test:8443');
  state.addresses = [{ address: '8.8.8.8', family: 4 }];
  await expect(transport.json(target, 'status', { claimId: 'fixture', claimToken: 'fixture' }, new AbortController().signal)).resolves.toEqual({
    status: 'approved',
  });
  await transport.json(target, 'status', {}, new AbortController().signal);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(target)).toBe(true);
  const options = state.requests[0];
  if (!options) throw new Error('Expected a pinned HTTPS request');
  expect(options).toMatchObject({
    hostname: 'source.example.test',
    port: '8443',
    rejectUnauthorized: true,
    agent: false,
    path: '/api/system-backups/transfers/peer/status',
  });
  const callback = vi.fn();
  (options.lookup as (host: string, options: object, callback: (...args: unknown[]) => void) => void)('source.example.test', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '192.168.20.5', 4);
  expect(JSON.stringify(options)).not.toContain('claimToken');
});
it.each([301, 302, 307, 308, 403, 500])('refuses status %s without following redirects or exposing remote errors', async (status) => {
  const target = await transport.resolve('https://source.example.test');
  state.response = {
    status,
    headers: { 'content-type': 'application/json', location: 'https://8.8.8.8/private' },
    chunks: ['{"message":"untrusted remote value"}'],
  };
  await expect(transport.json(target, 'claim', {}, new AbortController().signal)).rejects.toThrow('source refused');
  expect(state.requests).toHaveLength(1);
});
it('bounds JSON responses and rejects invalid response types', async () => {
  const target = await transport.resolve('https://source.example.test');
  state.response.chunks = ['x'.repeat(16 * 1024 + 1)];
  await expect(transport.json(target, 'status', {}, new AbortController().signal)).rejects.toThrow('invalid transfer response');
  state.response = { status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<html>proxy</html>'] };
  await expect(transport.json(target, 'status', {}, new AbortController().signal)).rejects.toThrow('invalid transfer response');
});
it('requires exact binary length and hands the encrypted stream to the caller without buffering it', async () => {
  const target = await transport.resolve('https://source.example.test');
  state.response = { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '64' }, chunks: [Buffer.alloc(64)] };
  await expect(transport.download(target, {}, 65, new AbortController().signal)).rejects.toThrow('invalid encrypted backup stream');
  const response = await transport.download(target, {}, 64, new AbortController().signal);
  expect(response.readableFlowing).toBe(null);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toHaveLength(64);
});
it('never opens a request after cancellation and bounds name resolution time', async () => {
  const target = await transport.resolve('https://source.example.test');
  const abort = new AbortController();
  abort.abort();
  await expect(transport.json(target, 'status', {}, abort.signal)).rejects.toThrow();
  expect(state.requests).toHaveLength(0);
  vi.useFakeTimers();
  vi.mocked(lookup).mockReturnValueOnce(new Promise(() => undefined));
  const resolving = transport.resolve('https://source.example.test');
  const rejected = expect(resolving).rejects.toThrow('resolved in time');
  await vi.advanceTimersByTimeAsync(6001);
  await rejected;
});
it('receiver-request peer endpoints keep exact pinned private HTTPS paths, native verification and body bounds', async () => {
  const target = await transport.resolve('https://source.example.test');
  for (const endpoint of ['request', 'request-status', 'request-cancel'] as const) {
    await transport.json(target, endpoint, { version: 1 }, new AbortController().signal);
    expect(state.requests.at(-1)).toMatchObject({ path: `/api/system-backups/transfers/peer/${endpoint}`, rejectUnauthorized: true, agent: false });
  }
  const count = state.requests.length;
  await expect(transport.json(target, 'request', { padding: 'x'.repeat(1025) }, new AbortController().signal)).rejects.toThrow('too large');
  await expect(transport.json(target, '../settings' as never, {}, new AbortController().signal)).rejects.toThrow('unsupported');
  expect(state.requests).toHaveLength(count);
  state.response = { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '64' }, chunks: [Buffer.alloc(64)] };
  const stream = await transport.download(target, {}, 64, new AbortController().signal, 'request-file');
  expect(state.requests.at(-1)?.path).toBe('/api/system-backups/transfers/peer/request-file');
  expect(stream.readableFlowing).toBe(null);
  stream.destroy();
});
