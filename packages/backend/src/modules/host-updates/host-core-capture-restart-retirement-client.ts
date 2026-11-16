import { canonicalPublicationJson } from './host-controller-publication';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import { coreCaptureHostRequest } from './host-core-capture-start-client';

export const coreCaptureRestartRetirementReaderCapability = Object.freeze({
  schema: 'orbis.core-capture-restart-retirement-reader.v1',
  version: 1,
  preparationVersion: 3,
  retirementVersion: 2,
  operations: Object.freeze(['restart-retirement']),
  sourceWrites: false,
  lifecycleAuthority: false,
});
const policies = {
  scope: 'retire-unadmitted-preparation-after-controller-restart-only',
  captureCompleted: false,
  sourceAttempt: 'unknown-before-controller-restart',
  queueStateProved: false,
  hostRebootProved: false,
  activation: false,
  restoreAuthority: false,
} as const;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const fail = () => new Error('The interrupted capture retirement could not be verified.');
type Details = Readonly<{
  id: string;
  pointReservationSha256: string;
  pointRecordSha256: string;
  sourceSha256: string;
  intentSha256: string;
  receiptSha256: string;
}>;
declare const verifiedRetirement: unique symbol;
export type VerifiedCoreCaptureRetirement = { readonly [verifiedRetirement]: true };
const issued = new WeakMap<VerifiedCoreCaptureRetirement, { details: Details; verify: () => Promise<void> }>();

export async function useVerifiedCoreCaptureRetirement<T>(token: VerifiedCoreCaptureRetirement, work: (details: Details) => Promise<T>) {
  const authority = issued.get(token);
  if (!authority) throw fail();
  issued.delete(token);
  await authority.verify();
  return work(authority.details);
}

/** Observes a completed Root decision; never asks Root to retire a preparation or resume queues. */
export class HostCoreCaptureRestartRetirementClient {
  constructor(private readonly socket: string) {}

  async observe(point: string, reservation: string, signal: AbortSignal): Promise<VerifiedCoreCaptureRetirement | null> {
    if (!id(point) || !hash(reservation)) throw fail();
    signal.throwIfAborted();
    const capability = await coreCaptureHostRequest(
      this.socket,
      '/v1/core-captures/restart-retirement-capability',
      undefined,
      signal,
      undefined,
      true,
      5000,
    );
    if (capability.statusCode === 404) return null;
    if (canonicalPublicationJson(capability.value) !== canonicalPublicationJson(coreCaptureRestartRetirementReaderCapability)) throw fail();
    const response = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${point}/restart-retirement`,
      { pointReservationSha256: reservation },
      signal,
      capability.identity,
      false,
      5000,
    );
    const raw = response.value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
    const value = raw as Record<string, unknown>;
    const common = { version: 1, id: point, pointReservationSha256: reservation, ...policies };
    if (value.state === 'not-retired') {
      if (canonicalPublicationJson(value) !== canonicalPublicationJson({ ...common, state: 'not-retired' })) throw fail();
      return null;
    }
    const names = ['pointRecordSha256', 'sourceSha256', 'intentSha256', 'receiptSha256'] as const;
    const details = { id: point, pointReservationSha256: reservation } as Details;
    for (const name of names) {
      if (!hash(value[name])) throw fail();
      Object.assign(details, { [name]: value[name] });
    }
    if (
      response.identity !== capability.identity ||
      canonicalPublicationJson(value) !== canonicalPublicationJson({ ...common, ...details, state: 'preparation-retired' })
    )
      throw fail();
    const token = Object.freeze({}) as VerifiedCoreCaptureRetirement;
    issued.set(token, {
      details: Object.freeze(details),
      verify: async () => {
        signal.throwIfAborted();
        if ((await controllerCaptureSocketIdentity(this.socket)) !== capability.identity) throw fail();
      },
    });
    return token;
  }
}
