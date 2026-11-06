import http, { type IncomingMessage } from 'node:http';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';

export const coreCaptureStartCapability = Object.freeze({
  schema: 'orbis.core-capture-start-capability.v1',
  version: 1,
  preparationVersion: 2,
  pointVersion: 3,
  sourceHoldVersion: 2,
  scope: 'controller-live-proxy.v1',
  operations: Object.freeze(['prepare', 'admit']),
  admissionReplay: 'forbidden',
  publication: 'controller-restart.v1',
});
export const coreCaptureSentinelStartCapability = Object.freeze({
  ...coreCaptureStartCapability,
  schema: 'orbis.core-capture-sentinel-start-capability.v1',
  operations: Object.freeze(['prepare-sentinel', 'admit']),
  publication: 'sentinel.v1',
  automaticPublication: 'supervisor-terminal.v1',
});
export type CoreCaptureStartPreparation = Readonly<{
  version: 2;
  id: string;
  preparationSha256: string;
  sourceSha256: string;
  pointReservationSha256: string;
  controller: Readonly<{ id: string; imageId: string; startedAt: string; definitionSha256: string }>;
}>;
declare const preparedStart: unique symbol;
export type PreparedCoreCaptureStart = { readonly [preparedStart]: true };
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === fields.sort().join(',');
const fail = () => new Error('The snapshot could not be prepared by the host service.');

function responseLength(reply: IncomingMessage, allowNotFound = false, allowConflict = false) {
  const counts = new Map<string, number>();
  for (let index = 0; index < reply.rawHeaders.length; index += 2) {
    const name = reply.rawHeaders[index]?.toLowerCase() ?? '';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const length = reply.headers['content-length'];
  if (
    (reply.statusCode !== 200 && !(allowNotFound && reply.statusCode === 404) && !(allowConflict && reply.statusCode === 409)) ||
    reply.headers['content-type'] !== 'application/json' ||
    reply.headers['cache-control'] !== 'no-store' ||
    ['content-length', 'content-type', 'cache-control'].some((name) => counts.get(name) !== 1) ||
    ['transfer-encoding', 'content-encoding', 'trailer'].some((name) => counts.has(name)) ||
    typeof length !== 'string' ||
    !/^[1-9][0-9]*$/.test(length) ||
    !Number.isSafeInteger(Number(length)) ||
    Number(length) > 8192
  )
    throw fail();
  return Number(length);
}

function preparation(raw: unknown, point: string, reservation: string): CoreCaptureStartPreparation {
  if (
    !exact(raw, ['version', 'id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller']) ||
    raw.version !== 2 ||
    raw.id !== point ||
    raw.pointReservationSha256 !== reservation ||
    !hash(raw.preparationSha256) ||
    !hash(raw.sourceSha256) ||
    !exact(raw.controller, ['id', 'imageId', 'startedAt', 'definitionSha256']) ||
    !hash(raw.controller.id) ||
    !hash(raw.controller.definitionSha256) ||
    typeof raw.controller.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(raw.controller.imageId) ||
    typeof raw.controller.startedAt !== 'string' ||
    !/^[\x20-\x7e]{1,128}$/.test(raw.controller.startedAt)
  )
    throw fail();
  return Object.freeze({
    version: 2,
    id: point,
    preparationSha256: raw.preparationSha256,
    sourceSha256: raw.sourceSha256,
    pointReservationSha256: reservation,
    controller: Object.freeze({ ...raw.controller }) as CoreCaptureStartPreparation['controller'],
  });
}

export async function coreCaptureHostRequest(
  socket: string,
  route: string,
  body: object | undefined,
  cancellation: AbortSignal,
  expectedIdentity?: string,
  allowNotFound = false,
  requestTimeoutMs?: number,
  allowConflict = false,
) {
  cancellation.throwIfAborted();
  const identity = await controllerCaptureSocketIdentity(socket);
  if (expectedIdentity !== undefined && identity !== expectedIdentity) throw fail();
  const deadline = AbortSignal.timeout(requestTimeoutMs ?? (body === undefined ? 10_000 : 120_000));
  const signal = AbortSignal.any([cancellation, deadline]);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let reply: IncomingMessage | undefined;
  try {
    reply = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: socket,
          method: payload === undefined ? 'GET' : 'POST',
          path: route,
          signal,
          agent: false,
          headers: {
            Connection: 'close',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          },
        },
        resolve,
      );
      request.on('error', reject);
      request.end(payload);
    });
    const expected = responseLength(
      reply,
      allowNotFound && body === undefined,
      allowConflict &&
        body !== undefined &&
        /^\/v1\/core-captures\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/preparation$/.test(route),
    );
    const parts: Buffer[] = [];
    let length = 0;
    for await (const raw of reply) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      length += chunk.length;
      if (length > expected) throw fail();
      parts.push(chunk);
    }
    if (!reply.complete || length !== expected || Object.keys(reply.trailers).length) throw fail();
    try {
      if ((await controllerCaptureSocketIdentity(socket)) !== identity) throw fail();
    } catch {
      throw fail();
    }
    signal.throwIfAborted();
    return {
      identity,
      statusCode: reply.statusCode as number,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown,
    };
  } catch (error) {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const cause = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'cause') : undefined;
    if (
      deadline.aborted &&
      !cancellation.aborted &&
      (error === deadline.reason ||
        (code && 'value' in code && code.value === 'ABORT_ERR' && cause && 'value' in cause && cause.value === deadline.reason))
    ) {
      throw Object.assign(new Error('The host service response timed out.', { cause: error }), { code: 'ETIMEDOUT' });
    }
    throw error;
  } finally {
    reply?.destroy();
  }
}

