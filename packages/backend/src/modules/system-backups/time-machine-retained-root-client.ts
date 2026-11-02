import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { callProtectedRetainedRoot, retainedPublicationSchema } from './time-machine-retained-phase-client';
import { retainedRootBindingSchema, retainedSourceBindingSchema } from './time-machine-retained-bootstrap';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { readTerminalJson, writeTerminalJson } from './backup-restore-terminal-record';
import { privateBackupDirectory } from './backup-files';

const fail = () => new Error('Protected retained restore requires recovery.');
const reviewSchema = type({
  version: '1',
  pointId: uuid,
  restoreId: uuid,
  importId: uuid,
  currentRevision: hash,
  stageRevision: hash,
  publication: retainedPublicationSchema,
}).onUndeclaredKey('reject');
const tokenSchema = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const imageDigest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const databaseIdentifier = type('string').narrow((value) => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value));
const databaseOid = type('number.integer > 0').narrow((value) => value <= 2 ** 32 - 1);
const privateSchema = type({ version: '1', review: reviewSchema, clientKey: tokenSchema }).onUndeclaredKey('reject');
const states =
  "'allocating' | 'allocated' | 'preparing' | 'prepared' | 'promoting' | 'verifying' | 'commit-decided' | 'committing' | 'activating' | 'active' | 'complete' | 'rolling-back' | 'rolled-back'";
const statusSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  state: states,
  decision: "'commit' | 'rollback' | null",
  recoverable: 'boolean',
  admissionSha256: hash,
  binding: retainedRootBindingSchema.or('null'),
}).onUndeclaredKey('reject');
const candidateResumeSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  nonce: uuid,
  state: "'activating' | 'active'",
  decision: "'commit'",
  binding: retainedRootBindingSchema,
  operationSha256: hash,
  imageCaptureSha256: hash,
  imageInventorySha256: hash,
  expiresAt: '0 < number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');
const candidateAppResultSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  nonce: uuid,
  state: "'activating' | 'active'",
  decision: "'commit'",
  binding: retainedRootBindingSchema,
  operationSha256: hash,
  imageCaptureSha256: hash,
  imageInventorySha256: hash,
  appRuntimeSha256: hash,
  appEffectsSha256: hash,
  containers: type({
    appUrn: 'string > 0 & string <= 512',
    service: 'string > 0 & string <= 128',
    ordinal: '0 < number.integer <= 1024',
    id: hash,
    imageId: imageDigest,
    wasRunning: 'boolean',
  })
    .onUndeclaredKey('reject')
    .array()
    .atMostLength(1024),
  expiresAt: '0 < number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');
export function decodeRetainedCandidateAppResult(raw: unknown, expected: { restoreId: string; pointId: string; now: number }) {
  const result = candidateAppResultSchema(raw);
  if (
    result instanceof type.errors ||
    result.transactionId !== expected.restoreId ||
    result.pointId !== expected.pointId ||
    result.binding.restoreId !== result.transactionId ||
    result.binding.pointId !== result.pointId ||
    result.binding.nonce !== result.nonce ||
    new Set([result.binding.originalController, result.binding.candidateController, result.binding.verifierController, result.binding.workerId])
      .size !== 4 ||
    !Number.isSafeInteger(expected.now) ||
    result.expiresAt <= expected.now ||
    result.expiresAt > expected.now + 15 * 60_000 ||
    new Set(result.containers.map((item) => item.id)).size !== result.containers.length
  )
    throw fail();
  return result;
}
export function decodeRetainedCandidateResume(raw: unknown, expected: { restoreId: string; pointId: string; now: number }) {
  const result = candidateResumeSchema(raw);
  if (
    result instanceof type.errors ||
    result.transactionId !== expected.restoreId ||
    result.pointId !== expected.pointId ||
    result.binding.restoreId !== result.transactionId ||
    result.binding.pointId !== result.pointId ||
    result.binding.nonce !== result.nonce ||
    new Set([result.binding.originalController, result.binding.candidateController, result.binding.verifierController, result.binding.workerId])
      .size !== 4 ||
    !Number.isSafeInteger(expected.now) ||
    result.expiresAt <= expected.now ||
    result.expiresAt > expected.now + 15 * 60_000
  )
    throw fail();
  return result;
}
const normalBootstrapSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  nonce: uuid,
  state: "'settled'",
  decision: "'commit'",
  binding: retainedRootBindingSchema,
  operationSha256: hash,
  terminalProofSha256: hash,
  bootstrapLeaseId: uuid,
  expiresAt: '0 < number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');
