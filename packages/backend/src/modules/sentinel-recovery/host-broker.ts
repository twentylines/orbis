import { createHash } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import { controllerCaptureSocketIdentity } from '../host-updates/host-controller-config';
import type { CredentialRecoveryBroker } from './change-coordinator';
import { readProtectedRecoveryJson, recoveryBase64 } from './identity';

const MAX_REQUEST = 196608;
const MAX_RESPONSE = 4096;
const DEADLINE_MS = 180000;
const fail = () => new Error('Credential synchronization could not be verified. Check recovery before trying again.');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export type OwnershipPurpose = 'first-registration' | 'account-removal' | 'credential-change';
export type CredentialChangeAdmission = Readonly<
  | { protocol: 'root-ownership'; mode: 'unmanaged'; binding: string }
  | { protocol: 'prepared-identity'; mode: 'managed' | 'unmanaged'; binding: string }
>;
export type OwnershipGrant = Readonly<{
  operationId: string;
  requestId: string;
  purpose: OwnershipPurpose;
  admissionBinding: string;
  state: 'pending' | 'completed';
}>;
const ownershipPurpose = (value: unknown): value is OwnershipPurpose =>
  value === 'first-registration' || value === 'account-removal' || value === 'credential-change';
type Endpoint =
  | 'admission'
  | 'change-admission'
  | 'prepare'
  | 'complete'
  | 'counter-challenge'
  | 'counter-complete'
  | 'counter-floors'
  | 'ownership-prepare'
  | 'ownership-check'
  | 'ownership-complete';
export type MainCounterCeremony = Readonly<{
  mode: 'managed' | 'unmanaged';
  admissionBinding: string;
  purpose: 'login' | 'sensitive';
  ceremonyBinding: string;
  challenge?: string;
  expiresAtMs?: number;
  generation?: number;
  revision?: string;
  accountId?: number;
  rpID?: string;
  credentialIds?: readonly string[];
}>;
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));

function receipt(bytes: Buffer): Record<string, unknown> {
  const value = readProtectedRecoveryJson(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}

function ownershipGrant(value: unknown): OwnershipGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const row = value as Record<string, unknown>;
  if (
    !exact(row, ['operationId', 'requestId', 'purpose', 'admissionBinding', 'state']) ||
    !hash(row.operationId) ||
    !hash(row.requestId) ||
    !hash(row.admissionBinding) ||
    !ownershipPurpose(row.purpose) ||
    (row.state !== 'pending' && row.state !== 'completed')
  )
    throw fail();
  return Object.freeze({
    operationId: row.operationId,
    requestId: row.requestId,
    purpose: row.purpose,
    admissionBinding: row.admissionBinding,
    state: row.state,
  });
}

function length(reply: IncomingMessage, maximum: number): number {
  const counts = new Map<string, number>();
  for (let index = 0; index < reply.rawHeaders.length; index += 2) {
    const name = reply.rawHeaders[index]?.toLowerCase() ?? '';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const bytes = reply.headers['content-length'];
  if (
    reply.statusCode !== 200 ||
    reply.headers['content-type'] !== 'application/json' ||
    counts.get('content-type') !== 1 ||
    counts.get('content-length') !== 1 ||
    [...counts.values()].some((count) => count !== 1) ||
    ['transfer-encoding', 'content-encoding', 'trailer'].some((name) => counts.has(name)) ||
    typeof bytes !== 'string' ||
    !/^[1-9][0-9]*$/.test(bytes) ||
    !Number.isSafeInteger(Number(bytes)) ||
    Number(bytes) > maximum
  )
    throw fail();
  return Number(bytes);
}

function source(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 65536) throw fail();
  return Buffer.from(value);
}

/** Fixed host port for the prepared credential coordinator. The socket is an
 * explicit server configuration value; missing/old/unavailable service never
 * becomes unmanaged and ambiguous calls are never retried here.
 */
