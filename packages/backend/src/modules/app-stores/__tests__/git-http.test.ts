import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Agent as HttpAgent, type RequestListener, type Server, createServer } from 'node:http';
import { Agent as HttpsAgent, createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import git, { type GitHttpRequest, type GitHttpResponse } from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import { GitNetworkTimeoutError, withGitHttp } from '../git-http';

const servers: Server[] = [];
const intervals: ReturnType<typeof setInterval>[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
const serve = async (listener: RequestListener, port = 0) => {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener did not bind');
  return `http://127.0.0.1:${address.port}`;
};
const collect = async (response: GitHttpResponse) => {
  const chunks: Uint8Array[] = [];
  if (response.body) for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};
const limits = { idleTimeoutMs: 100, operationTimeoutMs: 2_000 };

afterEach(async () => {
  for (const interval of intervals.splice(0)) clearInterval(interval);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('bounded Git HTTP transfers', () => {
  it('streams a redirected response before the server finishes sending it', async () => {
    const firstRead = deferred();
    const base = await serve(async (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/repository' }).end();
        return;
      }
      expect(request.headers['x-fixture']).toBe('owned');
      response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      response.write('first');
      await firstRead.promise;
      response.end('last');
    });
    await withGitHttp(async (http) => {
      const response = await http.request({ url: `${base}/redirect`, headers: { 'x-fixture': 'owned' } });
      expect(response.url).toBe(`${base}/repository`);
      expect(response.statusCode).toBe(200);
      expect(response.headers?.['content-type']).toBe('application/x-git-upload-pack-result');
      const iterator = response.body;
      expect(iterator).toBeDefined();
      expect(Buffer.from((await iterator?.next())?.value).toString()).toBe('first');
      firstRead.resolve();
      expect(await collect(response)).toBe('last');
    }, limits);
  });

  it('sends the Git request stream without collecting the entire upload', async () => {
    const firstReceived = deferred();
    const base = await serve(async (request, response) => {
      let payload = '';
      for await (const chunk of request) {
        payload += chunk.toString();
        firstReceived.resolve();
      }
      response.end(`${request.method}:${payload}`);
    });
    const body = (async function* () {
      yield Buffer.from('want ');
      await firstReceived.promise;
      yield Buffer.from('fixture');
    })();
    expect(await withGitHttp(async (http) => collect(await http.request({ url: base, method: 'POST', body })), limits)).toBe('POST:want fixture');
  });

  it('replays a buffered Git negotiation body through a 307 redirect', async () => {
    const bodies: string[] = [];
    const base = await serve(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      bodies.push(`${request.method}:${body}`);
      if (request.url === '/redirect') response.writeHead(307, { location: '/repository' }).end();
      else response.end('ok');
    });
    const body = [Buffer.from('want '), Buffer.from('fixture')] as unknown as GitHttpRequest['body'];
    await withGitHttp(async (http) => {
      expect(await collect(await http.request({ url: `${base}/redirect`, method: 'POST', body }))).toBe('ok');
    }, limits);
    expect(bodies).toEqual(['POST:want fixture', 'POST:want fixture']);
  });

  it('strips authorization on a redirect to another origin', async () => {
    let leaked = false;
    const target = await serve((request, response) => {
      leaked = Boolean(request.headers.authorization);
      response.end('ok');
    });
    const base = await serve((_request, response) => response.writeHead(302, { location: target }).end());
    await withGitHttp(async (http) => {
      expect(await collect(await http.request({ url: base, headers: { authorization: 'Basic synthetic-fixture' } }))).toBe('ok');
    }, limits);
    expect(leaked).toBe(false);
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('decodes %s Git discovery responses', async (encoding, compress) => {
    const base = await serve((_request, response) => {
      response.writeHead(200, { 'content-encoding': encoding }).end(compress('fixture advertisement'));
    });
    expect(await withGitHttp(async (http) => collect(await http.request({ url: base })), limits)).toBe('fixture advertisement');
  });

  it('supports valid custom homelab ports excluded by browser fetch', async () => {
    let base: string | undefined;
    for (const port of [10080, 6667, 6697]) {
      try {
        base = await serve((_request, response) => response.end('custom-port'), port);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (!base) throw new Error('The loopback custom-port fixtures are already in use');
    const url = base;
    expect(await withGitHttp(async (http) => collect(await http.request({ url })), limits)).toBe('custom-port');
  });

  it('uses HTTPS with the supplied trusted certificate agent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orbis-tls-test-'));
    let key: string;
    let cert: string;
    try {
      const keyPath = path.join(directory, 'fixture.key');
      const certPath = path.join(directory, 'fixture.crt');
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const server = createHttpsServer({ key, cert }, (_request, response) => response.end('trusted fixture'));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS loopback listener did not bind');
    const url = `https://127.0.0.1:${address.port}`;
    const agent = new HttpsAgent({ ca: cert });
    try {
      expect(await withGitHttp(async (http) => collect(await http.request({ url, agent })), limits)).toBe('trusted fixture');
      await expect(withGitHttp((http) => http.request({ url }), limits)).rejects.toThrow();
    } finally {
      agent.destroy();
    }
  });

  it('rejects a corrupt compressed response and closes the decoder', async () => {
    const base = await serve((_request, response) => response.writeHead(200, { 'content-encoding': 'gzip' }).end('invalid compressed bytes'));
    await expect(withGitHttp(async (http) => collect(await http.request({ url: base })), limits)).rejects.not.toBeInstanceOf(GitNetworkTimeoutError);
  });

  it('aborts a stalled compressed body and settles the decoder', async () => {
    const disconnected = deferred();
    const base = await serve((_request, response) => {
      response.on('close', disconnected.resolve);
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.write(gzipSync('fixture pack').subarray(0, 10));
    });
    await expect(withGitHttp(async (http) => collect(await http.request({ url: base })), limits)).rejects.toMatchObject({ kind: 'idle' });
    await disconnected.promise;
  });

  it('bounds a redirect loop and closes its response streams', async () => {
    let requests = 0;
    const base = await serve((_request, response) => {
      requests++;
      response.writeHead(302, { location: '/loop' }).end();
    });
    await expect(withGitHttp((http) => http.request({ url: base }), limits)).rejects.toThrow('redirect limit');
    expect(requests).toBe(11);
  });

  it('preserves the supplied HTTP agent connection after a completed response', async () => {
    const connections = new Set<number | undefined>();
    const base = await serve((request, response) => {
      connections.add(request.socket.remotePort);
      response.end('complete');
    });
    const agent = new HttpAgent({ keepAlive: true });
    try {
      await withGitHttp(async (http) => {
        expect(await collect(await http.request({ url: base, agent }))).toBe('complete');
        expect(await collect(await http.request({ url: base, agent }))).toBe('complete');
      }, limits);
      expect(connections.size).toBe(1);
    } finally {
      agent.destroy();
    }
  });

  it('aborts a connection that never supplies response headers', async () => {
    const disconnected = deferred();
    const base = await serve((request) => request.on('close', disconnected.resolve));
    await expect(withGitHttp((http) => http.request({ url: base }), limits)).rejects.toMatchObject({ name: 'GitNetworkTimeoutError', kind: 'idle' });
    await disconnected.promise;
  });

  it('aborts a response that stalls after its first bytes', async () => {
    const disconnected = deferred();
    const base = await serve((_request, response) => {
      response.on('close', disconnected.resolve);
      response.writeHead(200);
      response.write('partial pack');
    });
    await expect(withGitHttp(async (http) => collect(await http.request({ url: base })), limits)).rejects.toMatchObject({
      name: 'GitNetworkTimeoutError',
      kind: 'idle',
    });
    await disconnected.promise;
  });

  it('reports an interrupted body without waiting for the idle timeout', async () => {
    const consumed = deferred();
    const base = await serve(async (_request, response) => {
      response.writeHead(200);
      response.write('partial');
      await consumed.promise;
      response.destroy();
    });
    await expect(
      withGitHttp(async (http) => {
        const response = await http.request({ url: base });
        await response.body?.next();
        consumed.resolve();
        return collect(response);
      }, limits),
    ).rejects.not.toBeInstanceOf(GitNetworkTimeoutError);
  });

  it('allows a progressing download to outlast the network idle limit', async () => {
    const base = await serve((_request, response) => {
      response.writeHead(200);
      let sent = 0;
      const interval = setInterval(() => {
        response.write('x');
        if (++sent === 8) {
          clearInterval(interval);
          response.end();
        }
      }, 25);
      intervals.push(interval);
    });
    expect(await withGitHttp(async (http) => collect(await http.request({ url: base })), limits)).toBe('xxxxxxxx');
  });

  it('does not count consumer processing time as network inactivity', async () => {
    const base = await serve((_request, response) => response.end('complete'));
    await withGitHttp(async (http) => {
      const response = await http.request({ url: base });
      expect(Buffer.from((await response.body?.next())?.value).toString()).toBe('complete');
      await delay(180);
      expect(await collect(response)).toBe('');
    }, limits);
  });

  it('applies one total deadline across multiple progressing requests', async () => {
    let requests = 0;
    const base = await serve((_request, response) => {
      requests++;
      response.end('ok');
    });
    await expect(
      withGitHttp(
        async (http) => {
          while (true) {
            await collect(await http.request({ url: base }));
            await delay(30);
          }
        },
        { ...limits, operationTimeoutMs: 180 },
      ),
    ).rejects.toMatchObject({ name: 'GitNetworkTimeoutError', kind: 'operation' });
    expect(requests).toBeGreaterThan(1);
  });

  it('cancels an unread response when the Git operation finishes', async () => {
    const disconnected = deferred();
    const base = await serve((_request, response) => {
      response.on('close', disconnected.resolve);
      response.writeHead(200);
      response.write('unread');
    });
    await withGitHttp(async (http) => {
      await http.request({ url: base });
    }, limits);
    await disconnected.promise;
  });

  it('honors caller cancellation as well as its own limits', async () => {
    const requested = deferred();
    const disconnected = deferred();
    const base = await serve((request) => {
      request.on('close', disconnected.resolve);
      requested.resolve();
    });
    const controller = new AbortController();
    const result = withGitHttp((http) => http.request({ url: base, signal: controller.signal }), limits);
    const rejected = expect(result).rejects.toThrow('fixture cancelled');
    await requested.promise;
    controller.abort(new Error('fixture cancelled'));
    await rejected;
    await disconnected.promise;
  });

  it('stops a streaming upload when the total deadline expires', async () => {
    const producerStopped = deferred();
    const disconnected = deferred();
    const base = await serve((request, response) => {
      response.on('close', disconnected.resolve);
      request.resume();
    });
    const body = (async function* () {
      try {
        while (true) {
          yield Buffer.alloc(1024);
          await delay(20);
        }
      } finally {
        producerStopped.resolve();
      }
    })();
    await expect(
      withGitHttp((http) => http.request({ url: base, method: 'POST', body }), { ...limits, operationTimeoutMs: 180 }),
    ).rejects.toMatchObject({
      kind: 'operation',
    });
    await producerStopped.promise;
    await disconnected.promise;
  });

  it.each([false, true])('works with real smart HTTP discovery (authentication=%s)', async (authenticated) => {
    const sha = 'a'.repeat(40);
    const packet = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
    const advertisement =
      `${packet('# service=git-upload-pack\n')}0000` +
      packet(`${sha} HEAD\0multi_ack thin-pack side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main\n`) +
      `${packet(`${sha} refs/heads/main\n`)}0000`;
    let challenges = 0;
    const base = await serve((request, response) => {
      if (authenticated && request.headers.authorization !== `Basic ${Buffer.from('fixture:synthetic').toString('base64')}`) {
        challenges++;
        response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end('Authentication required');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }).end(advertisement);
    });
    const remote = await withGitHttp(
      (http) => git.getRemoteInfo({ http, url: `${base}/repository.git`, onAuth: () => ({ username: 'fixture', password: 'synthetic' }) }),
      limits,
    );
    expect(remote.HEAD).toBe('refs/heads/main');
    expect(remote.refs?.heads?.main).toBe(sha);
    expect(challenges).toBe(authenticated ? 1 : 0);
  });
});
