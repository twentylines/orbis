import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { SourceCertificate } from './transfer-certificates';

export const transferLimits = { pendingMs: 5 * 60_000, transferMs: 60 * 60_000, bytes: 1024 ** 4, offers: 4, jobs: 16 } as const;
export type TransferTarget = Readonly<{
  origin: string;
  hostname: string;
  address: string;
  family: number;
  port: string;
  certificate?: SourceCertificate;
}>;
type PeerEndpoint = 'claim' | 'status' | 'file';

export function privateTransferAddress(input: string) {
  const address = input.replace(/^::ffff:/i, '');
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(address) === 6 && /^(fc|fd)[a-f0-9]{2}:/i.test(address);
}

export function transferOrigin(input: unknown) {
  if (typeof input !== 'string' || input.length > 2048) throw new BadRequestException('Enter the private HTTPS address of the source server.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException('Enter a complete private HTTPS server address.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new BadRequestException('Use a private HTTPS server origin without a path, credentials, query or fragment.');
  return url;
}

@Injectable()
export class TransferTransport {
  async resolve(input: unknown, certificate?: SourceCertificate): Promise<TransferTarget> {
    const url = transferOrigin(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ServiceUnavailableException('The source server name could not be resolved in time.')), 6000);
      const operation = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true });
      operation
        .then(resolve, () => reject(new ServiceUnavailableException('The source server name could not be resolved.')))
        .finally(() => clearTimeout(timer));
    });
    if (!addresses.length || addresses.some(({ address }) => !privateTransferAddress(address)))
      throw new BadRequestException('Transfer requires private LAN addresses. Public, loopback, link-local and mixed DNS targets are refused.');
    const target = addresses[0];
    if (!target) throw new BadRequestException('The source server address did not resolve.');
    return Object.freeze({
      origin: url.origin,
      hostname,
      address: target.address,
      family: target.family,
      port: url.port || '443',
      ...(certificate ? { certificate } : {}),
    });
  }

  private response(target: TransferTarget, endpoint: PeerEndpoint, body: object, signal: AbortSignal, binary: boolean) {
    signal.throwIfAborted();
    const data = JSON.stringify(body);
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request(
        {
          hostname: target.hostname,
          port: target.port,
          family: target.family,
          lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
          path: `/api/system-backups/transfers/peer/${endpoint}`,
          method: 'POST',
          agent: false,
          rejectUnauthorized: true,
          ...(target.certificate ? { ca: target.certificate.pem } : {}),
          signal,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Accept: binary ? 'application/octet-stream' : 'application/json',
          },
        },
        (response) => {
          clearTimeout(headersTimer);
          response.on('error', () => undefined);
          if (response.statusCode !== 200) {
            response.destroy();
            reject(new ServiceUnavailableException('The source refused this transfer. Check approval, expiry and the server address.'));
          } else resolve(response);
        },
      );
      const headersTimer = setTimeout(() => request.destroy(new Error('Transfer connection timed out')), 12_000);
      const deadline = setTimeout(() => request.destroy(new Error('Transfer deadline exceeded')), binary ? transferLimits.transferMs : 12_000);
      request.setTimeout(30_000, () => request.destroy(new Error('Transfer connection stalled')));
      request.on('close', () => {
        clearTimeout(headersTimer);
        clearTimeout(deadline);
      });
      request.on('error', () =>
        reject(
          new ServiceUnavailableException(
            'Cannot reach the private source server. Use a hostname matching its HTTPS certificate and check certificate trust and connection.',
          ),
        ),
      );
      request.end(data);
    });
  }

  async json(target: TransferTarget, endpoint: 'claim' | 'status', body: object, signal: AbortSignal): Promise<unknown> {
    const response = await this.response(target, endpoint, body, signal, false);
    try {
      if (response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('Invalid response type');
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > 16 * 1024) throw new Error('Transfer response limit exceeded');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ServiceUnavailableException('The source returned an invalid transfer response.');
    } finally {
      response.destroy();
    }
  }

  async download(target: TransferTarget, body: object, expectedBytes: number, signal: AbortSignal) {
    const response = await this.response(target, 'file', body, signal, true);
    const length = response.headers['content-length'];
    if (
      response.headers['content-type']?.split(';')[0]?.trim() !== 'application/octet-stream' ||
      !length ||
      !/^\d+$/.test(length) ||
      Number(length) !== expectedBytes ||
      expectedBytes < 52 ||
      expectedBytes > transferLimits.bytes
    ) {
      response.destroy();
      throw new ServiceUnavailableException('The source returned an invalid encrypted backup stream.');
    }
    return response;
  }
}