export class HostCredentialRecoveryBroker implements CredentialRecoveryBroker {
  private readonly socket: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string | undefined, options: { timeoutMs?: number } = {}) {
    const timeout = options.timeoutMs ?? DEADLINE_MS;
    if (
      typeof socketPath !== 'string' ||
      !path.isAbsolute(socketPath) ||
      path.resolve(socketPath) !== socketPath ||
      socketPath.includes('\0') ||
      Buffer.byteLength(socketPath) > 107 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > DEADLINE_MS
    )
      throw fail();
    this.socket = socketPath;
    this.timeoutMs = timeout;
  }

  private async request(endpoint: Endpoint, body: Record<string, unknown> | undefined, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let payload: Buffer | undefined;
    try {
      if (signal?.aborted) throw fail();
      payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      if (payload && payload.length > MAX_REQUEST) throw fail();
      signal?.addEventListener('abort', abort, { once: true });
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(fail());
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      timer = setTimeout(abort, this.timeoutMs);
      timer.unref();
      return await Promise.race([this.exchange(endpoint, payload, controller.signal), cancelled]);
    } catch {
      throw fail();
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      controller.abort();
      payload?.fill(0);
    }
  }

  private async exchange(endpoint: Endpoint, payload: Buffer | undefined, signal: AbortSignal) {
    let request: http.ClientRequest | undefined;
    let reply: IncomingMessage | undefined;
    let transportError = false;
    try {
      signal.throwIfAborted();
      const identity = await controllerCaptureSocketIdentity(this.socket);
      signal.throwIfAborted();
      reply = await new Promise<IncomingMessage>((resolve, reject) => {
        request = http.request(
          {
            socketPath: this.socket,
            path: `/v1/credentials/${endpoint}`,
            method: payload === undefined ? 'GET' : 'POST',
            agent: false,
            signal,
            maxHeaderSize: 8192,
            headers: {
              Host: 'orbis',
              Connection: 'close',
              ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
          },
          resolve,
        );
        request.on('error', () => {
          transportError = true;
          reject(fail());
        });
        request.end(payload);
      });
      const socket = reply.socket;
      const closed = new Promise<void>((resolve) => {
        if (socket.closed) resolve();
        else socket.once('close', () => resolve());
      });
      const expected = length(reply, endpoint.startsWith('counter-') ? 32768 : MAX_RESPONSE);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of reply) {
        signal.throwIfAborted();
        const part = Buffer.from(chunk);
        received += part.length;
        if (received > expected) throw fail();
        chunks.push(part);
      }
      await closed;
      if (transportError) throw fail();
      if (!reply.complete || received !== expected || reply.rawTrailers.length || Object.keys(reply.trailers).length) throw fail();
      if ((await controllerCaptureSocketIdentity(this.socket)) !== identity) throw fail();
      signal.throwIfAborted();
      return receipt(Buffer.concat(chunks));
    } finally {
      reply?.destroy();
      request?.destroy();
    }
  }

  async admission({ signal }: Parameters<CredentialRecoveryBroker['admission']>[0]) {
    const value = await this.request('admission', undefined, signal);
    if (!exact(value, ['mode', 'binding']) || (value.mode !== 'managed' && value.mode !== 'unmanaged') || !hash(value.binding)) throw fail();
    return Object.freeze({ mode: value.mode, binding: value.binding });
  }

  async changeAdmission({ signal }: { signal?: AbortSignal }): Promise<CredentialChangeAdmission> {
    const value = await this.request('change-admission', undefined, signal);
    if (!exact(value, ['protocol', 'mode', 'binding']) || !hash(value.binding)) throw fail();
    if (value.protocol === 'root-ownership' && value.mode === 'unmanaged')
      return Object.freeze({ protocol: value.protocol, mode: value.mode, binding: value.binding });
    if (value.protocol === 'prepared-identity' && (value.mode === 'managed' || value.mode === 'unmanaged'))
      return Object.freeze({ protocol: value.protocol, mode: value.mode, binding: value.binding });
    throw fail();
  }

  async ownershipPrepare(options: { requestId: string; purpose: OwnershipPurpose; signal?: AbortSignal }): Promise<OwnershipGrant> {
    if (!hash(options.requestId) || !ownershipPurpose(options.purpose)) throw fail();
    const result = ownershipGrant(
      await this.request('ownership-prepare', { requestId: options.requestId, purpose: options.purpose }, options.signal),
    );
    if (result.requestId !== options.requestId || result.purpose !== options.purpose) throw fail();
    return result;
  }

  async ownershipCheck(grant: OwnershipGrant, signal?: AbortSignal): Promise<OwnershipGrant> {
    const expected = ownershipGrant(grant);
    if (expected.state !== 'pending') throw fail();
    const result = ownershipGrant(
      await this.request(
        'ownership-check',
        {
          operationId: expected.operationId,
          admissionBinding: expected.admissionBinding,
          purpose: expected.purpose,
        },
        signal,
      ),
    );
    if (
      result.state !== 'pending' ||
      result.operationId !== expected.operationId ||
      result.requestId !== expected.requestId ||
      result.admissionBinding !== expected.admissionBinding ||
      result.purpose !== expected.purpose
    )
      throw fail();
    return result;
  }

  async ownershipComplete(grant: OwnershipGrant, disposition: 'committed' | 'not-written', signal?: AbortSignal): Promise<OwnershipGrant> {
    const expected = ownershipGrant(grant);
    if (disposition !== 'committed' && disposition !== 'not-written') throw fail();
    const result = ownershipGrant(
      await this.request(
        'ownership-complete',
        {
          operationId: expected.operationId,
          admissionBinding: expected.admissionBinding,
          purpose: expected.purpose,
          disposition,
        },
        signal,
      ),
    );
    if (
      result.state !== 'completed' ||
      result.operationId !== expected.operationId ||
      result.requestId !== expected.requestId ||
      result.admissionBinding !== expected.admissionBinding ||
      result.purpose !== expected.purpose
    )
      throw fail();
    return result;
  }

  async counterChallenge(options: {
    admissionBinding: string;
    purpose: 'login' | 'sensitive';
    ceremonyBinding: string;
    signal?: AbortSignal;
  }): Promise<MainCounterCeremony> {
    if (!hash(options.admissionBinding) || !hash(options.ceremonyBinding) || !['login', 'sensitive'].includes(options.purpose)) throw fail();
    const value = await this.request(
      'counter-challenge',
      { admissionBinding: options.admissionBinding, purpose: options.purpose, ceremonyBinding: options.ceremonyBinding },
      options.signal,
    );
    if (value.mode === 'unmanaged' && exact(value, ['mode', 'admissionBinding']) && value.admissionBinding === options.admissionBinding)
      return Object.freeze({
        mode: 'unmanaged',
        admissionBinding: options.admissionBinding,
        purpose: options.purpose,
        ceremonyBinding: options.ceremonyBinding,
      });
    if (
      !exact(value, [
        'schema',
        'mode',
        'admissionBinding',
        'challenge',
        'expiresAtMs',
        'generation',
        'revision',
        'accountId',
        'rpID',
        'credentialIds',
      ]) ||
      value.schema !== 'orbis.sentinel-main-passkey-challenge.v1' ||
      value.mode !== 'managed' ||
      value.admissionBinding !== options.admissionBinding ||
      !recoveryBase64(value.challenge, 43) ||
      Buffer.from(value.challenge, 'base64url').length !== 32 ||
      !integer(value.expiresAtMs) ||
      value.expiresAtMs <= Date.now() ||
      value.expiresAtMs > Date.now() + 120000 ||
      !integer(value.generation) ||
      !hash(value.revision) ||
      !integer(value.accountId) ||
      value.accountId < 1 ||
      typeof value.rpID !== 'string' ||
      value.rpID.length < 1 ||
      value.rpID.length > 253 ||
      !Array.isArray(value.credentialIds) ||
      value.credentialIds.length < 1 ||
      value.credentialIds.length > 10 ||
      !value.credentialIds.every((id: unknown) => recoveryBase64(id)) ||
      new Set(value.credentialIds).size !== value.credentialIds.length
    )
      throw fail();
    return Object.freeze({
      mode: 'managed',
      admissionBinding: options.admissionBinding,
      purpose: options.purpose,
      ceremonyBinding: options.ceremonyBinding,
      challenge: value.challenge,
      expiresAtMs: value.expiresAtMs,
      generation: value.generation,
      revision: value.revision,
      accountId: value.accountId,
      rpID: value.rpID,
      credentialIds: Object.freeze([...value.credentialIds] as string[]),
    });
  }

  async counterComplete(options: { ceremony: MainCounterCeremony; response: unknown; signal?: AbortSignal }) {
    const c = options.ceremony;
    if (c.mode !== 'managed' || !hash(c.admissionBinding) || !hash(c.ceremonyBinding) || !recoveryBase64(c.challenge, 43)) throw fail();
    const value = await this.request(
      'counter-complete',
      {
        admissionBinding: c.admissionBinding,
        purpose: c.purpose,
        ceremonyBinding: c.ceremonyBinding,
        challenge: c.challenge,
        response: options.response,
      },
      options.signal,
    );
    if (
      !exact(value, [
        'schema',
        'admissionBinding',
        'challenge',
        'generation',
        'revision',
        'accountId',
        'credentialId',
        'previousCounter',
        'newCounter',
        'expiresAtMs',
      ]) ||
      value.schema !== 'orbis.sentinel-main-passkey-counter.v1' ||
      value.admissionBinding !== c.admissionBinding ||
      value.challenge !== c.challenge ||
      value.generation !== c.generation ||
      value.revision !== c.revision ||
      value.accountId !== c.accountId ||
      !recoveryBase64(value.credentialId) ||
      !integer(value.previousCounter) ||
      value.previousCounter > 0xffffffff ||
      !integer(value.newCounter) ||
      value.newCounter > 0xffffffff ||
      !integer(value.expiresAtMs) ||
      value.expiresAtMs !== c.expiresAtMs ||
      value.expiresAtMs <= Date.now() ||
      !c.credentialIds?.includes(value.credentialId) ||
      ((value.previousCounter !== 0 || value.newCounter !== 0) && value.newCounter <= value.previousCounter)
    )
      throw fail();
    return Object.freeze({
      accountId: value.accountId as number,
      credentialId: value.credentialId,
      previousCounter: value.previousCounter,
      newCounter: value.newCounter,
    });
  }

  async counterFloors(options: { admissionBinding: string; identity: Buffer; signal?: AbortSignal }) {
    let bytes: Buffer | undefined;
    try {
      if (!hash(options.admissionBinding)) throw fail();
      bytes = source(options.identity);
      const sourceSha256 = sha256(bytes);
      const value = await this.request(
        'counter-floors',
        { admissionBinding: options.admissionBinding, identityBase64: bytes.toString('base64') },
        options.signal,
      );
      if (
        !exact(value, ['schema', 'admissionBinding', 'sourceSha256', 'generation', 'revision', 'counters']) ||
        value.schema !== 'orbis.sentinel-main-counter-floors.v1' ||
        value.admissionBinding !== options.admissionBinding ||
        value.sourceSha256 !== sourceSha256 ||
        !integer(value.generation) ||
        !hash(value.revision) ||
        !value.counters ||
        typeof value.counters !== 'object' ||
        Array.isArray(value.counters) ||
        Object.keys(value.counters).length > 10
      )
        throw fail();
      const counters = Object.fromEntries(
        Object.entries(value.counters).map(([id, counter]) => {
          if (!recoveryBase64(id) || !integer(counter) || counter > 0xffffffff) throw fail();
          return [id, counter];
        }),
      );
      return Object.freeze({ sourceSha256, generation: value.generation, revision: value.revision, counters: Object.freeze(counters) });
    } catch {
      throw fail();
    } finally {
      bytes?.fill(0);
    }
  }

  async prepare(options: Parameters<CredentialRecoveryBroker['prepare']>[0]) {
    let baseline: Buffer | undefined;
    let planned: Buffer | undefined;
    try {
      if (!hash(options.requestId) || !hash(options.admissionBinding)) throw fail();
      baseline = source(options.baselineIdentity);
      planned = source(options.plannedIdentity);
      const baselineSha256 = sha256(baseline);
      const plannedSha256 = sha256(planned);
      const value = await this.request(
        'prepare',
        {
          requestId: options.requestId,
          admissionBinding: options.admissionBinding,
          baselineIdentityBase64: baseline.toString('base64'),
          plannedIdentityBase64: planned.toString('base64'),
        },
        options.signal,
      );
      if (
        !exact(value, ['operationId', 'state', 'admissionBinding', 'baselineSha256', 'plannedSha256']) ||
        !hash(value.operationId) ||
        value.state !== 'pending' ||
        value.admissionBinding !== options.admissionBinding ||
        value.baselineSha256 !== baselineSha256 ||
        value.plannedSha256 !== plannedSha256
      )
        throw fail();
      return Object.freeze({
        operationId: value.operationId,
        state: 'pending' as const,
        admissionBinding: value.admissionBinding,
        baselineSha256,
        plannedSha256,
      });
    } catch {
      throw fail();
    } finally {
      baseline?.fill(0);
      planned?.fill(0);
    }
  }

  async complete(options: Parameters<CredentialRecoveryBroker['complete']>[0]) {
    let current: Buffer | undefined;
    try {
      if (!hash(options.operationId) || !hash(options.admissionBinding)) throw fail();
      current = source(options.currentIdentity);
      const plannedSha256 = sha256(current);
      const value = await this.request(
        'complete',
        { operationId: options.operationId, admissionBinding: options.admissionBinding, currentIdentityBase64: current.toString('base64') },
        options.signal,
      );
      if (
        !exact(value, ['operationId', 'state', 'admissionBinding', 'plannedSha256']) ||
        value.operationId !== options.operationId ||
        value.state !== 'completed' ||
        value.admissionBinding !== options.admissionBinding ||
        value.plannedSha256 !== plannedSha256
      )
        throw fail();
      return Object.freeze({ operationId: value.operationId, state: 'completed' as const, admissionBinding: value.admissionBinding, plannedSha256 });
    } catch {
      throw fail();
    } finally {
      current?.fill(0);
    }
  }
}
