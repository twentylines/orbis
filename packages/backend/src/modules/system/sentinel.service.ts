import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  parseSentinelUpdateProgress,
  sentinelUpdateProgressMaxBytes,
  type SentinelUpdateProgress,
} from '@runtipi/common/schemas/sentinel-update-progress';

const ENDPOINT = '/sentinel/api/v1/status';
const HOST_ENDPOINT = '/v1/sentinel/status';
const RECOVERY_ACCESS_ENDPOINT = '/v1/sentinel/recovery-access';
const UPDATE_PROGRESS_ENDPOINT = '/v1/sentinel/update-progress';
type ReadEndpoint = typeof ENDPOINT | typeof HOST_ENDPOINT | typeof RECOVERY_ACCESS_ENDPOINT | typeof UPDATE_PROGRESS_ENDPOINT;
const CONTROLLER_HANDOFF = '/v1/sentinel/controller-handoff';
const HANDOFF_PLAN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const HANDOFF_PHASES = ['planned', 'accepted', 'stopping', 'held', 'return-accepted', 'returning', 'complete', 'cancelled'] as const;
type HandoffPhase = (typeof HANDOFF_PHASES)[number];
type HandoffEndpoint = `${typeof CONTROLLER_HANDOFF}/${'plan' | 'apply' | `${string}/status`}`;
type HandoffStatus = {
  planId: string;
  state: HandoffPhase | 'attention';
  phase: HandoffPhase;
  portalUrl: string;
  expiresAtMs: number;
};
const KEY_ROUTES = {
  save: '/v1/sentinel/enrollment/save-key',
  confirm: '/v1/sentinel/enrollment/confirm-key',
} as const;
type KeyRoute = (typeof KEY_ROUTES)[keyof typeof KEY_ROUTES];
const KEY_BINDING = ['operationId', 'reviewSha256', 'planSha256', 'keyRevision', 'deliveryEpoch'];
const HANDOFF = /^[A-Za-z0-9_-]{43}(?![\s\S])/;
const RECOVERY_KEY = /^orbis-recovery-[A-Za-z0-9_-]{43}(?![\s\S])/;
const MAX_BYTES = 64 * 1024;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/;
const STATES = ['unknown', 'healthy', 'unavailable', 'updating', 'recovering'] as const;
type ComponentState = (typeof STATES)[number];
export type SentinelStatus = { available: boolean; installedVersion: string | null; availableVersion: string | null; state: ComponentState };
const ENROLLMENT_STAGES = [
  'not-started',
  'staging',
  'operator-staged',
  'key-prepared',
  'key-expired',
  'key-acknowledged',
  'activation-pending',
  'activated',
] as const;
export type SentinelRecoveryAccess =
  | { state: 'missing' | 'unavailable'; portalUrl: null; unitState: null }
  | { state: 'configured'; portalUrl: string; unitState: 'active' | 'inactive' | 'unknown'; enrollment?: (typeof ENROLLMENT_STAGES)[number] };
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

