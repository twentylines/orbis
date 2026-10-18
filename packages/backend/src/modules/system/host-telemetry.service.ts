import http from 'node:http';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type { HostTelemetry, HostNetwork } from '@runtipi/common/schemas';

const unavailable = (reason = 'Host readings are unavailable. Check the Orbis host service.'): HostTelemetry => ({ available: false, reason });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host reading');
  return value as Record<string, unknown>;
}

function text(value: unknown, length = 128): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > length ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Invalid host label');
  return value;
}

function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('Invalid host counter');
  return value;
}

const nullable = (value: unknown) => (value === null ? null : numeric(value));
const integer = (value: unknown) => {
  const n = numeric(value);
  if (!Number.isInteger(n)) throw new Error('Invalid host count');
  return n;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Too many host readings');
  return value;
};

export function parseHostTelemetry(value: unknown, now = Date.now()): HostTelemetry {
  const data = record(value);
  if (data.available === false) return unavailable(data.reason === 'Collecting host readings.' ? data.reason : undefined);
  if (data.available !== true || typeof data.stale !== 'boolean') throw new Error('Invalid host sample');
  const sampledAt = text(data.sampledAt, 40);
  const timestamp = Date.parse(sampledAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(sampledAt) || !Number.isFinite(timestamp) || timestamp > now + 5000) throw new Error('Invalid host timestamp');
  const omitted = record(data.omitted);
  const missing = data.unavailable;
  if (!Array.isArray(missing) || missing.length > 3 || !missing.every((v) => ['filesystems', 'network', 'disks'].includes(v)))
    throw new Error('Invalid host availability');
  return {
    available: true,
    sampledAt,
    stale: data.stale || now - timestamp > 30_000,
    filesystems: list(data.filesystems).map((value) => {
      const row = record(value);
      const sizeBytes = integer(row.sizeBytes);
      const usedBytes = integer(row.usedBytes);
      const availableBytes = integer(row.availableBytes);
      const mount = text(row.mount, 4096);
      if (usedBytes + availableBytes > sizeBytes || !mount.startsWith('/') || typeof row.readOnly !== 'boolean')
        throw new Error('Invalid host filesystem');
      return { mount, filesystem: text(row.filesystem), sizeBytes, usedBytes, availableBytes, readOnly: row.readOnly };
    }),
    network: list(data.network).map((value) => {
      const row = record(value);
      if (!['up', 'down', 'unknown'].includes(row.state as string)) throw new Error('Invalid interface state');
      return {
        interface: text(row.interface),
        state: row.state as HostNetwork['state'],
        speedMbps: nullable(row.speedMbps),
        receivedBytes: nullable(row.receivedBytes),
        transmittedBytes: nullable(row.transmittedBytes),
        rxBytesPerSecond: nullable(row.rxBytesPerSecond),
        txBytesPerSecond: nullable(row.txBytesPerSecond),
      };
    }),
    disks: list(data.disks).map((value) => {
      const row = record(value);
      const busyPercent = nullable(row.busyPercent);
      if (busyPercent !== null && busyPercent > 100) throw new Error('Invalid disk activity');
      return {
        device: text(row.device),
        readBytes: nullable(row.readBytes),
        writtenBytes: nullable(row.writtenBytes),
        readBytesPerSecond: nullable(row.readBytesPerSecond),
        writeBytesPerSecond: nullable(row.writeBytesPerSecond),
        busyPercent,
        inFlight: row.inFlight === null ? null : integer(row.inFlight),
      };
    }),
    omitted: { filesystems: integer(omitted.filesystems), network: integer(omitted.network), disks: integer(omitted.disks) },
    unavailable: missing,
  };
}

@Injectable()
export class HostTelemetryService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  private cached: { expiresAt: number; result: HostTelemetry } | null = null;
  private pending: Promise<HostTelemetry> | null = null;

  read(): Promise<HostTelemetry> {
    if (this.cached && this.cached.expiresAt > Date.now()) return Promise.resolve(this.cached.result);
    if (!this.pending) {
      this.pending = this.fetch()
        .catch(() => unavailable())
        .then((result) => {
          this.cached = { expiresAt: Date.now() + (result.available ? 10_000 : 2000), result };
          return result;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  private async fetch(): Promise<HostTelemetry> {
    const socketPath = this.socketPath;
    if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0'))
      return unavailable('Connect the Orbis host service to see host devices.');
    return new Promise<HostTelemetry>((resolve, reject) => {
      const request = http.request({ socketPath, path: '/v1/telemetry', method: 'GET', signal: AbortSignal.timeout(2000) }, (response) => {
        response.on('error', reject);
        if (response.statusCode !== 200) {
          response.resume();
          resolve(unavailable(response.statusCode === 404 ? 'Update the Orbis host service to see host devices.' : undefined));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) response.destroy(new Error('Host sample exceeds limit'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(parseHostTelemetry(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            reject(new Error('Invalid host sample'));
          }
        });
      });
      request.on('error', reject);
      request.end();
    });
  }
}