const normalBootstrapReadySchema = type({ version: '1', transactionId: uuid, state: "'ready'", terminalProofSha256: hash }).onUndeclaredKey('reject');
const normalBootstrapStatusSchema = type({
  version: '1',
  transactionId: uuid,
  terminalProofSha256: hash,
  required: 'boolean',
  state: "'not-required' | 'pending' | 'ready'",
  bootstrapLeaseId: uuid.or('null'),
}).onUndeclaredKey('reject');
export function decodeRetainedNormalBootstrap(
  raw: unknown,
  expected: {
    restoreId: string;
    pointId: string;
    nonce: string;
    operationSha256: string;
    terminalProofSha256: string;
    binding: typeof retainedRootBindingSchema.infer;
    now: number;
  },
) {
  const value = normalBootstrapSchema(raw);
  if (
    value instanceof type.errors ||
    value.transactionId !== expected.restoreId ||
    value.pointId !== expected.pointId ||
    value.nonce !== expected.nonce ||
    value.binding.restoreId !== value.transactionId ||
    value.binding.pointId !== value.pointId ||
    value.binding.nonce !== value.nonce ||
    new Set([value.binding.originalController, value.binding.candidateController, value.binding.verifierController, value.binding.workerId]).size !==
      4 ||
    canonicalPublicationJson(value.binding) !== canonicalPublicationJson(expected.binding) ||
    value.operationSha256 !== expected.operationSha256 ||
    value.terminalProofSha256 !== expected.terminalProofSha256 ||
    !Number.isSafeInteger(expected.now) ||
    value.expiresAt <= expected.now ||
    value.expiresAt > expected.now + 15 * 60_000
  )
    throw fail();
  return value;
}
const beginSchema = type({
  version: '1',
  transactionId: uuid,
  token: tokenSchema,
  binding: retainedRootBindingSchema.or('null'),
  state: states,
}).onUndeclaredKey('reject');
const absenceSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  state: "'absent'",
  revoked: 'true',
  admissionSha256: hash,
  currentRevision: hash,
  stageRevision: hash,
}).onUndeclaredKey('reject');
const publicSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  state: states,
  decision: "'commit' | 'rollback' | null",
  recoverable: 'boolean',
}).onUndeclaredKey('reject');
const terminalFinalizedSchema = type({ version: '1', transactionId: uuid, state: "'settled'", proofSha256: hash }).onUndeclaredKey('reject');
const terminalProofSchema = type({
  schema: "'orbis.retained-terminal-proof.v1'",
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  state: "'complete' | 'rolled-back'",
  decision: "'commit' | 'rollback'",
  admissionSha256: hash,
  sourceBinding: retainedSourceBindingSchema,
  binding: retainedRootBindingSchema.or('null'),
  nodePhase: "'completed' | 'rolled-back' | 'discarded' | 'staging'",
  nodeJournalSha256: hash,
  operationSha256: hash.or('null'),
  survivor: type({ id: hash, imageId: imageDigest, definitionSha256: hash, role: "'candidate' | 'original'" }).onUndeclaredKey('reject'),
  database: type({
    containerId: hash,
    imageId: imageDigest,
    name: databaseIdentifier,
    user: databaseIdentifier,
    oid: databaseOid,
    marker: 'string | null',
    connectionSha256: hash,
    environmentSha256: hash,
  }).onUndeclaredKey('reject'),
  retired: type({ role: "'previous' | 'candidate' | 'verifier' | 'coordinator' | 'provisional-worker' | 'provisional-verifier'", id: hash })
    .onUndeclaredKey('reject')
    .array(),
  proofSha256: hash,
}).onUndeclaredKey('reject');
export function decodeRetainedTerminalProof(raw: unknown, expected: { restoreId: string; pointId: string }) {
  const result = terminalProofSchema(raw);
  if (
    result instanceof type.errors ||
    result.transactionId !== expected.restoreId ||
    result.pointId !== expected.pointId ||
    result.admissionSha256 !== result.sourceBinding.admissionSha256 ||
    (!result.binding && ['completed', 'rolled-back'].includes(result.nodePhase)) ||
    (result.binding &&
      (result.binding.restoreId !== result.transactionId ||
        result.binding.pointId !== result.pointId ||
        canonicalPublicationJson(result.binding.sourceBinding) !== canonicalPublicationJson(result.sourceBinding))) ||
    (result.state === 'complete'
      ? result.decision !== 'commit' || result.nodePhase !== 'completed' || result.survivor.role !== 'candidate'
      : result.decision !== 'rollback' ||
        !['rolled-back', 'discarded', 'staging'].includes(result.nodePhase) ||
        result.survivor.role !== 'original') ||
    (result.operationSha256 === null && !['discarded', 'staging'].includes(result.nodePhase)) ||
    new Set(result.retired.map((item) => item.role)).size !== result.retired.length ||
    new Set(result.retired.map((item) => item.id)).size !== result.retired.length ||
    result.retired.some((item) => item.id === result.survivor.id)
  )
    throw fail();
  const { proofSha256, ...body } = result;
  if (
    createHash('sha256')
      .update(
        `orbis.retained-terminal-proof.v1\n${canonicalPublicationJson(body).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}`,
      )
      .digest('hex') !== proofSha256
  )
    throw fail();
  return result;
}

