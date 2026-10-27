import http from 'node:http';
import path from 'node:path';

export async function readHostSocket<T>(
  socketPath: string | undefined,
  endpoint: '/v1/telemetry' | '/v1/processes' | '/v1/sensors' | '/v1/drives',
  parse: (value: unknown) => T,
  unavailable: (reason?: 'missing' | 'older') => T,
): Promise<T> {
  if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0')) return unavailable('missing');
  return new Promise<T>((resolve, reject) => {
    const request = http.request({ socketPath, path: endpoint, method: 'GET', signal: AbortSignal.timeout(2000) }, (response) => {
      response.on('error', reject);
      if (response.statusCode !== 200) {
        response.resume();
        resolve(unavailable(response.statusCode === 404 ? 'older' : undefined));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (endpoint === '/v1/drives' ? 2 * 1024 * 1024 : 256 * 1024)) response.destroy(new Error('Host sample exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve(parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          reject(new Error('Invalid host sample'));
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}
