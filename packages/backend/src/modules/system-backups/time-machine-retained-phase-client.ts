import http from 'node:http';
import { type } from 'arktype';
import { isPublishedOrbisReleaseTag } from '@runtipi/common/schemas/orbis-release-channel';
import { timeMachineIdSchema as uuid, timeMachineHashSchema as hash } from '@runtipi/common/schemas/time-machine';
import { controllerCaptureSocketIdentity } from '../host-updates/host-controller-config';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { RetainedPhase } from './time-machine-retained-phases';

const digest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const tokenSchema = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const platformPart = type('string').narrow((value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value));
export const retainedPlatformSchema = type({ os: "'linux'", architecture: "'amd64' | 'arm64'", 'variant?': platformPart }).onUndeclaredKey('reject');
export const retainedPublicationSchema = type({
  schema: "'orbis.release.v1'",
  image: "'ghcr.io/twentylines/orbis'",
  tag: type('string').narrow(isPublishedOrbisReleaseTag),
  commit: type('string').narrow((value) => /^[a-f0-9]{40}$/.test(value)),
  digest,
  runtipiCompatibility: "'4.10.1'",
  'installationProtocol?': "'orbis.installation-state.v1'",
}).onUndeclaredKey('reject');
const phaseSchema = type.enumerated('prepare', 'promote', 'verify', 'rollback', 'commit');
const grantSchema = type({
  version: '1',
  transactionId: uuid,
  restoreId: uuid,
  nonce: uuid,
  pointId: uuid,
  phase: phaseSchema,
  sequence: '0 < number.integer <= 9007199254740991',
  rootDecision: "'none' | 'commit' | 'rollback'",
  commitStage: "'authorize' | 'finish' | null",
  workerId: hash,
  originalController: hash,
  candidateController: hash,
  verifierController: hash,
  target: type({
    publication: retainedPublicationSchema,
    creationReference: digest,
    platform: retainedPlatformSchema,
    platformManifestDigest: digest,
    configDigest: digest,
  }).onUndeclaredKey('reject'),
  migrationsPath: 'string',
  candidateHealthy: 'boolean',
}).onUndeclaredKey('reject');
const imagePreflightSchema = type({
  version: '1',
  transactionId: uuid,
  requiredBytes: '0 < number.integer <= 9007199254740991',
  availableBytes: '0 <= number.integer <= 9007199254740991',
  availableInodes: '0 <= number.integer <= 9007199254740991 | null',
}).onUndeclaredKey('reject');
const completeSchema = type({
  version: '1',
  transactionId: uuid,
  phase: phaseSchema,
  sequence: '0 < number.integer <= 9007199254740991',
  status: "'complete'",
}).onUndeclaredKey('reject');
const fail = () => new Error('Protected retained restore authority is unavailable.');
export async function callProtectedRetainedRoot(
  socketPath: string,
  route: string,
  body: object,
  signal: AbortSignal,
  maximumBytes = 32768,
  expectedStatus = 200,
  timeoutMs = 30_000,
  method: 'POST' | 'GET' = 'POST',
  allowNotFound = false,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw fail();
  const identity = await controllerCaptureSocketIdentity(socketPath);
  const bytes = method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  if (bytes.length > 4096) throw fail();
  const raw = await new Promise<Buffer | null>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: route,
        method,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        headers: method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : undefined,
      },
      (response) => {
        if (allowNotFound && response.statusCode === 404) {
          response.resume();
          resolve(null);
          return;
        }
        if (response.statusCode !== expectedStatus) {
          response.resume();
          reject(fail());
          return;
        }
        const pieces: Buffer[] = [];
        let count = 0;
        response.on('data', (chunk: Buffer) => {
          count += chunk.length;
          if (count > maximumBytes) response.destroy(fail());
          else pieces.push(Buffer.from(chunk));
        });
        response.on('error', () => reject(fail()));
        response.on('aborted', () => reject(fail()));
        response.on('end', () => resolve(Buffer.concat(pieces)));
      },
    );
    request.on('error', () => reject(fail()));
    request.end(bytes);
  });
  if ((await controllerCaptureSocketIdentity(socketPath)) !== identity) throw fail();
  if (raw === null) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw fail();
  }
}

