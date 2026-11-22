import http from 'node:http';
import path from 'node:path';

export async function readHostSocket<T>(
  socketPath: string | undefined,
  endpoint: '/v1/telemetry' | '/v1/processes' | '/v1/sensors' | '/v1/drives' | '/v1/sentinel/system-readings',
  parse: (value: unknown) => T,
  unavailable: (reason?: 'missing' | 'older') => T,
): Promise<T> {
  if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0')) return unavailable('missing');
  const sentinel = endpoint === '/v1/sentinel/system-readings';
  const maximum = sentinel ? 16 * 1024 : endpoint === '/v1/drives' ? 2 * 1024 * 1024 : 256 * 1024;
  return new Promise<T>((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method: 'GET', signal: AbortSignal.timeout(sentinel ? 550 : 2000) }, (response) => {
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Host sample is incomplete')));
      if (response.statusCode !== 200) {
        response.resume();
        resolve(unavailable(response.statusCode === 404 ? 'older' : undefined));
        return;
      }
      const length = response.headers['content-length'];
      if (
        sentinel &&
        (response.headers['content-type'] !== 'application/json' ||
          response.headers['content-encoding'] !== undefined ||
          response.headers['transfer-encoding'] !== undefined ||
          !length ||
          !/^[0-9]{1,5}$/.test(length) ||
          Number(length) > maximum)
      ) {
        response.destroy(new Error('Invalid Sentinel sample framing'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) response.destroy(new Error('Host sample exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          const json = sentinel ? new TextDecoder('utf-8', { fatal: true }).decode(body) : body.toString('utf8');
          resolve(parse(JSON.parse(json)));
        } catch {
          reject(new Error('Invalid host sample'));
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}