export type RetainedRootReview = typeof reviewSchema.infer;

const candidateResumeCapabilitySchema = type({
  version: '1',
  protocol: "'root-candidate-resume.v1'",
  leaseMilliseconds: '900000',
  requiresAppCapability: "'orbis.retained-app-activation.v1'",
}).onUndeclaredKey('reject');
const normalBootstrapCapabilitySchema = type({
  version: '1',
  protocol: "'root-candidate-resume.v1'",
  leaseMilliseconds: '900000',
  requiresAppCapability: "'orbis.retained-app-activation.v1'",
  normalBootstrap: "'root-normal-bootstrap.v1'",
  ordinaryWritesHeldUntilBootstrap: 'true',
}).onUndeclaredKey('reject');
export async function retainedNormalBootstrapCapability(signal: AbortSignal) {
  const raw = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    '/v1/retained-restore/candidate-resume-capability',
    {},
    signal,
    4096,
    200,
    30_000,
    'GET',
    true,
  );
  if (raw === null || !(candidateResumeCapabilitySchema(raw) instanceof type.errors)) return false;
  const value = normalBootstrapCapabilitySchema(raw);
  if (value instanceof type.errors || !raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 6) throw fail();
  return true;
}
async function requireCandidateResumeCapability(signal: AbortSignal) {
  const raw = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    '/v1/retained-restore/candidate-resume-capability',
    {},
    signal,
    4096,
    200,
    30_000,
    'GET',
  );
  if (candidateResumeCapabilitySchema(raw) instanceof type.errors && normalBootstrapCapabilitySchema(raw) instanceof type.errors) throw fail();
}

