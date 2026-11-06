import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';
import { coreCaptureHostRequest } from './host-core-capture-start-client';

export type CoreCaptureAbortPreparation = Readonly<{
  version: 3;
  id: string;
  preparationSha256: string;
  sourceSha256: string;
  pointReservationSha256: string;
  controller: Readonly<{ id: string; imageId: string; startedAt: string; definitionSha256: string }>;
}>;
export type CoreCaptureAbortIntentDetails = CoreCaptureAbortPreparation & { readonly decisionSha256: string };
export type CoreCaptureAbortDetails = Readonly<{
  version: 1;
  id: string;
  state: 'verified-abort-awaiting-continuation' | 'complete';
  preparationSha256: string;
  decisionSha256: string;
  terminalSha256: string;
  approvalSha256: string;
  sourceSha256: string;
  sourceHoldSha256: string;
  pointReservationSha256: string;
  controller: CoreCaptureAbortPreparation['controller'];
  continuationSha256?: string;
}>;
declare const intentBrand: unique symbol;
declare const approvalBrand: unique symbol;
declare const completeBrand: unique symbol;
export type VerifiedCoreAbortIntent = { readonly [intentBrand]: true };
export type VerifiedCoreAbortApproval = { readonly [approvalBrand]: true };
export type VerifiedCoreAbortComplete = { readonly [completeBrand]: true };
type Grant<T> = { details: T; verify: () => Promise<void> };
const intents = new WeakMap<VerifiedCoreAbortIntent, Grant<CoreCaptureAbortIntentDetails>>();
const approvals = new WeakMap<VerifiedCoreAbortApproval, Grant<CoreCaptureAbortDetails>>();
const completions = new WeakMap<VerifiedCoreAbortComplete, Grant<CoreCaptureAbortDetails>>();
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const fail = () => new Error('Snapshot cancellation requires review.');
const bindingFields = ['version', 'id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'];
export function validateCoreCaptureAbortPreparation(value: unknown): CoreCaptureAbortPreparation {
  if (
    !exact(value, bindingFields) ||
    value.version !== 3 ||
    !uuid(value.id) ||
    !['preparationSha256', 'sourceSha256', 'pointReservationSha256'].every((key) => hash(value[key])) ||
    !exact(value.controller, ['id', 'imageId', 'startedAt', 'definitionSha256']) ||
    !hash(value.controller.id) ||
    !hash(value.controller.definitionSha256) ||
    typeof value.controller.imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.controller.imageId) ||
    typeof value.controller.startedAt !== 'string' ||
    !/^[\x20-\x7e]{1,128}$/.test(value.controller.startedAt)
  )
    throw fail();
  return Object.freeze({ ...value, controller: Object.freeze({ ...value.controller }) }) as CoreCaptureAbortPreparation;
}
const binding = validateCoreCaptureAbortPreparation;
async function useGrant<K extends object, T, R>(map: WeakMap<K, Grant<T>>, token: K, work: (details: T) => Promise<R>): Promise<R> {
  const grant = map.get(token);
  if (!grant) throw fail();
  map.delete(token);
  await grant.verify();
  const result = await work(grant.details);
  await grant.verify();
  return result;
}
export const useVerifiedCoreAbortIntent = <T>(token: VerifiedCoreAbortIntent, work: (details: CoreCaptureAbortIntentDetails) => Promise<T>) =>
  useGrant(intents, token, work);
export const useVerifiedCoreAbortApproval = <T>(token: VerifiedCoreAbortApproval, work: (details: CoreCaptureAbortDetails) => Promise<T>) =>
  useGrant(approvals, token, work);
export const useVerifiedCoreAbortComplete = <T>(token: VerifiedCoreAbortComplete, work: (details: CoreCaptureAbortDetails) => Promise<T>) =>
  useGrant(completions, token, work);

/** Tokens are live-channel approvals; no caller-supplied object can clear a source hold. */
export class HostCoreCaptureAbortClient {
  private readonly attempted = new Set<string>();
  private readonly knownApprovals = new WeakMap<CoreCaptureAbortDetails, string>();
  constructor(private readonly socket: string) {}

  private verifier(identity: string) {
    return async () => {
      try {
        if ((await controllerCaptureSocketIdentity(this.socket)) !== identity) throw fail();
      } catch {
        throw fail();
      }
    };
  }

