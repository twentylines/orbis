import { type ClientRequest, type IncomingMessage, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';

type GitHttpLimits = { idleTimeoutMs: number; operationTimeoutMs: number };
const defaultLimits: GitHttpLimits = { idleTimeoutMs: 30_000, operationTimeoutMs: 600_000 };

export class GitNetworkTimeoutError extends Error {
  constructor(public readonly kind: 'idle' | 'operation') {
    super(kind === 'idle' ? 'App store connection stopped responding.' : 'App store download exceeded its time limit.');
    this.name = 'GitNetworkTimeoutError';
  }
}

export async function withGitHttp<T>(operation: (http: HttpClient) => Promise<T>, limits: GitHttpLimits = defaultLimits): Promise<T> {
  const controller = new AbortController();
  const pending = new Set<() => Promise<void>>();
  const deadline = setTimeout(() => controller.abort(new GitNetworkTimeoutError('operation')), limits.operationTimeoutMs);
  deadline.unref();

  const request = async (input: GitHttpRequest, redirects = 0): Promise<GitHttpResponse> => {
    controller.signal.throwIfAborted();
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('App store URL must use HTTP or HTTPS.');
    const method = input.method ?? 'GET';
    const signal = input.signal instanceof AbortSignal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let download: Readable | undefined;
    let upload: Readable | undefined;
    let cleaned: Promise<void> | undefined;
    const clearIdle = () => clearTimeout(idle);
    const armIdle = () => {
      clearIdle();
      idle = setTimeout(() => controller.abort(new GitNetworkTimeoutError('idle')), limits.idleTimeoutMs);
      idle.unref();
    };
    const stopUpload = () => upload?.destroy();
    const cleanup = () => {
      cleaned ??= (async () => {
        clearIdle();
        signal.removeEventListener('abort', stopUpload);
        const closed = outgoing && !outgoing.closed ? new Promise<void>((resolve) => outgoing?.once('close', resolve)) : Promise.resolve();
        stopUpload();
        download?.destroy();
        incoming?.destroy();
        outgoing?.destroy();
        await closed;
        pending.delete(cleanup);
      })();
      return cleaned;
    };
    pending.add(cleanup);

    try {
      const headers = { ...input.headers };
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate, br';
      const buffered = Array.isArray(input.body) ? Buffer.concat(input.body.map((chunk: Uint8Array) => Buffer.from(chunk))) : undefined;
      if (buffered && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length'))
        headers['content-length'] = String(buffered.length);
      signal.addEventListener('abort', stopUpload, { once: true });
      armIdle();
      incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, agent: input.agent, signal }, (response) => {
          response.on('error', () => undefined);
          resolve(response);
        });
        outgoing.on('error', (error) => {
          download?.destroy(error);
          reject(error);
        });
        if (buffered) outgoing.end(buffered);
        else if (input.body) {
          const body = input.body;
          upload = Readable.from(
            (async function* () {
              for await (const chunk of body) {
                signal.throwIfAborted();
                armIdle();
                yield chunk;
              }
            })(),
            { objectMode: false },
          );
          pipeline(upload, outgoing, (error) => {
            if (error) {
              download?.destroy(error);
              reject(error);
            }
          });
        } else outgoing.end();
      });
      clearIdle();
      const statusCode = incoming.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && incoming.headers.location) {
        if (redirects >= 10) throw new Error('App store connection exceeded its redirect limit.');
        const next = new URL(incoming.headers.location, url);
        const nextHeaders = { ...input.headers };
        if (next.origin !== url.origin) {
          for (const key of Object.keys(nextHeaders)) {
            if (['authorization', 'proxy-authorization', 'cookie', 'host'].includes(key.toLowerCase())) delete nextHeaders[key];
          }
        }
        const toGet = statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST');
        if (toGet) {
          for (const key of Object.keys(nextHeaders)) {
            if (['content-type', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) delete nextHeaders[key];
          }
        } else if (input.body && !buffered) throw new Error('Cannot replay a streaming app store request after a redirect.');
        await cleanup();
        return request(
          { ...input, url: next.href, headers: nextHeaders, method: toGet ? 'GET' : method, body: toGet ? undefined : input.body },
          redirects + 1,
        );
      }

      const encoding = incoming.headers['content-encoding']?.trim().toLowerCase();
      const decoder =
        encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      download = decoder ?? incoming;
      download.on('error', () => undefined);
      if (decoder) pipeline(incoming, decoder, () => undefined);
      const stream = download;
      const responseBody = (async function* () {
        const iterator = stream[Symbol.asyncIterator]();
        try {
          while (true) {
            signal.throwIfAborted();
            armIdle();
            const chunk = await iterator.next();
            clearIdle();
            if (chunk.done) break;
            yield chunk.value as Uint8Array;
          }
        } catch (error) {
          throw signal.aborted ? signal.reason : error;
        } finally {
          await cleanup();
        }
      })();
      return {
        url: url.href,
        method,
        statusCode,
        statusMessage: incoming.statusMessage ?? '',
        headers: Object.fromEntries(
          Object.entries(incoming.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : (value ?? '')]),
        ),
        body: responseBody,
      };
    } catch (error) {
      await cleanup();
      throw signal.aborted ? signal.reason : error;
    }
  };

  try {
    // Await Git itself: the caller's repository lock must cover its filesystem cleanup.
    const result = await operation({ request });
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await Promise.all([...pending].map((cleanup) => cleanup()));
  }
}