export async function reviewRetainedRoot(options: { pointId: string; restoreId: string; importId: string; signal: AbortSignal }) {
  if (![options.pointId, options.restoreId, options.importId].every((value) => uuid.allows(value))) throw fail();
  await requireCandidateResumeCapability(options.signal);
  const raw = await callProtectedRetainedRoot(
    '/run/orbis/host.sock',
    '/v1/retained-restore/review',
    { pointId: options.pointId, restoreId: options.restoreId, importId: options.importId },
    options.signal,
    512 * 1024,
    200,
    15 * 60_000,
  );
  const result = reviewSchema(raw);
  if (
    result instanceof type.errors ||
    result.pointId !== options.pointId ||
    result.restoreId !== options.restoreId ||
    result.importId !== options.importId
  )
    throw fail();
  return result;
}

// Persist before begin so an interrupted request can be reconciled with the same opaque capability.
export class RetainedRootTransaction {
  readonly #review: RetainedRootReview;
  readonly #clientKey: string;
  private constructor(review: RetainedRootReview, clientKey: string) {
    this.#review = review;
    this.#clientKey = clientKey;
  }
  toJSON(): never {
    throw fail();
  }
  static async create(directory: string, review: RetainedRootReview) {
    if (!path.isAbsolute(directory) || path.basename(directory) !== review.restoreId || reviewSchema(review) instanceof type.errors) throw fail();
    await privateBackupDirectory(directory);
    const file = path.join(directory, 'retained-root-request.json');
    const value = { version: 1 as const, review, clientKey: randomBytes(32).toString('hex') };
    await writeTerminalJson(file, value, true);
    return RetainedRootTransaction.read(directory);
  }
  static async read(directory: string) {
    if (!path.isAbsolute(directory)) throw fail();
    await privateBackupDirectory(directory);
    const value = privateSchema(await readTerminalJson(path.join(directory, 'retained-root-request.json'), 16 * 1024));
    if (value instanceof type.errors || path.basename(directory) !== value.review.restoreId) throw fail();
    return new RetainedRootTransaction(value.review, value.clientKey);
  }
  async begin(signal: AbortSignal) {
    await requireCandidateResumeCapability(signal);
    const { pointId, restoreId, importId, currentRevision, stageRevision } = this.#review;
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      '/v1/retained-restore/begin',
      { pointId, restoreId, importId, currentRevision, stageRevision, clientKey: this.#clientKey },
      signal,
      512 * 1024,
      200,
      15 * 60_000,
    );
    const result = beginSchema(raw);
    if (
      result instanceof type.errors ||
      result.transactionId !== restoreId ||
      result.token !== this.#clientKey ||
      (result.binding && (result.binding.restoreId !== restoreId || result.binding.pointId !== pointId)) ||
      (!result.binding && result.state !== 'allocating')
    )
      throw fail();
    return { state: result.state, binding: result.binding };
  }
  async revokeAbsent(signal: AbortSignal) {
    const { pointId, restoreId, importId, currentRevision, stageRevision } = this.#review;
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      '/v1/retained-restore/absence',
      { pointId, restoreId, importId, currentRevision, stageRevision, clientKey: this.#clientKey },
      signal,
      32768,
      200,
      15 * 60_000,
    );
    const result = absenceSchema(raw);
    if (
      result instanceof type.errors ||
      result.transactionId !== restoreId ||
      result.pointId !== pointId ||
      result.currentRevision !== currentRevision ||
      result.stageRevision !== stageRevision
    )
      throw fail();
    return { admissionSha256: result.admissionSha256 };
  }
  async status(signal: AbortSignal) {
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/status`,
      { token: this.#clientKey },
      signal,
      512 * 1024,
    );
    const result = statusSchema(raw);
    if (
      result instanceof type.errors ||
      result.transactionId !== this.#review.restoreId ||
      result.pointId !== this.#review.pointId ||
      (result.binding &&
        (result.binding.restoreId !== result.transactionId ||
          result.binding.pointId !== result.pointId ||
          result.admissionSha256 !== result.binding.sourceBinding.admissionSha256))
    )
      throw fail();
    return result;
  }
  async candidateResume(signal: AbortSignal) {
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/candidate-resume`,
      { token: this.#clientKey },
      signal,
      512 * 1024,
    );
    return decodeRetainedCandidateResume(raw, { restoreId: this.#review.restoreId, pointId: this.#review.pointId, now: Date.now() });
  }
  async candidateAppResult(signal: AbortSignal) {
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/candidate-app-result`,
      { token: this.#clientKey },
      signal,
      2 * 1024 * 1024,
    );
    return decodeRetainedCandidateAppResult(raw, { restoreId: this.#review.restoreId, pointId: this.#review.pointId, now: Date.now() });
  }
  async normalBootstrapStatus(terminalProofSha256: string, signal: AbortSignal) {
    if (!hash.allows(terminalProofSha256)) throw fail();
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/normal-bootstrap-status`,
      { token: this.#clientKey, terminalProofSha256 },
      signal,
      32768,
      200,
      60_000,
    );
    const value = normalBootstrapStatusSchema(raw);
    if (
      value instanceof type.errors ||
      value.transactionId !== this.#review.restoreId ||
      value.terminalProofSha256 !== terminalProofSha256 ||
      value.required !== (value.state !== 'not-required') ||
      (value.state === 'not-required' && value.bootstrapLeaseId !== null) ||
      (value.state === 'ready' && value.bootstrapLeaseId === null)
    )
      throw fail();
    return value;
  }
  async normalBootstrap(
    expected: { nonce: string; operationSha256: string; terminalProofSha256: string; binding: typeof retainedRootBindingSchema.infer },
    signal: AbortSignal,
  ) {
    if (!uuid.allows(expected.nonce) || !hash.allows(expected.operationSha256) || !hash.allows(expected.terminalProofSha256)) throw fail();
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/normal-bootstrap`,
      { token: this.#clientKey, terminalProofSha256: expected.terminalProofSha256 },
      signal,
      512 * 1024,
      200,
      60_000,
    );
    return decodeRetainedNormalBootstrap(raw, { ...expected, restoreId: this.#review.restoreId, pointId: this.#review.pointId, now: Date.now() });
  }
  async normalBootstrapComplete(terminalProofSha256: string, bootstrapLeaseId: string, signal: AbortSignal) {
    if (!hash.allows(terminalProofSha256) || !uuid.allows(bootstrapLeaseId)) throw fail();
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/normal-bootstrap-complete`,
      { token: this.#clientKey, terminalProofSha256, bootstrapLeaseId },
      signal,
      32768,
      200,
      60_000,
    );
    const value = normalBootstrapReadySchema(raw);
    if (value instanceof type.errors || value.transactionId !== this.#review.restoreId || value.terminalProofSha256 !== terminalProofSha256)
      throw fail();
    return value;
  }
  async terminalProof(signal: AbortSignal) {
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/terminal-proof`,
      { token: this.#clientKey },
      signal,
      512 * 1024,
    );
    return decodeRetainedTerminalProof(raw, this.#review);
  }
  async terminalFinalize(proofSha256: string, signal: AbortSignal) {
    if (!hash.allows(proofSha256)) throw fail();
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/terminal-finalize`,
      { token: this.#clientKey, proofSha256 },
      signal,
      32768,
    );
    const result = terminalFinalizedSchema(raw);
    if (result instanceof type.errors || result.transactionId !== this.#review.restoreId || result.proofSha256 !== proofSha256) throw fail();
    return result;
  }
  async launch(action: 'prepare' | 'activate' | 'recover', signal: AbortSignal) {
    const raw = await callProtectedRetainedRoot(
      '/run/orbis/host.sock',
      `/v1/retained-restore/${this.#review.restoreId}/${action}`,
      { token: this.#clientKey },
      signal,
      32768,
      202,
    );
    const result = publicSchema(raw);
    if (result instanceof type.errors || result.transactionId !== this.#review.restoreId || result.pointId !== this.#review.pointId) throw fail();
    return result;
  }
}