  private async getIntent(preparation: CoreCaptureAbortPreparation, observe: boolean, signal: AbortSignal, expectedIdentity?: string) {
    const selected = binding(preparation);
    const key = `${selected.id}:${selected.preparationSha256}`;
    if (!observe) {
      if (this.attempted.has(key)) throw fail();
      this.attempted.add(key);
    }
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${selected.id}/abort-intent${observe ? '/status' : ''}`,
      { preparationSha256: selected.preparationSha256 },
      signal,
      expectedIdentity,
    );
    const raw = reply.value;
    if (
      !exact(raw, ['version', 'id', 'state', 'preparationSha256', 'decisionSha256']) ||
      raw.version !== 1 ||
      raw.id !== selected.id ||
      raw.state !== 'abort-intent' ||
      raw.preparationSha256 !== selected.preparationSha256 ||
      !hash(raw.decisionSha256)
    )
      throw fail();
    const token = Object.freeze({}) as VerifiedCoreAbortIntent;
    const details = Object.freeze({ ...selected, decisionSha256: raw.decisionSha256 });
    intents.set(token, { details, verify: this.verifier(reply.identity) });
    return Object.freeze({ details, token });
  }

  intent(preparation: CoreCaptureAbortPreparation, signal: AbortSignal, expectedIdentity?: string) {
    return this.getIntent(preparation, false, signal, expectedIdentity);
  }
  observeIntent(preparation: CoreCaptureAbortPreparation, signal: AbortSignal, expectedIdentity?: string) {
    return this.getIntent(preparation, true, signal, expectedIdentity);
  }

  private details(
    raw: unknown,
    preparation: CoreCaptureAbortPreparation,
    decisionSha256: string,
    terminalSha256: string,
    sourceHoldSha256: string,
    complete: boolean,
  ): CoreCaptureAbortDetails {
    const fields = [
      'version',
      'id',
      'state',
      'preparationSha256',
      'decisionSha256',
      'terminalSha256',
      'approvalSha256',
      'sourceSha256',
      'sourceHoldSha256',
      'pointReservationSha256',
      'controller',
      ...(complete ? ['continuationSha256'] : []),
    ];
    if (
      !exact(raw, fields) ||
      raw.version !== 1 ||
      raw.id !== preparation.id ||
      raw.state !== (complete ? 'complete' : 'verified-abort-awaiting-continuation') ||
      raw.preparationSha256 !== preparation.preparationSha256 ||
      raw.decisionSha256 !== decisionSha256 ||
      raw.terminalSha256 !== terminalSha256 ||
      raw.sourceHoldSha256 !== sourceHoldSha256 ||
      raw.sourceSha256 !== preparation.sourceSha256 ||
      raw.pointReservationSha256 !== preparation.pointReservationSha256 ||
      canonicalPublicationJson(raw.controller) !== canonicalPublicationJson(preparation.controller) ||
      !hash(raw.approvalSha256) ||
      (complete && !hash(raw.continuationSha256))
    )
      throw fail();
    return Object.freeze({ ...raw, controller: preparation.controller }) as CoreCaptureAbortDetails;
  }

  private async approval(
    preparation: CoreCaptureAbortPreparation,
    decisionSha256: string,
    terminalSha256: string,
    sourceHoldSha256: string,
    signal: AbortSignal,
    observe: boolean,
  ) {
    const selected = binding(preparation);
    if (![decisionSha256, terminalSha256, sourceHoldSha256].every(hash)) throw fail();
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${selected.id}/abort-${observe ? 'status' : 'prepare'}`,
      { preparationSha256: selected.preparationSha256, decisionSha256, terminalSha256 },
      signal,
    );
    const details = this.details(reply.value, selected, decisionSha256, terminalSha256, sourceHoldSha256, false);
    this.knownApprovals.set(details, reply.identity);
    const token = Object.freeze({}) as VerifiedCoreAbortApproval;
    approvals.set(token, { details, verify: this.verifier(reply.identity) });
    return Object.freeze({ details, token });
  }

  prepare(preparation: CoreCaptureAbortPreparation, decisionSha256: string, terminalSha256: string, sourceHoldSha256: string, signal: AbortSignal) {
    return this.approval(preparation, decisionSha256, terminalSha256, sourceHoldSha256, signal, false);
  }

  observeApproval(
    preparation: CoreCaptureAbortPreparation,
    decisionSha256: string,
    terminalSha256: string,
    sourceHoldSha256: string,
    signal: AbortSignal,
  ) {
    return this.approval(preparation, decisionSha256, terminalSha256, sourceHoldSha256, signal, true);
  }

  private preparation(details: CoreCaptureAbortDetails): CoreCaptureAbortPreparation {
    return binding({
      version: 3,
      id: details.id,
      preparationSha256: details.preparationSha256,
      sourceSha256: details.sourceSha256,
      pointReservationSha256: details.pointReservationSha256,
      controller: details.controller,
    });
  }

  private async completion(approval: CoreCaptureAbortDetails, continuationSha256: string, observe: boolean, signal: AbortSignal) {
    const identity = this.knownApprovals.get(approval);
    if (!identity || !hash(continuationSha256)) throw fail();
    await this.verifier(identity)();
    const request = {
      preparationSha256: approval.preparationSha256,
      decisionSha256: approval.decisionSha256,
      terminalSha256: approval.terminalSha256,
      ...(observe ? {} : { approvalSha256: approval.approvalSha256, continuationSha256 }),
    };
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${approval.id}/abort-${observe ? 'status' : 'finish'}`,
      request,
      signal,
    );
    const details = this.details(
      reply.value,
      this.preparation(approval),
      approval.decisionSha256,
      approval.terminalSha256,
      approval.sourceHoldSha256,
      true,
    );
    if (reply.identity !== identity || details.approvalSha256 !== approval.approvalSha256 || details.continuationSha256 !== continuationSha256)
      throw fail();
    const token = Object.freeze({}) as VerifiedCoreAbortComplete;
    completions.set(token, { details, verify: this.verifier(identity) });
    return Object.freeze({ details, token });
  }

  finish(approval: CoreCaptureAbortDetails, continuationSha256: string, signal: AbortSignal) {
    return this.completion(approval, continuationSha256, false, signal);
  }
  observeComplete(approval: CoreCaptureAbortDetails, continuationSha256: string, signal: AbortSignal) {
    return this.completion(approval, continuationSha256, true, signal);
  }
}