function parseRecoveryAccess(value: unknown): SentinelRecoveryAccess {
  const unavailable: SentinelRecoveryAccess = { state: 'unavailable', portalUrl: null, unitState: null };
  const keys = ['version', 'state', 'portalUrl', 'unitState'];
  const extended = typeof value === 'object' && value !== null && Object.hasOwn(value, 'enrollment');
  if (!exactObject(value, extended ? [...keys, 'enrollment'] : keys) || value.version !== 1) return unavailable;
  if (!extended && value.state === 'missing' && value.portalUrl === null && value.unitState === null) return { ...unavailable, state: 'missing' };
  const { portalUrl, unitState } = value;
  if (
    value.state !== 'configured' ||
    (unitState !== 'active' && unitState !== 'inactive' && unitState !== 'unknown') ||
    typeof portalUrl !== 'string' ||
    portalUrl.length > 531 ||
    !/^https:\/\/(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?\/sentinel\/recovery\/(?![\s\S])/i.test(portalUrl)
  )
    return unavailable;
  const url = URL.parse(portalUrl);
  if (!url || url.port === '0' || url.pathname !== '/sentinel/recovery/') return unavailable;
  const result = { state: 'configured', portalUrl, unitState } as const;
  if (!extended) return result;
  const enrollment = ENROLLMENT_STAGES.find((stage) => stage === value.enrollment);
  return enrollment && unitState === 'active' ? { ...result, enrollment } : unavailable;
}

function handoffId(value: unknown): string {
  if (typeof value !== 'string' || !HANDOFF_PLAN_ID.test(value)) throw new BadRequestException('Choose one reviewed controller recovery handoff.');
  return value;
}

function handoffStatus(value: unknown, planId?: string): HandoffStatus {
  if (exactObject(value, ['version', 'planId', 'state', 'phase', 'portalUrl', 'expiresAtMs'])) {
    const { portalUrl, expiresAtMs } = value;
    const phase = HANDOFF_PHASES.find((item) => item === value.phase);
    const state = value.state === 'attention' ? 'attention' : HANDOFF_PHASES.find((item) => item === value.state);
    if (
      value.version === 1 &&
      phase &&
      state &&
      (state === phase || state === 'attention') &&
      typeof value.planId === 'string' &&
      HANDOFF_PLAN_ID.test(value.planId) &&
      (planId === undefined ? phase === 'planned' && state === phase : value.planId === planId) &&
      typeof expiresAtMs === 'number' &&
      Number.isSafeInteger(expiresAtMs) &&
      expiresAtMs > 0 &&
      typeof portalUrl === 'string' &&
      parseRecoveryAccess({ version: 1, state: 'configured', portalUrl, unitState: 'active' }).state === 'configured'
    )
      return { planId: value.planId, state, phase, portalUrl, expiresAtMs };
  }
  throw new ConflictException('Unable to verify the controller recovery handoff. Check Sentinel enrollment and Host status.');
}

function safeSocket(info: Stats): boolean {
  return info.isSocket() && info.uid === 0 && (info.mode & 0o7777) === 0o600;
}

function sameSocket(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.ctimeMs === b.ctimeMs;
}

@Injectable()
export class SentinelService {
  private cached?: { key: string; until: number; value: SentinelStatus };
  private pending?: { key: string; promise: Promise<SentinelStatus> };
  private recoveryPending?: { socketPath: string | undefined; promise: Promise<SentinelRecoveryAccess> };

  protected socketInfo(socketPath: string): Promise<Stats> {
    return lstat(socketPath);
  }

  read(): Promise<SentinelStatus> {
    const direct = process.env.ORBIS_SENTINEL_SOCKET;
    const socketPath = direct ?? process.env.ORBIS_HOST_SOCKET;
    const endpoint = direct === undefined ? HOST_ENDPOINT : ENDPOINT;
    const key = JSON.stringify([socketPath, endpoint]);
    if (this.cached && this.cached.key === key && this.cached.until > Date.now()) return Promise.resolve({ ...this.cached.value });
    if (this.pending && this.pending.key === key) return this.pending.promise.then((value) => ({ ...value }));
    const promise = this.readOnce(socketPath, endpoint).then((value) => {
      if (this.pending?.promise === promise) {
        this.cached = { key, until: Date.now() + 1000, value };
        this.pending = undefined;
      }
      return value;
    });
    this.pending = { key, promise };
    return promise.then((value) => ({ ...value }));
  }

  async readUpdateProgress(): Promise<SentinelUpdateProgress> {
    const value = await this.readProtected(process.env.ORBIS_HOST_SOCKET, UPDATE_PROGRESS_ENDPOINT, sentinelUpdateProgressMaxBytes);
    return parseSentinelUpdateProgress(value) ?? { version: 1, available: false, jobs: [] };
  }

  readRecoveryAccess(): Promise<SentinelRecoveryAccess> {
    const socketPath = process.env.ORBIS_HOST_SOCKET;
    if (this.recoveryPending && this.recoveryPending.socketPath === socketPath) return this.recoveryPending.promise;
    const promise = this.readProtected(socketPath, RECOVERY_ACCESS_ENDPOINT, 1024)
      .then(parseRecoveryAccess)
      .finally(() => {
        if (this.recoveryPending?.promise === promise) this.recoveryPending = undefined;
      });
    this.recoveryPending = { socketPath, promise };
    return promise;
  }

  async recoveryKeyHandoff(action: keyof typeof KEY_ROUTES, value: unknown) {
    const saving = action === 'save';
    const fields = [...KEY_BINDING, 'handoff', ...(saving ? [] : ['recoveryKey'])];
    if (
      !exactObject(value, fields) ||
      !KEY_BINDING.every((field) => typeof value[field] === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value[field])) ||
      typeof value.handoff !== 'string' ||
      !HANDOFF.test(value.handoff) ||
      (!saving && (typeof value.recoveryKey !== 'string' || !RECOVERY_KEY.test(value.recoveryKey)))
    )
      throw new BadRequestException('Invalid recovery handoff.');
    const result = await this.readProtected(process.env.ORBIS_HOST_SOCKET, KEY_ROUTES[action], 1024, JSON.stringify(value));
    if (saving && exactObject(result, ['recoveryKey']) && typeof result.recoveryKey === 'string' && RECOVERY_KEY.test(result.recoveryKey)) {
      return { recoveryKey: result.recoveryKey };
    }
    if (!saving && exactObject(result, ['state']) && result.state === 'acknowledged') return { state: 'acknowledged' as const };
    throw new ConflictException('The host could not verify this recovery handoff.');
  }

  async reviewControllerHandoff(body: unknown) {
    if (!exactObject(body, [])) throw new BadRequestException('Controller recovery review does not accept options.');
    return handoffStatus(await this.readProtected(process.env.ORBIS_HOST_SOCKET, `${CONTROLLER_HANDOFF}/plan`, 1536, '{}'));
  }

  async applyControllerHandoff(body: unknown) {
    if (!exactObject(body, ['planId'])) throw new BadRequestException('Confirm one reviewed controller recovery handoff.');
    const planId = handoffId(body.planId);
    return handoffStatus(
      await this.readProtected(process.env.ORBIS_HOST_SOCKET, `${CONTROLLER_HANDOFF}/apply`, 1536, JSON.stringify({ planId })),
      planId,
    );
  }

  async controllerHandoffStatus(value: unknown) {
    const planId = handoffId(value);
    return handoffStatus(await this.readProtected(process.env.ORBIS_HOST_SOCKET, `${CONTROLLER_HANDOFF}/${planId}/status`, 1536), planId);
  }

  private async readOnce(socketPath: string | undefined, endpoint: typeof ENDPOINT | typeof HOST_ENDPOINT): Promise<SentinelStatus> {
    try {
      const value = await this.readProtected(socketPath, endpoint, MAX_BYTES);
      if (endpoint === ENDPOINT) return parseStatus(value);
      if (!exactObject(value, ['version', 'available', 'status']) || value.version !== 1) return unavailable();
      return value.available === true ? parseStatus(value.status) : unavailable();
    } catch {
      return unavailable();
    }
  }

  private async readProtected(
    socketPath: string | undefined,
    endpoint: ReadEndpoint | KeyRoute | HandoffEndpoint,
    maxBytes: number,
    requestBody?: string,
  ): Promise<unknown> {
    if (!socketPath || !path.isAbsolute(socketPath) || socketPath.includes('\0') || Buffer.byteLength(socketPath) > 107) return null;
    const handoff = endpoint.startsWith(`${CONTROLLER_HANDOFF}/`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort();
          resolve(null);
        },
        requestBody === undefined ? (handoff ? 30000 : 2000) : handoff ? 90000 : 6000,
      );
    });
    const work = (async () => {
      try {
        const before = await this.socketInfo(socketPath);
        if (controller.signal.aborted || !safeSocket(before)) return null;
        const body = await this.request(socketPath, endpoint, controller.signal, maxBytes, requestBody);
        if (controller.signal.aborted) return null;
        const after = await this.socketInfo(socketPath);
        if (controller.signal.aborted || !safeSocket(after) || !sameSocket(before, after)) return null;
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private request(
    socketPath: string,
    endpoint: ReadEndpoint | KeyRoute | HandoffEndpoint,
    signal: AbortSignal,
    maxBytes: number,
    requestBody?: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      if (endpoint.startsWith(`${CONTROLLER_HANDOFF}/`)) headers.Host = 'orbis';
      if (requestBody !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(requestBody);
      }
      const req = http.request(
        {
          socketPath,
          path: endpoint,
          method: requestBody === undefined ? 'GET' : 'POST',
          agent: false,
          signal,
          headers,
        },
        (res) => {
          if (res.statusCode !== 200 && !(res.statusCode === 202 && endpoint === `${CONTROLLER_HANDOFF}/apply`)) {
            res.destroy();
            reject(new Error('Unavailable'));
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
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
        },
      );
      req.on('error', reject);
      req.end(requestBody);
    });
  }
}
