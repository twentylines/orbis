import { type } from 'arktype';
import {
  timeMachineIdSchema,
  timeMachineHashSchema,
  timeMachineIssueSchema,
  timeMachinePreferencesSchema,
  timeMachinePreferencesUpdateSchema,
  timeMachineCaptureSchema,
  type TimeMachinePoint,
} from '@runtipi/common/schemas/time-machine';
import {
  timeMachineRestoreReviewResponseSchema,
  timeMachineRestoreIssueSchema,
  timeMachineRestoreGrantSchema,
  timeMachineRestorePasskeyOptionsSchema,
  timeMachineRestoreActivateSchema,
  type TimeMachineRestoreReview,
  type TimeMachineRestoreGrant,
  type TimeMachineRestorePasskeyOptions,
} from '@runtipi/common/schemas/time-machine-restore';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { eligibleRestoreReview, grantMatchesReview, reviewMatchesPoint, verifiedRestoreReview } from './timeline-state';
import { restoreStatusSchema } from '@/modules/system-backups/contracts';
import { safeBackupErrorMessage, type BackupCredentials } from '@/modules/system-backups/backup-api';
import {
  capabilitiesSchema,
  captureActivitySchema,
  historicalAssetPath,
  listSchema,
  parseTimeMachine,
  pointSchema,
  type TimeMachineSnapshot,
} from './contracts';