/** An admission token belongs to this client and is consumed before submission, including failure. */
export class HostCoreCaptureStartClient {
  private readonly prepared = new WeakMap<PreparedCoreCaptureStart, { identity: string; value: CoreCaptureStartPreparation }>();
  private negotiation?: { identity: string; publisher: 'sentinel.v1' | 'controller-restart.v1' };

  constructor(private readonly socket: string) {}

  private request(route: string, body: object | undefined, signal: AbortSignal) {
    return coreCaptureHostRequest(this.socket, route, body, signal);
  }

  async requireCapability(signal: AbortSignal) {
    this.negotiation = undefined;
    const reply = await this.request('/v1/core-captures/capabilities', undefined, signal);
    if (canonicalPublicationJson(reply.value) !== canonicalPublicationJson(coreCaptureStartCapability)) throw fail();
    const optional = await coreCaptureHostRequest(
      this.socket,
      '/v1/core-captures/sentinel-start-capability',
      undefined,
      signal,
      reply.identity,
      true,
    );
    let publisher: 'sentinel.v1' | 'controller-restart.v1' = 'controller-restart.v1';
    if (optional.statusCode === 404) {
      if (
        !exact(optional.value, ['error']) ||
        typeof optional.value.error !== 'string' ||
        !optional.value.error.length ||
        optional.value.error.length > 4096
      )
        throw fail();
    } else {
      const value = optional.value;
      if (
        !value ||
        typeof value !== 'object' ||
        !('available' in value) ||
        typeof value.available !== 'boolean' ||
        canonicalPublicationJson(value) !== canonicalPublicationJson({ ...coreCaptureSentinelStartCapability, available: value.available })
      )
        throw fail();
      if (value.available) publisher = 'sentinel.v1';
    }
    this.negotiation = { identity: optional.identity, publisher };
  }

  async prepare(point: string, reservationSha256: string, signal: AbortSignal) {
    if (!id(point) || !hash(reservationSha256)) throw fail();
    const publisher = this.negotiation?.publisher ?? 'controller-restart.v1';
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${point}/${publisher === 'sentinel.v1' ? 'prepare-sentinel' : 'prepare'}`,
      {},
      signal,
      this.negotiation?.identity,
      false,
      publisher === 'sentinel.v1' ? 30 * 60_000 : undefined,
    );
    const value = preparation(reply.value, point, reservationSha256);
    const token = Object.freeze({}) as PreparedCoreCaptureStart;
    this.prepared.set(token, { identity: reply.identity, value });
    return Object.freeze({ preparation: value, token, publisher });
  }

  async admit(token: PreparedCoreCaptureStart, sourceHoldSha256: string, signal: AbortSignal) {
    const approved = this.prepared.get(token);
    if (!approved) throw fail();
    this.prepared.delete(token);
    if (!hash(sourceHoldSha256) || (await controllerCaptureSocketIdentity(this.socket)) !== approved.identity) throw fail();
    const reply = await this.request(
      `/v1/core-captures/${approved.value.id}/admit`,
      { preparationSha256: approved.value.preparationSha256, sourceHoldSha256 },
      signal,
    );
    const raw = reply.value;
    if (
      reply.identity !== approved.identity ||
      !exact(raw, ['version', 'id', 'state', 'sourceHoldSha256']) ||
      raw.version !== 1 ||
      raw.id !== approved.value.id ||
      raw.sourceHoldSha256 !== sourceHoldSha256 ||
      (raw.state !== 'launch-requested' && raw.state !== 'launch-unsettled')
    )
      throw fail();
    return Object.freeze({ version: 1, id: approved.value.id, state: raw.state, sourceHoldSha256 });
  }
}
