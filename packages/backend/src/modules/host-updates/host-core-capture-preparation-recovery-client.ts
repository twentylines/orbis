import { validateCoreCaptureAbortPreparation } from './host-core-capture-abort-client';
import { coreCaptureHostRequest } from './host-core-capture-start-client';
import { canonicalPublicationJson } from './host-controller-publication';

export const coreCapturePreparationRecoveryCapability = Object.freeze({
  schema: 'orbis.core-capture-preparation-recovery-capability.v1',
  version: 1,
  preparationVersion: 3,
  intentVersion: 1,
  operations: Object.freeze(['reconcile-preparation', 'preparation']),
  createsReservation: false,
  releasesCapture: false,
  admissionReplay: 'forbidden',
});

/** A lost reply may leave a partial intent; observation alone cannot finish it. */
export class HostCoreCapturePreparationRecoveryClient {
  private readonly submitted = new Set<string>();

  constructor(private readonly socket: string) {}

  async reconcile(point: string, pointReservationSha256: string, signal: AbortSignal) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(point) ||
      !/^[a-f0-9]{64}$/.test(pointReservationSha256) ||
      this.submitted.has(point)
    )
      throw new Error('Snapshot preparation needs recovery.');
    signal.throwIfAborted();
    const capability = await coreCaptureHostRequest(this.socket, '/v1/core-captures/preparation-recovery-capability', undefined, signal);
    if (canonicalPublicationJson(capability.value) !== canonicalPublicationJson(coreCapturePreparationRecoveryCapability))
      throw new Error('Snapshot preparation recovery is unavailable.');
    if (this.submitted.has(point)) throw new Error('Snapshot preparation needs recovery.');
    this.submitted.add(point);
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${point}/reconcile-preparation`,
      { pointReservationSha256 },
      signal,
      capability.identity,
    );
    const preparation = validateCoreCaptureAbortPreparation(reply.value);
    if (reply.identity !== capability.identity || preparation.id !== point || preparation.pointReservationSha256 !== pointReservationSha256)
      throw new Error('Snapshot preparation needs recovery.');
    return preparation;
  }
}
