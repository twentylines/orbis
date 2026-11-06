import { Injectable } from '@nestjs/common';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const ENDPOINT = '/sentinel/api/v1/status';
const MAX_BYTES = 64 * 1024;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/;
const STATES = ['unknown', 'healthy', 'unavailable', 'updating', 'recovering'] as const;
type ComponentState = (typeof STATES)[number];
export type SentinelStatus = { available: boolean; installedVersion: string | null; availableVersion: string | null; state: ComponentState };
type Component = Omit<SentinelStatus, 'available'>;

function unavailable(): SentinelStatus {
  return { available: false, installedVersion: null, availableVersion: null, state: 'unknown' };
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function component(value: unknown): value is Component {
  if (!exactObject(value, ['installedVersion', 'availableVersion', 'state'])) return false;
  const validVersion = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 128 && VERSION.test(v));
  return (
    validVersion(value.installedVersion) &&
    validVersion(value.availableVersion) &&
    typeof value.state === 'string' &&
    STATES.some((state) => state === value.state)
  );
}

function parseStatus(value: unknown): SentinelStatus {
  if (
    !exactObject(value, ['schema', 'protocolVersion', 'components']) ||
    value.schema !== 'orbis-sentinel.status.v1' ||
    value.protocolVersion !== 1 ||
    !exactObject(value.components, ['orbis', 'sentinel']) ||
    !component(value.components.orbis) ||
    !component(value.components.sentinel)
  )
    throw new Error('Invalid status');
  return { available: true, ...value.components.sentinel };
}

function safeSocket(info: Stats): boolean {
  return info.isSocket() && info.uid === 0 && (info.mode & 0o7777) === 0o600;
}

function sameSocket(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.ctimeMs === b.ctimeMs;
}

@Injectable()
export class SentinelService {
  private cached?: { path: string | undefined; until: number; value: SentinelStatus };
  private pending?: { path: string | undefined; promise: Promise<SentinelStatus> };

  protected socketInfo(socketPath: string): Promise<Stats> {
    return lstat(socketPath);
  }

  read(): Promise<SentinelStatus> {
    const socketPath = process.env.ORBIS_SENTINEL_SOCKET;
    if (this.cached && this.cached.path === socketPath && this.cached.until > Date.now()) return Promise.resolve({ ...this.cached.value });
    if (this.pending && this.pending.path === socketPath) return this.pending.promise.then((value) => ({ ...value }));
    const promise = this.readOnce(socketPath).then((value) => {
      if (this.pending?.promise === promise) {
        this.cached = { path: socketPath, until: Date.now() + 1000, value };
        this.pending = undefined;
      }
      return value;
    });
    this.pending = { path: socketPath, promise };
    return promise.then((value) => ({ ...value }));
  }

  private async readOnce(socketPath: string | undefined): Promise<SentinelStatus> {
    if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 107) return unavailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SentinelStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(unavailable());
      }, 2000);
    });
    const work = (async () => {
      try {
        const before = await this.socketInfo(socketPath);
        if (controller.signal.aborted || !safeSocket(before)) return unavailable();
        const body = await this.request(socketPath, controller.signal);
        if (controller.signal.aborted) return unavailable();
        const after = await this.socketInfo(socketPath);
        if (controller.signal.aborted || !safeSocket(after) || !sameSocket(before, after)) return unavailable();
        return parseStatus(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
      } catch {
        return unavailable();
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private request(socketPath: string, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: ENDPOINT, method: 'GET', agent: false, signal }, (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error('Unavailable'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            req.destroy();
            reject(new Error('Response too large'));
          } else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Incomplete response')));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          res.destroy();
          req.destroy();
          resolve(body);
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}
