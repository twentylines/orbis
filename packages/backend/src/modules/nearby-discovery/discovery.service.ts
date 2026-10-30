import http from 'node:http';
import path from 'node:path';
import { isIP } from 'node:net';
import { BadRequestException, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { installationMode } from '@/common/installation-mode';
import { TransferTransport } from '../host-transfer/transfer-transport';
import { discoveryBody, discoveryInterface, discoveryResponse, discoveryUnavailable } from './discovery.contracts';

@Injectable()
export class NearbyDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<unknown> = Promise.resolve();
  private reconciliation?: Promise<unknown>;
  private policyPending = false;
  private stopped = false;
  constructor(
    private readonly transport: TransferTransport,
    private readonly config: ConfigurationService,
  ) {}

  onModuleInit() {
    if (!this.socketPath || this.config.get('demoMode')) return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.writes.catch(() => undefined).then(work);
    this.writes = operation;
    return operation;
  }
  private async secureEndpoint() {
    const { localDomain, sslPort } = this.config.get('userSettings');
    const port = Number(sslPort);
    if (
      typeof localDomain !== 'string' ||
      localDomain.length > 200 ||
      !/^[a-zA-Z0-9.-]+$/.test(localDomain) ||
      isIP(localDomain) ||
      !localDomain.includes('.') ||
      localDomain.startsWith('.') ||
      localDomain.endsWith('.') ||
      localDomain.includes('..') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new BadRequestException('Configure this server’s private HTTPS hostname before enabling nearby discovery.');
    const target = await this.transport.resolve(`https://${localDomain}${port === 443 ? '' : `:${port}`}`);
    if (target.family !== 4 || target.origin.length > 240) throw new BadRequestException('Nearby discovery requires a private IPv4 HTTPS hostname.');
    const inventory = await this.read('interfaces');
    const matches = inventory.available && inventory.interfaces ? inventory.interfaces.filter((item) => item.address === target.address) : [];
    const selected = matches[0];
    if (matches.length !== 1 || !selected) throw new BadRequestException('A unique private LAN interface must match this server’s HTTPS address.');
    return { interface: selected.id, origin: target.origin, address: target.address };
  }
  private async configuredEndpoint(addressHints: boolean) {
    try {
      return await this.secureEndpoint();
    } catch (error) {
      if (!addressHints) throw error;
      const configuredPort: unknown = this.config.get('userSettings').port;
      const port =
        typeof configuredPort === 'number' || (typeof configuredPort === 'string' && /^\d{1,5}$/.test(configuredPort))
          ? Number(configuredPort)
          : Number.NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestException('The configured local HTTP port is unavailable.');
      const inventory = await this.read('interfaces');
      const interfaces = inventory.available && inventory.interfaces ? inventory.interfaces : [];
      const matches = interfaces.length === 1 ? interfaces : interfaces.filter((item) => item.preferred);
      if (matches.length !== 1 || !matches[0]) throw new BadRequestException('A unique eligible private LAN interface is required for discovery.');
      return { kind: 'address' as const, interface: matches[0].id, port };
    }
  }
  reconcile() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.serialize(async () => {
      if (this.stopped || installationMode().phase !== 'normal') return discoveryUnavailable();
      const current = await this.status();
      if (!current.available || !('enabled' in current) || !current.enabled) return current;
      try {
        const endpoint = await this.configuredEndpoint('hintVersion' in current && current.hintVersion === 2);
        if (this.stopped || installationMode().phase !== 'normal') return discoveryUnavailable();
        if ('kind' in endpoint) return await this.read('configure-address', { interface: endpoint.interface, port: endpoint.port });
        return await this.read('configure', endpoint);
      } catch {
        await this.read('suspend', {});
        return this.status();
      }
    }).finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }

  private request(
    action: 'status' | 'interfaces' | 'scan' | 'advertise' | 'disable' | 'configure' | 'configure-address' | 'policy' | 'suspend',
    body?: object,
  ): Promise<unknown> {
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
  private async read(
    action: 'status' | 'interfaces' | 'scan' | 'advertise' | 'disable' | 'configure' | 'configure-address' | 'policy' | 'suspend',
    body?: object,
  ) {
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
    return this.policy({ enabled: false });
  }
  policy(input: unknown) {
    const body = discoveryBody(input, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('Choose whether nearby discovery is allowed.');
    if (this.policyPending) throw new BadRequestException('Wait for the nearby discovery change to finish.');
    this.policyPending = true;
    return this.serialize(async () => {
      if (this.stopped || installationMode().phase !== 'normal') return discoveryUnavailable();
      const enabled = body.enabled;
      const current = enabled ? await this.status() : undefined;
      if (enabled && !current?.available) return discoveryUnavailable();
      const configuration = enabled
        ? await this.configuredEndpoint(Boolean(current && 'hintVersion' in current && current.hintVersion === 2))
        : undefined;
      if (this.stopped || installationMode().phase !== 'normal') return discoveryUnavailable();
      await this.read('policy', { enabled, ...(configuration ? { configuration } : {}) });
      return this.status();
    }).finally(() => {
      this.policyPending = false;
    });
  }
  async advertise(input: unknown) {
    discoveryBody(input, ['interface', 'origin', 'leaseSeconds']);
    return discoveryUnavailable();
  }
}
