import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';
import { HostCoreCaptureAbortClient, validateCoreCaptureAbortPreparation, type CoreCaptureAbortPreparation } from './host-core-capture-abort-client';
import { HostCoreCaptureEmptyAbortClient } from './host-core-capture-empty-abort-client';
import { coreCapturePreparationRecoveryCapability } from './host-core-capture-preparation-recovery-client';
import { coreCaptureHostRequest, coreCaptureSentinelStartCapability } from './host-core-capture-start-client';
import {
  HostCoreCaptureRefusedAbortClient,
  HostCoreCaptureSetupAbortClient,
  HostCoreCaptureUnusedAbortClient,
} from './host-core-capture-unused-abort-client';

export const coreCaptureReservedStartCapability = Object.freeze({
  schema: 'orbis.core-capture-reserved-start-capability.v1',
  version: 1,
  preparationVersion: 3,
  pointVersion: 3,
  sourceHoldVersion: 2,
  scope: 'controller-live-proxy.v1',
  operations: Object.freeze(['prepare-reserved', 'prepare-reserved-sentinel', 'admit']),
  admissionReplay: 'forbidden',
  reservation: 'before-source-drain',
  abort: 'positive-source-evidence.v1',
  publication: 'controller-restart.v1',
  sentinelSelection: 'sentinel-start-capability.v1',
});
declare const reservedStart: unique symbol;
export type PreparedReservedCoreCaptureStart = { readonly [reservedStart]: true };
export type CoreCaptureAbortClients = {
  completeClient: HostCoreCaptureAbortClient;
  client: HostCoreCaptureEmptyAbortClient;
  unusedClient: HostCoreCaptureUnusedAbortClient;
  setupClient: HostCoreCaptureSetupAbortClient;
  refusedClient: HostCoreCaptureRefusedAbortClient;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail = () => new Error('Snapshot preparation needs recovery.');
const transportFailure = (error: unknown) => {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
  return !!code && 'value' in code && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ABORT_ERR'].includes(code.value);
};

/** Reservations and admission are submitted once, on the negotiated live channel. */
export class HostCoreCaptureReservedStartClient {
  readonly preparationVersion = 3 as const;
  readonly abortClients: CoreCaptureAbortClients;
  private negotiation?: { identity: string; publisher: 'sentinel.v1' | 'controller-restart.v1' };
  private readonly attempted = new Set<string>();
  private readonly prepared = new WeakMap<PreparedReservedCoreCaptureStart, { identity: string; value: CoreCaptureAbortPreparation }>();

  constructor(
    private readonly socket: string,
    abortClients?: CoreCaptureAbortClients,
  ) {
    this.abortClients = abortClients ?? {
      completeClient: new HostCoreCaptureAbortClient(socket),
      client: new HostCoreCaptureEmptyAbortClient(socket),
      unusedClient: new HostCoreCaptureUnusedAbortClient(socket),
      setupClient: new HostCoreCaptureSetupAbortClient(socket),
      refusedClient: new HostCoreCaptureRefusedAbortClient(socket),
    };
  }

  async requireCapability(signal: AbortSignal) {
    this.negotiation = undefined;
    const reply = await coreCaptureHostRequest(this.socket, '/v1/core-captures/reserved-start-capability', undefined, signal);
    if (canonicalPublicationJson(reply.value) !== canonicalPublicationJson(coreCaptureReservedStartCapability)) throw fail();
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
      const raw = optional.value;
      if (
        !raw ||
        typeof raw !== 'object' ||
        Object.keys(raw).join(',') !== 'error' ||
        !('error' in raw) ||
        typeof raw.error !== 'string' ||
        !raw.error.length ||
        raw.error.length > 4096
      )
        throw fail();
    } else {
      const raw = optional.value;
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('available' in raw) ||
        typeof raw.available !== 'boolean' ||
        canonicalPublicationJson(raw) !== canonicalPublicationJson({ ...coreCaptureSentinelStartCapability, available: raw.available })
      )
        throw fail();
      if (raw.available) publisher = 'sentinel.v1';
    }
    this.negotiation = { identity: optional.identity, publisher };
  }

  private binding(raw: unknown, point: string, reservation: string) {
    const value = validateCoreCaptureAbortPreparation(raw);
    if (value.id !== point || value.pointReservationSha256 !== reservation) throw fail();
    return value;
  }

  private async recover(point: string, reservation: string, identity: string) {
    const signal = AbortSignal.timeout(30_000);
    const observed = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${point}/preparation`,
      { pointReservationSha256: reservation },
      signal,
      identity,
      false,
      undefined,
      true,
    );
    if (observed.statusCode === 200) return this.binding(observed.value, point, reservation);
    const raw = observed.value;
    if (
      observed.statusCode !== 409 ||
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).join(',') !== 'error' ||
      !('error' in raw) ||
      typeof raw.error !== 'string' ||
      !raw.error.length ||
      raw.error.length > 4096
    )
      throw fail();
    const capability = await coreCaptureHostRequest(this.socket, '/v1/core-captures/preparation-recovery-capability', undefined, signal, identity);
    if (canonicalPublicationJson(capability.value) !== canonicalPublicationJson(coreCapturePreparationRecoveryCapability)) throw fail();
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${point}/reconcile-preparation`,
      { pointReservationSha256: reservation },
      signal,
      identity,
    );
    return this.binding(reply.value, point, reservation);
  }

  async prepare(point: string, reservation: string, signal: AbortSignal) {
    const negotiation = this.negotiation;
    if (!negotiation || !uuid(point) || !hash(reservation) || this.attempted.has(point)) throw fail();
    signal.throwIfAborted();
    this.attempted.add(point);
    let raw: unknown;
    try {
      const reply = await coreCaptureHostRequest(
        this.socket,
        `/v1/core-captures/${point}/${negotiation.publisher === 'sentinel.v1' ? 'prepare-reserved-sentinel' : 'prepare-reserved'}`,
        {},
        signal,
        negotiation.identity,
        false,
        negotiation.publisher === 'sentinel.v1' ? 30 * 60_000 : undefined,
      );
      raw = reply.value;
    } catch (error) {
      if (!transportFailure(error) && !(signal.aborted && error === signal.reason)) throw error;
      raw = await this.recover(point, reservation, negotiation.identity);
    }
    const value = this.binding(raw, point, reservation);
    const token = Object.freeze({}) as PreparedReservedCoreCaptureStart;
    this.prepared.set(token, { identity: negotiation.identity, value });
    return Object.freeze({ preparation: value, token, publisher: negotiation.publisher });
  }

  async admit(token: PreparedReservedCoreCaptureStart, sourceHoldSha256: string, signal: AbortSignal) {
    const approved = this.prepared.get(token);
    if (!approved) throw fail();
    this.prepared.delete(token);
    if (!hash(sourceHoldSha256) || (await controllerCaptureSocketIdentity(this.socket)) !== approved.identity) throw fail();
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${approved.value.id}/admit`,
      { preparationSha256: approved.value.preparationSha256, sourceHoldSha256 },
      signal,
      approved.identity,
    );
    const raw = reply.value;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).sort().join(',') !== 'id,sourceHoldSha256,state,version' ||
      !('version' in raw) ||
      raw.version !== 1 ||
      !('id' in raw) ||
      raw.id !== approved.value.id ||
      !('sourceHoldSha256' in raw) ||
      raw.sourceHoldSha256 !== sourceHoldSha256 ||
      !('state' in raw) ||
      (raw.state !== 'launch-requested' && raw.state !== 'launch-unsettled')
    )
      throw fail();
    return Object.freeze({ version: 1, id: approved.value.id, state: raw.state, sourceHoldSha256 });
  }
}
