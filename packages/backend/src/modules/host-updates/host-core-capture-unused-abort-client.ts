import { canonicalPublicationJson } from './host-controller-publication';
import { validateCoreCaptureAbortPreparation, type CoreCaptureAbortPreparation } from './host-core-capture-abort-client';
import { coreCaptureHostRequest } from './host-core-capture-start-client';

type SourceAttempt = 'not-started' | 'setup-unwound' | 'setup-refused';
type QueueUnwind = Readonly<{ pauseId: string; generation: number; queues: readonly Readonly<{ name: string; messages: 0; consumers: 1 }>[] }>;
type QueueRefusal = Readonly<Omit<QueueUnwind, 'pauseId'> & { setupId: string; outcome: 'not-entered' | 'queue-refused' }>;
type Complete<K extends SourceAttempt> = Omit<CoreCaptureAbortPreparation, 'version'> &
  Readonly<{
    version: K extends 'not-started' ? 3 : K extends 'setup-unwound' ? 4 : 5;
    state: 'complete';
    sourceMarker: 'absent';
    sourceAttempt: K;
    decisionSha256: string;
    terminalSha256: string;
    commitSha256: string;
  }> &
  (K extends 'setup-unwound'
    ? Readonly<{ localLease: 'not-acquired'; queueUnwind: QueueUnwind }>
    : K extends 'setup-refused'
      ? Readonly<{ localLease: 'not-acquired'; queueRefusal: QueueRefusal }>
      : object);
const fields = [
  'version',
  'id',
  'state',
  'sourceMarker',
  'sourceAttempt',
  'preparationSha256',
  'decisionSha256',
  'terminalSha256',
  'commitSha256',
  'sourceSha256',
  'pointReservationSha256',
  'controller',
];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => new Error('Snapshot cancellation requires review.');
export const coreCaptureRefusedAbortCapability = Object.freeze({
  schema: 'orbis.core-capture-refused-abort-capability.v1',
  version: 1,
  preparationVersion: 3,
  terminalVersion: 5,
  localLease: 'not-acquired',
  operations: Object.freeze(['abort-refused-settle', 'abort-refused-status']),
  admissionReplay: 'forbidden',
});
function queueUnwind(raw: unknown): QueueUnwind {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'generation,pauseId,queues') throw fail();
  const value = raw as Record<string, unknown>;
  if (
    typeof value.pauseId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.pauseId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !Array.isArray(value.queues) ||
    value.queues.length !== 3
  )
    throw fail();
  const names = new Set(['app-events-queue', 'repo-queue', 'system-events-queue']);
  const queues = value.queues.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'consumers,messages,name') throw fail();
    const row = raw as Record<string, unknown>;
    if (typeof row.name !== 'string' || !names.delete(row.name) || row.messages !== 0 || row.consumers !== 1) throw fail();
    return Object.freeze({ name: row.name, messages: 0 as const, consumers: 1 as const });
  });
  return Object.freeze({ pauseId: value.pauseId, generation: value.generation as number, queues: Object.freeze(queues) });
}

function queueRefusal(raw: unknown): QueueRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'generation,outcome,queues,setupId')
    throw fail();
  const value = raw as Record<string, unknown>;
  if (value.outcome !== 'not-entered' && value.outcome !== 'queue-refused') throw fail();
  const checked = queueUnwind({ pauseId: value.setupId, generation: value.generation, queues: value.queues });
  return Object.freeze({ setupId: checked.pauseId, outcome: value.outcome, generation: checked.generation, queues: checked.queues });
}

class MarkerAbsentAbortClient<K extends SourceAttempt> {
  private readonly attempted = new Set<string>();
  protected expectedIdentity?: string;
  constructor(
    private readonly socket: string,
    private readonly kind: K,
  ) {}

  private async request(
    preparation: CoreCaptureAbortPreparation,
    decisionSha256: string,
    terminalSha256: string,
    signal: AbortSignal,
    observe: boolean,
  ) {
    const selected = validateCoreCaptureAbortPreparation(preparation);
    if (![decisionSha256, terminalSha256].every(hash)) throw fail();
    if (!observe) {
      if (this.attempted.has(selected.id)) throw fail();
      this.attempted.add(selected.id);
    }
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${selected.id}/abort-${this.kind === 'not-started' ? 'unused' : this.kind === 'setup-unwound' ? 'setup' : 'refused'}-${observe ? 'status' : 'settle'}`,
      { preparationSha256: selected.preparationSha256, decisionSha256, terminalSha256 },
      signal,
      observe ? undefined : this.expectedIdentity,
    );
    const raw = reply.value;
    const expectedFields =
      this.kind === 'not-started' ? fields : [...fields, 'localLease', this.kind === 'setup-unwound' ? 'queueUnwind' : 'queueRefusal'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== [...expectedFields].sort().join(','))
      throw fail();
    const value = raw as Record<string, unknown>;
    if (
      value.version !== (this.kind === 'not-started' ? 3 : this.kind === 'setup-unwound' ? 4 : 5) ||
      value.state !== 'complete' ||
      value.sourceMarker !== 'absent' ||
      value.sourceAttempt !== this.kind ||
      value.decisionSha256 !== decisionSha256 ||
      value.terminalSha256 !== terminalSha256 ||
      !hash(value.commitSha256) ||
      ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'].some(
        (key) => canonicalPublicationJson(value[key]) !== canonicalPublicationJson(Reflect.get(selected, key)),
      )
    )
      throw fail();
    if (this.kind === 'setup-unwound') {
      if (value.localLease !== 'not-acquired') throw fail();
      value.queueUnwind = queueUnwind(value.queueUnwind);
    } else if (this.kind === 'setup-refused') {
      if (value.localLease !== 'not-acquired') throw fail();
      value.queueRefusal = queueRefusal(value.queueRefusal);
    }
    return Object.freeze({ ...value, controller: selected.controller }) as Complete<K>;
  }
  settle(preparation: CoreCaptureAbortPreparation, decisionSha256: string, terminalSha256: string, signal: AbortSignal) {
    return this.request(preparation, decisionSha256, terminalSha256, signal, false);
  }
  status(preparation: CoreCaptureAbortPreparation, decisionSha256: string, terminalSha256: string, signal: AbortSignal) {
    return this.request(preparation, decisionSha256, terminalSha256, signal, true);
  }
}

/** A never-started source needs no consumer transition or local hold-clearing grant. */
export class HostCoreCaptureUnusedAbortClient extends MarkerAbsentAbortClient<'not-started'> {
  constructor(socket: string) {
    super(socket, 'not-started');
  }
}

/** Settles a finished setup only after its own queue resources were positively unwound. */
export class HostCoreCaptureSetupAbortClient extends MarkerAbsentAbortClient<'setup-unwound'> {
  constructor(socket: string) {
    super(socket, 'setup-unwound');
  }
}

export class HostCoreCaptureRefusedAbortClient extends MarkerAbsentAbortClient<'setup-refused'> {
  constructor(private readonly capabilitySocket: string) {
    super(capabilitySocket, 'setup-refused');
  }
  async requireCapability(signal: AbortSignal) {
    const reply = await coreCaptureHostRequest(this.capabilitySocket, '/v1/core-captures/refused-abort-capability', undefined, signal);
    if (canonicalPublicationJson(reply.value) !== canonicalPublicationJson(coreCaptureRefusedAbortCapability)) throw fail();
    this.expectedIdentity = reply.identity;
    return reply.identity;
  }
}
