import { validateCoreCaptureAbortPreparation } from './host-core-capture-abort-client';
import { coreCaptureHostRequest } from './host-core-capture-start-client';

/** Observes existing protected preparation; it never creates or admits a capture. */
export class HostCoreCaptureReservationObserver {
  constructor(private readonly socket: string) {}

  async observe(point: string, pointReservationSha256: string, signal: AbortSignal) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(point) || !/^[a-f0-9]{64}$/.test(pointReservationSha256))
      throw new Error('Snapshot preparation needs recovery.');
    const reply = await coreCaptureHostRequest(this.socket, `/v1/core-captures/${point}/preparation`, { pointReservationSha256 }, signal);
    const preparation = validateCoreCaptureAbortPreparation(reply.value);
    if (preparation.id !== point || preparation.pointReservationSha256 !== pointReservationSha256)
      throw new Error('Snapshot preparation needs recovery.');
    return preparation;
  }
}