const root = '/api/system-backups/time-machine';
const responseLimit = 9 * 1024 * 1024;
const consumedRestoreGrants = new WeakSet<TimeMachineRestoreGrant>();
const removeResponseSchema = type({ removed: 'true' }).onUndeclaredKey('reject');
export class TimeMachineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
    safeMessage?: string,
  ) {
    super(
      safeMessage ??
        (status === 401
          ? 'Sign in again to open Time Machine.'
          : status === 403
            ? 'An operator account and valid authentication are required.'
            : status === 404
              ? 'Time Machine is unavailable on this server.'
              : status === 429
                ? 'Too many attempts. Wait a minute before retrying.'
                : status === 409
                  ? ((code ? issueMessages[code] : undefined) ?? 'Time Machine could not safely continue. Check its status before retrying.')
                  : code
                    ? (issueMessages[code] ?? 'Time Machine could not safely continue. Refresh its status before retrying.')
                    : 'Time Machine could not be reached. Check the connection and refresh.'),
    );
  }
}
const issueMessages: Record<string, string> = {
  'operation-busy': 'Wait for the current operation to finish.',
  'capacity-exceeded': 'Saved points have reached the storage limit. Review and remove a point before capturing another.',
  'capture-recovery-required': 'An interrupted capture needs recovery in Backup & recovery.',
  'point-integrity-failed': 'This point could not be verified. No restore was started.',
  'point-not-found': 'This point is no longer available. Refresh the timeline.',
  'storage-unavailable': 'Time Machine storage needs attention. No new action was started.',
  'revision-conflict': 'These settings changed in another session. Refresh before saving.',
  'app-exclusions-unsupported': 'App exclusions are not supported by this server.',
  'automatic-capture-unsupported': 'Automatic capture is not supported by this server.',
  'experimental-acknowledgement-required': 'Read and acknowledge the experimental capture warning.',
  'review-required': 'Verify this point before authorizing restoration.',
  'review-expired': 'Point verification expired. Verify this point again.',
  'authorization-required': 'Fresh authorization is required for this point.',
  'authorization-expired': 'Authorization expired. Verify and authorize this point again.',
  'authorization-invalid': 'Authorization no longer matches this point or session. Check status and authorize again.',
  'passkey-unavailable': 'A passkey cannot authorize this request. Use the current account password.',
  'image-state-unavailable': 'The captured image state could not be verified. No restore was started.',
  'controller-version-unsupported': 'This server cannot safely restore the captured controller version.',
  'source-version-incompatible': 'This point is not compatible with the current server.',
  'restore-preparation-failed': 'Restore preparation could not finish. Check its verified recovery status.',
  'restore-recovery-required': 'This server needs restore recovery before another operation.',
  'activation-not-integrated': 'Restoring a Time Machine point is not available on this server.',
  'host-capture-support-required':
    'Update and verify the Orbis host service with controller configuration capture support before creating this restore point.',
  'proxy-layout-migration-required':
    'The proxy storage layout needs migration before a capture can begin. Existing server data and HTTPS identity were preserved.',
};
export async function boundedBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('The Time Machine response exceeded its limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The Time Machine response was empty.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('The Time Machine response exceeded its limit.');
      chunks.push(next.value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } catch (failure) {
    await reader.cancel().catch(() => undefined);
    throw failure;
  } finally {
    reader.releaseLock();
  }
}
async function request(path: string, method: 'GET' | 'POST' | 'PUT', body: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(`${root}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    let code: string | undefined;
    let safeMessage: string | undefined;
    if (response.status === 400 || response.status === 409) {
      try {
        const text = new TextDecoder().decode(await boundedBody(response, 16 * 1024));
        safeMessage = safeBackupErrorMessage(response.status, text);
        const value: unknown = JSON.parse(text);
        if (timeMachineIssueSchema.allows(value) || timeMachineRestoreIssueSchema.allows(value)) code = value.code;
        else if (value && typeof value === 'object' && 'message' in value) {
          if (value.message === issueMessages['host-capture-support-required']) code = 'host-capture-support-required';
          if (
            value.message ===
            'The proxy needs an explicit storage layout migration before coherent capture. Existing HTTPS identity and server data were preserved.'
          )
            code = 'proxy-layout-migration-required';
        }
      } catch {
        /* Use the bounded generic rejection. */
      }
    }
    throw new TimeMachineApiError(response.status, code, safeMessage);
  }
  try {
    return JSON.parse(new TextDecoder().decode(await boundedBody(response, responseLimit))) as unknown;
  } catch (failure) {
    if (signal.aborted) throw failure;
    throw new Error('The Time Machine response could not be verified. Refresh before retrying.');
  }
}
function pointPath(id: string) {
  if (!timeMachineIdSchema.allows(id)) throw new Error('Choose a valid Time Machine point.');
  return `/points/${id}`;
}
export async function readTimeMachineActivity(signal: AbortSignal) {
  return parseTimeMachine(captureActivitySchema, await request('/activity', 'GET', undefined, signal));
}
export async function readTimeMachinePreferences(signal: AbortSignal) {
  return parseTimeMachine(timeMachinePreferencesSchema, await request('/preferences', 'GET', undefined, signal));
}
export async function readTimeMachinePoints(signal: AbortSignal) {
  return parseTimeMachine(listSchema, await request('/points', 'GET', undefined, signal));
}
export async function readTimeMachine(signal: AbortSignal): Promise<TimeMachineSnapshot> {
  const [capabilities, preferences, list] = await Promise.all([
    request('/capabilities', 'GET', undefined, signal),
    readTimeMachinePreferences(signal),
    readTimeMachinePoints(signal),
  ]);
  return {
    capabilities: parseTimeMachine(capabilitiesSchema, capabilities),
    preferences,
    list,
  };
}
export async function captureTimeMachine(label: string, credentials: Partial<BackupCredentials>, signal: AbortSignal) {
  const body = { label };
  if (!timeMachineCaptureSchema.allows(body)) throw new Error('Review the capture name before continuing.');
  return parseTimeMachine(pointSchema, await request('/captures', 'POST', { ...body, ...credentials }, signal));
}
export async function readOnboardingCapture(attemptId: string, signal: AbortSignal) {
  if (!timeMachineIdSchema.allows(attemptId)) throw new Error('The setup capture receipt could not be verified.');
  const point = parseTimeMachine(pointSchema, await request(`/onboarding-captures/${attemptId}`, 'GET', undefined, signal));
  if (point.id !== attemptId) throw new Error('The server returned a different setup capture. No new capture was started.');
  return point;
}
export async function startOnboardingCapture(attemptId: string, signal: AbortSignal) {
  if (!timeMachineIdSchema.allows(attemptId)) throw new Error('The setup capture receipt could not be verified.');
  const point = parseTimeMachine(pointSchema, await request('/onboarding-captures', 'POST', { label: 'After setup', attemptId }, signal));
  if (point.id !== attemptId) throw new Error('The server returned a different setup capture. Check its status before retrying.');
  return point;
}
export async function saveTimeMachinePreferences(body: unknown, signal: AbortSignal) {
  if (!timeMachinePreferencesUpdateSchema.allows(body)) throw new Error('Review the Time Machine settings before saving.');
  return parseTimeMachine(timeMachinePreferencesSchema, await request('/preferences', 'PUT', body, signal));
}
export async function removeTimeMachinePoint(id: string, credentials: Partial<BackupCredentials>, signal: AbortSignal) {
  parseTimeMachine(removeResponseSchema, await request(`${pointPath(id)}/remove`, 'POST', credentials, signal));
}
export async function reviewTimeMachinePoint(
  point: TimeMachinePoint,
  signal: AbortSignal,
  readOnly = false,
): Promise<TimeMachineRestoreReview | null> {
  const response = parseTimeMachine(
    timeMachineRestoreReviewResponseSchema,
    await request(`${pointPath(point.id)}/restore-review`, readOnly ? 'GET' : 'POST', readOnly ? undefined : {}, signal),
  );
  if (response.review && !reviewMatchesPoint(response.review, point)) throw new Error('The reviewed point changed. No restore was started.');
  return response.review;
}

function requireVerifiedReview(point: TimeMachinePoint, review: TimeMachineRestoreReview) {
  if (!verifiedRestoreReview(review, point, Date.now()) && !eligibleRestoreReview(review, point, Date.now()))
    throw new Error('Verify this exact point again before authorizing restoration.');
}
function verifiedGrant(value: unknown, point: TimeMachinePoint, review: TimeMachineRestoreReview) {
  const grant = parseTimeMachine(timeMachineRestoreGrantSchema, value);
  if (!grantMatchesReview(grant, review, point, Date.now()))
    throw new Error('Authorization expired or no longer matches this point. Verify and authorize it again.');
  return grant;
}
export async function authorizeTimeMachineWithPassword(
  point: TimeMachinePoint,
  review: TimeMachineRestoreReview,
  credentials: BackupCredentials,
  signal: AbortSignal,
) {
  requireVerifiedReview(point, review);
  if (!credentials.password || credentials.password.length > 1024 || (credentials.totpCode !== undefined && !/^\d{6}$/.test(credentials.totpCode)))
    throw new Error('Enter this server’s current account password and authentication code if enabled.');
  return verifiedGrant(
    await request(
      `${pointPath(point.id)}/restore-auth/verify`,
      'POST',
      {
        reviewId: review.reviewId,
        method: 'password',
        password: credentials.password,
        ...(credentials.totpCode ? { totpCode: credentials.totpCode } : {}),
      },
      signal,
    ),
    point,
    review,
  );
}
export async function timeMachinePasskeyOptions(point: TimeMachinePoint, review: TimeMachineRestoreReview, signal: AbortSignal) {
  requireVerifiedReview(point, review);
  const options = parseTimeMachine(
    timeMachineRestorePasskeyOptionsSchema,
    await request(`${pointPath(point.id)}/restore-auth/options`, 'POST', { reviewId: review.reviewId, method: 'passkey' }, signal),
  );
  if (options.reviewId !== review.reviewId || options.expiresAt <= Date.now())
    throw new Error('The passkey request expired. Verify this point and try again.');
  return options;
}
export async function authorizeTimeMachineWithPasskey(
  point: TimeMachinePoint,
  review: TimeMachineRestoreReview,
  options: TimeMachineRestorePasskeyOptions,
  response: AuthenticationResponseJSON,
  totpCode: string | undefined,
  signal: AbortSignal,
) {
  requireVerifiedReview(point, review);
  if (!timeMachineRestorePasskeyOptionsSchema.allows(options) || options.reviewId !== review.reviewId || options.expiresAt <= Date.now())
    throw new Error('The passkey request expired. Verify this point and try again.');
  if ((options.requiresTotp && !totpCode) || (totpCode !== undefined && !/^\d{6}$/.test(totpCode)))
    throw new Error('Enter the current six-digit authentication code.');
  return verifiedGrant(
    await request(
      `${pointPath(point.id)}/restore-auth/verify`,
      'POST',
      { reviewId: review.reviewId, method: 'passkey', challengeId: options.challengeId, response, ...(totpCode ? { totpCode } : {}) },
      signal,
    ),
    point,
    review,
  );
}
export async function activateTimeMachinePoint(
  point: TimeMachinePoint,
  review: TimeMachineRestoreReview,
  grant: TimeMachineRestoreGrant,
  signal: AbortSignal,
) {
  requireVerifiedReview(point, review);
  if (!grantMatchesReview(grant, review, point, Date.now())) throw new Error('Authorization expired or changed. Authorize this point again.');
  const body = { reviewId: review.reviewId, grantId: grant.grantId, manifestSha256: review.manifestSha256, confirmation: 'replace-server' as const };
  if (!timeMachineRestoreActivateSchema.allows(body)) throw new Error('Restore authorization could not be verified.');
  if (consumedRestoreGrants.has(grant)) throw new Error('This authorization was already used. Check status and authorize a new attempt.');
  consumedRestoreGrants.add(grant);
  const accepted = parseTimeMachine(restoreStatusSchema, await request(`${pointPath(point.id)}/activate`, 'POST', body, signal));
  if (!accepted.job) throw new Error('The server did not confirm a restore job. Check restore status before retrying.');
  return accepted.job;
}

export async function readHistoricalWallpaper(point: TimeMachinePoint, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const path = historicalAssetPath(point);
  const preview = point.metadata?.preview;
  if (!path || !preview?.available || !preview.wallpaperAsset.available || !timeMachineHashSchema.allows(preview.wallpaperAsset.identity))
    throw new Error('No historical wallpaper was captured.');
  const asset = preview.wallpaperAsset;
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new TimeMachineApiError(response.status);
  if (response.headers.get('Content-Type')?.split(';')[0] !== asset.mime) throw new Error('The historical wallpaper type changed.');
  const bytes = await boundedBody(response, asset.bytes);
  if (bytes.length !== asset.bytes) throw new Error('The historical wallpaper was incomplete.');
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    const identity = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (identity !== asset.identity) throw new Error('The captured wallpaper could not be verified.');
  }
  signal.throwIfAborted();
  return new Blob([bytes.buffer], { type: asset.mime });
}
