import { type } from 'arktype';
import type { BackupCredentials } from '../system-backups/backup-api';
import { confirmedSourceCertificate, type SourceCertificate } from './source-certificate';
import { sourceOrigin } from './transfer-api';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const id = type('string').narrow((value) => idPattern.test(value));
const fingerprint = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const count = 'number.integer >= 0 & number <= 9007199254740991' as const;
const size = type(count).or('null');
const encryption = "'source-account-password' | 'separate-passphrase'" as const;
const exportProgress = { '+': 'reject', stage: 'string <= 64', completedBytes: count, totalBytes: size } as const;
export const incomingRestoreSchema = type({
  '+': 'reject',
  version: '1',
  id,
  nonce: id,
  sourceFingerprint: fingerprint,
  destinationFingerprint: fingerprint,
  status: "'awaiting-approval' | 'approving' | 'exporting' | 'ready' | 'sending' | 'complete' | 'rejected' | 'cancelled' | 'expired' | 'failed'",
  expiresAt: 'number > 0',
  totalBytes: size,
  completedBytes: count,
  'encryption?': encryption,
  'exportProgress?': exportProgress,
}).narrow(
  (value) =>
    !['ready', 'sending', 'complete'].includes(value.status) ||
    (value.totalBytes !== null && value.totalBytes >= 52 && value.totalBytes <= 1024 ** 4 && value.encryption !== undefined),
);
export const outgoingRestoreSchema = type({
  '+': 'reject',
  version: '1',
  id,
  importId: id,
  sourceOrigin: 'string <= 2048',
  sourceFingerprint: fingerprint,
  destinationFingerprint: fingerprint,
  status:
    "'awaiting-source-approval' | 'checking-approval' | 'source-exporting' | 'receiving' | 'complete' | 'rejected' | 'cancelled' | 'expired' | 'failed'",
  expiresAt: 'number > 0',
  totalBytes: size,
  completedBytes: count,
  message: 'string <= 1024',
  requiresReview: 'true',
  canStart: 'boolean',
  'encryption?': encryption,
  'exportProgress?': exportProgress,
}).narrow(
  (value) =>
    (!value.canStart || value.status === 'awaiting-source-approval') &&
    (!['receiving', 'complete'].includes(value.status) ||
      (value.totalBytes !== null && value.totalBytes >= 52 && value.totalBytes <= 1024 ** 4 && value.encryption !== undefined)) &&
    (value.status !== 'complete' || (value.completedBytes === value.totalBytes && !value.canStart)),
);
export const restoreRequestsSchema = type({
  '+': 'reject',
  version: '1',
  incoming: incomingRestoreSchema.array().atMostLength(16),
  outgoing: outgoingRestoreSchema.array().atMostLength(16),
});
export type IncomingRestoreRequest = typeof incomingRestoreSchema.infer;
export type OutgoingRestoreRequest = typeof outgoingRestoreSchema.infer;
export type RestoreRequests = typeof restoreRequestsSchema.infer;
export type RestoreEncryption = NonNullable<IncomingRestoreRequest['encryption']>;
export const restoreRequestStopped = new Set(['complete', 'rejected', 'cancelled', 'expired', 'failed']);

