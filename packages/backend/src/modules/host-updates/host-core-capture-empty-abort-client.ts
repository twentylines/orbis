import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';
import { coreCaptureHostRequest } from './host-core-capture-start-client';
import { HostCoreCaptureAbortClient, validateCoreCaptureAbortPreparation, type CoreCaptureAbortPreparation } from './host-core-capture-abort-client';

export type CoreCaptureEmptyAbortDetails = Readonly<{
  version: 2;
  id: string;
  state: 'verified-abort-awaiting-continuation' | 'complete';
  sourceMarker: 'absent';
  preparationSha256: string;
  decisionSha256: string;
  terminalSha256: string;
  approvalSha256: string;
  sourceSha256: string;
  pointReservationSha256: string;
  controller: CoreCaptureAbortPreparation['controller'];
  continuationSha256?: string;
}>;
declare const approvalBrand: unique symbol;
declare const completeBrand: unique symbol;
export type VerifiedCoreEmptyAbortApproval = { readonly [approvalBrand]: true };
export type VerifiedCoreEmptyAbortComplete = { readonly [completeBrand]: true };
type Grant = { details: CoreCaptureEmptyAbortDetails; verify: () => Promise<void> };
const approvals = new WeakMap<VerifiedCoreEmptyAbortApproval, Grant>();
const completions = new WeakMap<VerifiedCoreEmptyAbortComplete, Grant>();
const fail = () => new Error('Early snapshot cancellation requires review.');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
async function useGrant<K extends object, T>(map: WeakMap<K, Grant>, token: K, work: (details: CoreCaptureEmptyAbortDetails) => Promise<T>) {
  const grant = map.get(token);
  if (!grant) throw fail();
  map.delete(token);
  await grant.verify();
  const result = await work(grant.details);
  await grant.verify();
  return result;
}
export const useVerifiedCoreEmptyAbortApproval = <T>(
  token: VerifiedCoreEmptyAbortApproval,
  work: (details: CoreCaptureEmptyAbortDetails) => Promise<T>,
) => useGrant(approvals, token, work);
export const useVerifiedCoreEmptyAbortComplete = <T>(
  token: VerifiedCoreEmptyAbortComplete,
  work: (details: CoreCaptureEmptyAbortDetails) => Promise<T>,
) => useGrant(completions, token, work);