// A grant may be redeemed once. Errors never expose the token or a raw host response.
export class RetainedPhaseClient {
  #used = false;
  #grant?: typeof grantSchema.infer;
  readonly #socketPath: string;
  readonly #transactionId: string;
  readonly #token: string;
  constructor(socketPath: string, transactionId: string, token: string) {
    if (!uuid.allows(transactionId) || !tokenSchema.allows(token) || socketPath !== '/run/orbis/host.sock') throw fail();
    this.#socketPath = socketPath;
    this.#transactionId = transactionId;
    this.#token = token;
  }
  toJSON(): never {
    throw fail();
  }
  // The caller must validate the returned status and keep its private binding out of user responses.
  async status(signal: AbortSignal) {
    return callProtectedRetainedRoot(
      this.#socketPath,
      `/v1/retained-restore/${this.#transactionId}/status`,
      { token: this.#token },
      signal,
      512 * 1024,
    );
  }
  async redeem(
    phase: RetainedPhase,
    expected: {
      restoreId: string;
      nonce: string;
      pointId: string;
      workerId: string;
      originalController: string;
      candidateController: string;
      verifierController: string;
      target: unknown;
    },
    signal: AbortSignal,
  ) {
    if (this.#used || !phaseSchema.allows(phase)) throw fail();
    this.#used = true;
    const raw = await callProtectedRetainedRoot(
      this.#socketPath,
      `/v1/retained-restore/${this.#transactionId}/phase`,
      { version: 1, token: this.#token, phase },
      signal,
    );
    const value = grantSchema(raw);
    if (
      value instanceof type.errors ||
      value.transactionId !== this.#transactionId ||
      value.restoreId !== this.#transactionId ||
      value.restoreId !== expected.restoreId ||
      value.nonce !== expected.nonce ||
      value.pointId !== expected.pointId ||
      value.workerId !== expected.workerId ||
      value.originalController !== expected.originalController ||
      value.candidateController !== expected.candidateController ||
      value.verifierController !== expected.verifierController ||
      canonicalPublicationJson(value.target) !== canonicalPublicationJson(expected.target) ||
      value.phase !== phase ||
      value.migrationsPath !== `/data/backups/restores/${value.restoreId}/retained/migrations` ||
      (phase === 'commit'
        ? value.rootDecision !== 'commit' || value.commitStage === null
        : value.commitStage !== null || value.rootDecision !== (phase === 'rollback' ? 'rollback' : 'none')) ||
      value.candidateHealthy !== (phase === 'commit' && value.commitStage === 'finish') ||
      new Set([value.originalController, value.candidateController, value.verifierController, value.workerId]).size !== 4
    )
      throw fail();
    this.#grant = structuredClone(value);
    return structuredClone(value);
  }
  async phaseStatus(signal: AbortSignal) {
    const grant = this.#grant;
    if (!grant) throw fail();
    const raw = await callProtectedRetainedRoot(
      this.#socketPath,
      `/v1/retained-restore/${this.#transactionId}/phase-status`,
      { version: 1, token: this.#token, phase: grant.phase, sequence: grant.sequence },
      signal,
      512 * 1024,
    );
    const { retainedRootBindingSchema } = await import('./time-machine-retained-bootstrap');
    const schema = type({
      version: '1',
      transactionId: uuid,
      pointId: uuid,
      state: "'preparing' | 'promoting' | 'verifying' | 'committing' | 'active' | 'rolling-back'",
      decision: "'commit' | 'rollback' | null",
      recoverable: 'boolean',
      admissionSha256: hash,
      binding: retainedRootBindingSchema,
    }).onUndeclaredKey('reject');
    const value = schema(raw);
    if (value instanceof type.errors) throw fail();
    const expectedState =
      grant.phase === 'prepare'
        ? 'preparing'
        : grant.phase === 'promote'
          ? 'promoting'
          : grant.phase === 'verify'
            ? 'verifying'
            : grant.phase === 'rollback'
              ? 'rolling-back'
              : grant.commitStage === 'authorize'
                ? 'committing'
                : 'active';
    const binding = value.binding;
    if (
      value.admissionSha256 !== binding.sourceBinding.admissionSha256 ||
      value.transactionId !== grant.transactionId ||
      value.pointId !== grant.pointId ||
      value.state !== expectedState ||
      value.decision !== (grant.rootDecision === 'none' ? null : grant.rootDecision) ||
      binding.restoreId !== grant.restoreId ||
      binding.nonce !== grant.nonce ||
      binding.pointId !== grant.pointId ||
      binding.workerId !== grant.workerId ||
      binding.originalController !== grant.originalController ||
      binding.candidateController !== grant.candidateController ||
      binding.verifierController !== grant.verifierController ||
      binding.migrationsPath !== grant.migrationsPath ||
      canonicalPublicationJson(binding.target) !== canonicalPublicationJson(grant.target)
    )
      throw fail();
    return value;
  }
  async imagePreflight(requiredBytes: number, signal: AbortSignal) {
    const grant = this.#grant;
    if (!grant || grant.phase !== 'prepare' || !Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) throw fail();
    const raw = await callProtectedRetainedRoot(
      this.#socketPath,
      `/v1/retained-restore/${this.#transactionId}/image-preflight`,
      { version: 1, token: this.#token, requiredBytes },
      signal,
    );
    const result = imagePreflightSchema(raw);
    if (
      result instanceof type.errors ||
      result.transactionId !== this.#transactionId ||
      result.requiredBytes !== requiredBytes ||
      result.availableBytes < requiredBytes ||
      (result.availableInodes !== null && result.availableInodes < 64)
    )
      throw fail();
  }
  async complete(signal: AbortSignal) {
    const grant = this.#grant;
    this.#grant = undefined;
    if (!grant) throw fail();
    const raw = await callProtectedRetainedRoot(
      this.#socketPath,
      `/v1/retained-restore/${this.#transactionId}/phase-complete`,
      { version: 1, token: this.#token, phase: grant.phase, sequence: grant.sequence },
      signal,
    );
    const value = completeSchema(raw);
    if (
      value instanceof type.errors ||
      value.transactionId !== grant.transactionId ||
      value.phase !== grant.phase ||
      value.sequence !== grant.sequence
    )
      throw fail();
  }
}
