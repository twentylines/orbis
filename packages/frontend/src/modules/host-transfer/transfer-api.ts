import { type } from 'arktype';
import type { BackupCredentials } from '../system-backups/backup-api';
import { confirmedSourceCertificate, type SourceCertificate } from './source-certificate';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const uuid = type('string').narrow((value) => uuidPattern.test(value));
const fingerprint = type('string').narrow((value) => fingerprintPattern.test(value));
const count = 'number.integer >= 0 & number <= 9007199254740991' as const;
const offerFields = {
  id: uuid,
  backupId: uuid,
  sourceFingerprint: fingerprint,
  'destinationFingerprint?': fingerprint,
  status: "'awaiting-claim' | 'awaiting-approval' | 'approved' | 'sending' | 'complete' | 'failed' | 'cancelled' | 'expired'",
  expiresAt: 'number > 0',
  bytes: count,
  completedBytes: count,
} as const;
export const transferOfferSchema = type({ ...offerFields, '+': 'reject' });
const offerCodeSchema = type({ ...offerFields, code: fingerprint, '+': 'reject' });
export const transferJobSchema = type({
  '+': 'reject',
  id: uuid,
  importId: uuid,
  sourceOrigin: 'string <= 2048',
  sourceFingerprint: fingerprint,
  destinationFingerprint: fingerprint,
  status: "'awaiting-source-approval' | 'checking-approval' | 'receiving' | 'complete' | 'failed' | 'cancelled' | 'expired'",
  expiresAt: 'number > 0',
  completedBytes: count,
  totalBytes: count,
  message: 'string <= 1024',
  requiresReview: 'true',
});
const snapshotSchema = type({
  '+': 'reject',
  offers: transferOfferSchema.array().atMostLength(16),
  jobs: transferJobSchema.array().atMostLength(16),
});
export type TransferOffer = typeof transferOfferSchema.infer;
export type TransferJob = typeof transferJobSchema.infer;
export type TransferSnapshot = typeof snapshotSchema.infer;
export type TransferCode = typeof offerCodeSchema.infer;

export class TransferApiError extends Error {
  constructor(public readonly status: number) {
    super(
      status === 401
        ? 'Sign in again to continue this transfer.'
        : status === 403
          ? 'This transfer needs an operator session and the source’s managed Orbis HTTPS proxy on your private network.'
          : status === 404
            ? 'This transfer is unavailable or expired. Refresh status, or create a new code on the source.'
            : status === 409
              ? 'Refresh status and check the source approval, fingerprints and active tasks before retrying.'
              : status === 400
                ? 'Check the server address, transfer code, password and authentication code, then try again.'
                : status === 429
                  ? 'Too many attempts. Wait a minute before trying again.'
                  : 'The source could not be reached. Check its private HTTPS hostname, certificate and network, then refresh status.',
    );
  }
}

function parse<T>(schema: (value: unknown) => T | type.errors, value: unknown): T {
  const result = schema(value);
  if (result instanceof type.errors) throw new Error('The transfer response could not be verified. Refresh status before retrying.');
  return result;
}
export function transferEndpoint(path: string) {
  if (path === '') return '/api/system-backups/transfers';
  if (path === '/offers' || path === '/imports') return `/api/system-backups/transfers${path}`;
  const match = /^\/(offers|imports)\/([^/]+)\/(approve|cancel|start)$/.exec(path);
  if (!match?.[2] || !uuidPattern.test(match[2]) || (match[1] === 'offers' ? match[3] === 'start' : match[3] === 'approve'))
    throw new Error('Invalid transfer action.');
  return `/api/system-backups/transfers${path}`;
}
export function sourceOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete private HTTPS source address.');
  }
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use a private HTTPS server address without a path, credentials, query or fragment.');
  return url.origin;
}
async function request(path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal) {
  const response = await fetch(transferEndpoint(path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new TransferApiError(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error('The transfer response could not be read. Refresh status before retrying.');
  }
}
export async function readTransfers(signal?: AbortSignal) {
  return parse(snapshotSchema, await request('', 'GET', undefined, signal));
}
export async function createTransferOffer(backupId: string, credentials: BackupCredentials, signal?: AbortSignal) {
  return parse(offerCodeSchema, await request('/offers', 'POST', { backupId, ...credentials, confirmExport: true }, signal));
}
export async function approveTransferOffer(offer: TransferOffer, credentials: BackupCredentials, signal?: AbortSignal) {
  if (!offer.destinationFingerprint) throw new Error('Wait for a destination to claim the code.');
  return parse(
    transferOfferSchema,
    await request(`/offers/${offer.id}/approve`, 'POST', { ...credentials, destinationFingerprint: offer.destinationFingerprint }, signal),
  );
}
export async function cancelTransferOffer(id: string, signal?: AbortSignal) {
  return parse(transferOfferSchema, await request(`/offers/${id}/cancel`, 'POST', {}, signal));
}
export async function claimTransfer(
  origin: string,
  code: string,
  credentials: BackupCredentials,
  signal?: AbortSignal,
  certificate: SourceCertificate | null = null,
) {
  if (!fingerprintPattern.test(code)) throw new Error('Enter the 64-character transfer code from the source server.');
  return parse(
    transferJobSchema,
    await request(
      '/imports',
      'POST',
      { sourceOrigin: sourceOrigin(origin), code, ...credentials, ...confirmedSourceCertificate(certificate) },
      signal,
    ),
  );
}
export async function startTransfer(job: TransferJob, signal?: AbortSignal) {
  return parse(transferJobSchema, await request(`/imports/${job.id}/start`, 'POST', { sourceFingerprint: job.sourceFingerprint }, signal));
}
export async function cancelTransfer(id: string, signal?: AbortSignal) {
  return parse(transferJobSchema, await request(`/imports/${id}/cancel`, 'POST', {}, signal));
}
export function transferPollingInterval(snapshot: TransferSnapshot | undefined, visible: boolean) {
  if (!visible) return false;
  return snapshot?.offers.some((offer) => ['awaiting-claim', 'awaiting-approval', 'approved', 'sending'].includes(offer.status)) ||
    snapshot?.jobs.some((job) => ['awaiting-source-approval', 'checking-approval', 'receiving'].includes(job.status))
    ? 1500
    : 15_000;
}