/** Shares intent authority with complete-marker cancellation, with distinct version-two settlement tokens. */
export class HostCoreCaptureEmptyAbortClient {
  private readonly intents: HostCoreCaptureAbortClient;
  private readonly known = new WeakMap<CoreCaptureEmptyAbortDetails, string>();
  constructor(private readonly socket: string) {
    this.intents = new HostCoreCaptureAbortClient(socket);
  }
  intent(preparation: CoreCaptureAbortPreparation, signal: AbortSignal, expectedIdentity?: string) {
    return this.intents.intent(preparation, signal, expectedIdentity);
  }
  observeIntent(preparation: CoreCaptureAbortPreparation, signal: AbortSignal, expectedIdentity?: string) {
    return this.intents.observeIntent(preparation, signal, expectedIdentity);
  }
  private verify(identity: string) {
    return async () => {
      try {
        if ((await controllerCaptureSocketIdentity(this.socket)) !== identity) throw fail();
      } catch {
        throw fail();
      }
    };
  }
  private details(
    raw: unknown,
    preparation: CoreCaptureAbortPreparation,
    decision: string,
    terminal: string,
    complete: boolean,
  ): CoreCaptureEmptyAbortDetails {
    const keys = [
      'version',
      'id',
      'state',
      'sourceMarker',
      'preparationSha256',
      'decisionSha256',
      'terminalSha256',
      'approvalSha256',
      'sourceSha256',
      'pointReservationSha256',
      'controller',
      ...(complete ? ['continuationSha256'] : []),
    ];
    if (
      !exact(raw, keys) ||
      raw.version !== 2 ||
      raw.sourceMarker !== 'absent' ||
      raw.id !== preparation.id ||
      raw.state !== (complete ? 'complete' : 'verified-abort-awaiting-continuation') ||
      raw.preparationSha256 !== preparation.preparationSha256 ||
      raw.decisionSha256 !== decision ||
      raw.terminalSha256 !== terminal ||
      raw.sourceSha256 !== preparation.sourceSha256 ||
      raw.pointReservationSha256 !== preparation.pointReservationSha256 ||
      !hash(raw.approvalSha256) ||
      canonicalPublicationJson(raw.controller) !== canonicalPublicationJson(preparation.controller) ||
      (complete && !hash(raw.continuationSha256))
    )
      throw fail();
    return Object.freeze({ ...raw, controller: preparation.controller }) as CoreCaptureEmptyAbortDetails;
  }
  private async approval(
    preparation: CoreCaptureAbortPreparation,
    decisionSha256: string,
    terminalSha256: string,
    signal: AbortSignal,
    observe: boolean,
  ) {
    const selected = validateCoreCaptureAbortPreparation(preparation);
    if (!hash(decisionSha256) || !hash(terminalSha256)) throw fail();
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${selected.id}/abort-empty-${observe ? 'status' : 'prepare'}`,
      { preparationSha256: selected.preparationSha256, decisionSha256, terminalSha256 },
      signal,
    );
    const details = this.details(reply.value, selected, decisionSha256, terminalSha256, false);
    const token = Object.freeze({}) as VerifiedCoreEmptyAbortApproval;
    this.known.set(details, reply.identity);
    approvals.set(token, { details, verify: this.verify(reply.identity) });
    return Object.freeze({ details, token });
  }
  prepare(preparation: CoreCaptureAbortPreparation, decisionSha256: string, terminalSha256: string, signal: AbortSignal) {
    return this.approval(preparation, decisionSha256, terminalSha256, signal, false);
  }
  observeApproval(preparation: CoreCaptureAbortPreparation, decisionSha256: string, terminalSha256: string, signal: AbortSignal) {
    return this.approval(preparation, decisionSha256, terminalSha256, signal, true);
  }
  private async completion(approval: CoreCaptureEmptyAbortDetails, continuationSha256: string, signal: AbortSignal, observe: boolean) {
    const identity = this.known.get(approval);
    if (!identity || !hash(continuationSha256)) throw fail();
    await this.verify(identity)();
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${approval.id}/abort-empty-${observe ? 'status' : 'finish'}`,
      {
        preparationSha256: approval.preparationSha256,
        decisionSha256: approval.decisionSha256,
        terminalSha256: approval.terminalSha256,
        ...(observe ? {} : { approvalSha256: approval.approvalSha256, continuationSha256 }),
      },
      signal,
    );
    const preparation = validateCoreCaptureAbortPreparation({
      version: 3,
      id: approval.id,
      preparationSha256: approval.preparationSha256,
      sourceSha256: approval.sourceSha256,
      pointReservationSha256: approval.pointReservationSha256,
      controller: approval.controller,
    });
    const details = this.details(reply.value, preparation, approval.decisionSha256, approval.terminalSha256, true);
    if (reply.identity !== identity || details.approvalSha256 !== approval.approvalSha256 || details.continuationSha256 !== continuationSha256)
      throw fail();
    const token = Object.freeze({}) as VerifiedCoreEmptyAbortComplete;
    completions.set(token, { details, verify: this.verify(identity) });
    return Object.freeze({ details, token });
  }
  finish(approval: CoreCaptureEmptyAbortDetails, continuationSha256: string, signal: AbortSignal) {
    return this.completion(approval, continuationSha256, signal, false);
  }
  observeComplete(approval: CoreCaptureEmptyAbortDetails, continuationSha256: string, signal: AbortSignal) {
    return this.completion(approval, continuationSha256, signal, true);
  }
}
