import http from 'node:http';
import path from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TransferTransport } from '../host-transfer/transfer-transport';
import { discoveryBody, discoveryInterface, discoveryLease, discoveryResponse, discoveryUnavailable } from './discovery.contracts';

@Injectable()
export class NearbyDiscoveryService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  constructor(private readonly transport: TransferTransport) {}

  private request(action: 'status' | 'interfaces' | 'scan' | 'advertise' | 'disable', body?: object): Promise<unknown> {
    if (!this.socketPath || !path.isAbsolute(this.socketPath) || this.socketPath.includes('\0')) return Promise.resolve(discoveryUnavailable());
    return new Promise((resolve) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: `/v1/discovery/${action}`,
          method: payload === undefined ? 'GET' : 'POST',
          signal: AbortSignal.timeout(8000),
          headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('error', () => resolve(discoveryUnavailable()));
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 32 * 1024) response.destroy();
            else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              resolve(response.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : discoveryUnavailable());
            } catch {
              resolve(discoveryUnavailable());
            }
          });
        },
      );
      request.on('error', () => resolve(discoveryUnavailable()));
      request.end(payload);
    });
  }
  private async read(action: 'status' | 'interfaces' | 'scan' | 'advertise' | 'disable', body?: object) {
    try {
      return discoveryResponse(await this.request(action, body), action === 'interfaces' || action === 'scan' ? action : 'status');
    } catch {
      return discoveryUnavailable();
    }
  }
  status() {
    return this.read('status');
  }
  interfaces() {
    return this.read('interfaces');
  }
  scan(input: unknown) {
    const body = discoveryBody(input, ['interface']);
    return this.read('scan', { interface: discoveryInterface(body.interface) });
  }
  disable(input: unknown) {
    discoveryBody(input, []);
    return this.read('disable', {});
  }
  async advertise(input: unknown) {
    const body = discoveryBody(input, ['interface', 'origin', 'leaseSeconds']);
    const selected = discoveryInterface(body.interface);
    const seconds = discoveryLease(body.leaseSeconds);
    const target = await this.transport.resolve(body.origin);
    if (target.family !== 4 || target.origin.length > 240 || target.port === '0')
      throw new BadRequestException('Nearby discovery requires a private IPv4 HTTPS address.');
    return this.read('advertise', { interface: selected, origin: target.origin, address: target.address, leaseSeconds: seconds });
  }
}