export class RestoreRequestScope {
  private generation = 0;
  begin() {
    return this.generation;
  }
  invalidate() {
    this.generation++;
  }
  current(generation: number) {
    return generation === this.generation;
  }
}
export function restoreRequestEndpoint(path = '') {
  if (path === '') return '/api/system-backups/transfers/requests';
  const match = /^\/(incoming|outgoing)\/([^/]+)\/(approve|reject|start|cancel)$/.exec(path);
  if (!match?.[2] || !idPattern.test(match[2]) || (match[1] === 'incoming' ? match[3] === 'start' : !['start', 'cancel'].includes(match[3] ?? '')))
    throw new Error('Invalid restore request action.');
  return `/api/system-backups/transfers/requests${path}`;
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The restore request response was empty. Refresh status.');
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      count += result.value.byteLength;
      if (count > maximum) throw new Error('The restore request response was too large. Refresh status.');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export class RestoreRequestApiError extends Error {
  constructor(
    public readonly status: number,
    reason?: unknown,
  ) {
    const message = reason && typeof reason === 'object' && 'message' in reason ? reason.message : undefined;
    super(
      message === 'AUTH_ERROR_INVALID_PASSWORD'
        ? 'The account password was not accepted. Enter it again.'
        : message === 'AUTH_ERROR_TOTP_INVALID_CODE'
          ? 'The authentication code was not accepted. Enter a current code.'
          : status === 401
            ? 'Sign in again to continue this restore request.'
            : status === 403
              ? 'This action requires an operator session and a verified private HTTPS source.'
              : status === 404
                ? 'This restore request is unavailable or expired. Start a new request.'
                : status === 409
                  ? 'Check active transfers, backup recovery and source approval, then refresh status.'
                  : status === 429
                    ? 'Too many attempts. Wait a minute before trying again.'
                    : status === 400
                      ? 'Check the source address, password, authentication code and certificate confirmation.'
                      : 'The source could not be reached. Check its private HTTPS address, certificate trust and Orbis version.',
    );
  }
}
function parse<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
  const result = schema(value);
  if (result instanceof type.errors) throw new Error('The restore request response could not be verified. Refresh status.');
  return result;
}
async function request(path: string, body?: object, signal?: AbortSignal) {
  const response = await fetch(restoreRequestEndpoint(path), {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (response.redirected) throw new Error('Restore request redirects are not allowed.');
  if (!response.ok) {
    let reason: unknown;
    try {
      reason = await boundedJson(response, 8192);
    } catch {
      /* Fixed guidance covers proxy and malformed error bodies. */
    }
    throw new RestoreRequestApiError(response.status, reason);
  }
  try {
    return await boundedJson(response, 128 * 1024);
  } catch {
    throw new Error('The restore request response could not be read. Refresh status.');
  }
}
export async function readRestoreRequests(signal?: AbortSignal) {
  return parse(restoreRequestsSchema, await request('', undefined, signal));
}
export async function createRestoreRequest(
  origin: string,
  credentials: BackupCredentials,
  certificate: SourceCertificate | null,
  signal?: AbortSignal,
) {
  return parse(
    outgoingRestoreSchema,
    await request(
      '',
      { sourceOrigin: sourceOrigin(origin), confirmRequest: true, ...credentials, ...confirmedSourceCertificate(certificate) },
      signal,
    ),
  );
}
export async function approveRestoreRequest(
  value: IncomingRestoreRequest,
  credentials: BackupCredentials,
  encryption: RestoreEncryption,
  passphrase: string | undefined,
  signal?: AbortSignal,
) {
  if (encryption === 'source-account-password' && passphrase !== undefined) throw new Error('Choose one backup encryption method.');
  return parse(
    incomingRestoreSchema,
    await request(
      `/incoming/${value.id}/approve`,
      {
        ...credentials,
        destinationFingerprint: value.destinationFingerprint,
        encryption,
        ...(encryption === 'separate-passphrase' ? { passphrase } : {}),
      },
      signal,
    ),
  );
}
export async function rejectRestoreRequest(id: string, credentials: BackupCredentials, signal?: AbortSignal) {
  return parse(incomingRestoreSchema, await request(`/incoming/${id}/reject`, credentials, signal));
}
export async function cancelSourceRestoreRequest(id: string, signal?: AbortSignal) {
  return parse(incomingRestoreSchema, await request(`/incoming/${id}/cancel`, {}, signal));
}
export async function startRestoreRequest(value: OutgoingRestoreRequest, signal?: AbortSignal) {
  return parse(
    outgoingRestoreSchema,
    await request(`/outgoing/${value.id}/start`, { sourceFingerprint: value.sourceFingerprint, confirmReceive: true }, signal),
  );
}
export async function cancelRestoreRequest(id: string, signal?: AbortSignal) {
  return parse(outgoingRestoreSchema, await request(`/outgoing/${id}/cancel`, {}, signal));
}

export function restoreExportStage(stage: string | undefined) {
  const labels: Record<string, string> = {
    preparing: 'Preparing backup',
    inventory: 'Checking files',
    quiescing: 'Pausing apps',
    database: 'Copying database',
    copying: 'Copying app data',
    archiving: 'Creating archive',
    encrypting: 'Encrypting archive',
    resuming: 'Resuming apps',
    complete: 'Backup ready',
  };
  return labels[stage ?? ''] ?? 'Creating encrypted backup';
}
