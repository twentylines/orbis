import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ClusterCertificate } from './cluster-certificate';

export const CLUSTER_PROTOCOL = 'orbis.cluster.v1';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(address) === 6 && /^(fc|fd)[0-9a-f]{2}:/i.test(address);
}

export function clusterOrigin(input: unknown, insecureLan = false): URL {
  if (typeof input !== 'string' || input.length > 2048) throw new BadRequestException('Enter the server address.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException('Enter a complete http:// or https:// server address.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !insecureLan) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new BadRequestException('Use HTTPS, or explicitly allow HTTP on a trusted private LAN. Enter the server origin without a path.');
  return url;
}

export function signedHeaders(id: string, secret: string, body: string, timestamp = Date.now().toString(), nonce = randomBytes(24).toString('hex')) {
  const message = `${CLUSTER_PROTOCOL}\n${id}\n${timestamp}\n${nonce}\n${digest(body)}`;
  return {
    'x-orbis-server': id,
    'x-orbis-time': timestamp,
    'x-orbis-nonce': nonce,
    'x-orbis-signature': createHmac('sha256', secret).update(message).digest('hex'),
  };
}

// Resolve once and pin that address for this connection; never follow redirects.
export async function clusterRequest<T>(
  origin: string,
  endpoint: '/api/cluster/accept' | '/api/cluster/peer' | '/api/cluster/settings-sync/peer',
  body: object,
  headers = {},
  insecureLan = false,
  certificate?: ClusterCertificate,
): Promise<T> {
  const url = clusterOrigin(origin, insecureLan);
  if (certificate && url.protocol !== 'https:') throw new BadRequestException('A confirmed peer certificate requires HTTPS.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const deadline = Date.now() + 12_000;
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ServiceUnavailableException('The server name could not be resolved in time.')), 6000);
        lookup(hostname, { all: true })
          .then(resolve, () => reject(new ServiceUnavailableException('The server name could not be resolved.')))
          .finally(() => clearTimeout(timer));
      });
  if (!addresses.length || addresses.some(({ address }) => !privateAddress(address))) {
    throw new BadRequestException('Pairing currently supports private LAN or VPN addresses. Loopback, link-local and public targets are refused.');
  }
  const target = addresses[0];
  if (!target) throw new BadRequestException('The server address did not resolve.');
  const data = JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      {
        hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: endpoint,
        method: 'POST',
        family: target.family,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        agent: false,
        rejectUnauthorized: true,
        ...(certificate ? { ca: certificate.pem } : {}),
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) request.destroy(new Error('Cluster response exceeded its limit.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            let message = `The paired server refused the request (${response.statusCode ?? 'no response'}).`;
            if ([400, 403, 404, 409, 422, 429].includes(response.statusCode ?? 0)) {
              try {
                const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (result && typeof result === 'object' && 'message' in result) {
                  const reason = result.message;
                  if (typeof reason === 'string' && reason.trim() && reason.length <= 512 && !/\p{Cc}/u.test(reason)) {
                    message = `Paired server: ${reason.trim()}`;
                  }
                }
              } catch {
                // Proxies can return HTML instead of the peer's structured error.
              }
            }
            reject(new ServiceUnavailableException(message));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new ServiceUnavailableException('The paired server returned an invalid response.'));
          }
        });
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('Cluster request timed out.')), Math.max(1, deadline - Date.now()));
    request.on('close', () => clearTimeout(timer));
    request.on('error', () =>
      reject(
        new ServiceUnavailableException(
          'Cannot reach the paired server. Use a hostname matching its HTTPS certificate and check certificate trust and connection.',
        ),
      ),
    );
    request.end(data);
  });
}
