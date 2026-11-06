import type { NextFunction, Request, Response } from 'express';
import { Injectable, ServiceUnavailableException, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs';
import {
  useVerifiedCoreCompletion,
  type VerifiedCoreCompletion,
  type CoreCaptureCompletionDetails,
} from '../modules/host-updates/host-core-capture-completion-client';
import { canonicalPublicationJson } from '../modules/host-updates/host-controller-publication';
import {
  useVerifiedCoreAbortComplete,
  type VerifiedCoreAbortComplete,
  type CoreCaptureAbortDetails,
} from '../modules/host-updates/host-core-capture-abort-client';
import {
  useVerifiedCoreEmptyAbortComplete,
  type VerifiedCoreEmptyAbortComplete,
  type CoreCaptureEmptyAbortDetails,
} from '../modules/host-updates/host-core-capture-empty-abort-client';

let held = false;
let acquiring = false;
// Production queue consumers must remain closed until backup journals have been checked.
let recoveryRequired = process.env.NODE_ENV === 'production';
let restoreRecoveryRequired = false;
let resetRecoveryRequired = process.env.NODE_ENV === 'production';
let settingsRestoreRecoveryRequired = false;
let captureRecoveryRequired = false;
let captureInitializing = false;
let initializedCaptureApproval: CoreCaptureCompletionDetails | undefined;
export const coreCaptureRecoveryRequired = () => captureRecoveryRequired;
export const backupMaintenanceLeaseHeld = () => held;
export const holdCoreCaptureRecovery = () => {
  captureRecoveryRequired = true;
};
let active = 0;
const drained = new Set<() => void>();
const available = new Set<() => void>();
const requests = new WeakMap<Request, { release: () => void; entered: boolean; disconnected: boolean }>();

export const backupMaintenanceActive = () =>
  held ||
  recoveryRequired ||
  restoreRecoveryRequired ||
  resetRecoveryRequired ||
  settingsRestoreRecoveryRequired ||
  captureRecoveryRequired ||
  captureInitializing;
export const backupMaintenanceOutsideResetActive = () =>
  held ||
  acquiring ||
  recoveryRequired ||
  restoreRecoveryRequired ||
  settingsRestoreRecoveryRequired ||
  captureRecoveryRequired ||
  captureInitializing;
export const setSettingsRestoreRecoveryRequired = (required: boolean) => {
  settingsRestoreRecoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};
export const setResetRecoveryRequired = (required: boolean) => {
  resetRecoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};
export const setBackupRecoveryRequired = (required: boolean) => {
  recoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};

export const setRestoreRecoveryRequired = (required: boolean) => {
  restoreRecoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};

const captureApprovalIdentity = (details: CoreCaptureCompletionDetails) =>
  canonicalPublicationJson({
    id: details.id,
    sourceSha256: details.sourceSha256,
    sourceHoldSha256: details.sourceHoldSha256,
    completionSha256: details.completionSha256,
    pointReservationSha256: details.pointReservationSha256,
    controller: details.controller,
  });

export async function initializeCoreCaptureRecovery<T>(
  token: VerifiedCoreCompletion,
  work: (details: CoreCaptureCompletionDetails) => Promise<T>,
): Promise<T> {
  try {
    return await useVerifiedCoreCompletion(token, async (details) => {
      if (!captureRecoveryRequired || !held || active !== 0 || captureInitializing) throw new Error('Core capture initialization is not available.');
      captureInitializing = true;
      captureRecoveryRequired = false;
      initializedCaptureApproval = details;
      return work(details);
    });
  } catch (error) {
    // An authenticated callback may have started mutating even when the socket post-check failed.
    if (captureInitializing) captureRecoveryRequired = true;
    throw error;
  }
}

export async function settleCoreCaptureRecovery(token: VerifiedCoreCompletion, continuationSha256?: string, signal?: AbortSignal): Promise<void> {
  const verify = (details: CoreCaptureCompletionDetails) => {
    signal?.throwIfAborted();
    if (
      details.state !== 'complete' ||
      (continuationSha256 !== undefined && details.continuationSha256 !== continuationSha256) ||
      !initializedCaptureApproval ||
      captureApprovalIdentity(details) !== captureApprovalIdentity(initializedCaptureApproval) ||
      !held ||
      !captureInitializing ||
      captureRecoveryRequired ||
      active !== 0 ||
      recoveryRequired ||
      restoreRecoveryRequired ||
      resetRecoveryRequired ||
      settingsRestoreRecoveryRequired
    )
      throw new Error('Core capture continuation is not available.');
  };
  let completed: CoreCaptureCompletionDetails | undefined;
  await useVerifiedCoreCompletion(token, async (details) => {
    verify(details);
    completed = details;
  });
  if (!completed) throw new Error('Core capture continuation is not available.');
  verify(completed);
  // Clear only after the authenticated callback and its socket post-check both succeeded.
  captureInitializing = false;
  initializedCaptureApproval = undefined;
}

export async function settleCoreCaptureAbortRecovery(
  token: VerifiedCoreAbortComplete,
  verifySource: (details: CoreCaptureAbortDetails) => Promise<void>,
): Promise<void> {
  const check = () => {
    if (
      !held ||
      active !== 0 ||
      !captureRecoveryRequired ||
      captureInitializing ||
      initializedCaptureApproval ||
      recoveryRequired ||
      restoreRecoveryRequired ||
      resetRecoveryRequired ||
      settingsRestoreRecoveryRequired
    )
      throw new Error('Core capture cancellation is not ready to settle.');
  };
  check();
  await useVerifiedCoreAbortComplete(token, async (details) => {
    check();
    if (details.state !== 'complete' || !details.continuationSha256) throw new Error('Core capture cancellation is not committed.');
    await verifySource(details);
    check();
  });
  check();
  // The source still owns the mutation lease until its caller releases it synchronously.
  captureRecoveryRequired = false;
}

export async function settleCoreCaptureEmptyAbortRecovery(
  token: VerifiedCoreEmptyAbortComplete,
  verifySource: (details: CoreCaptureEmptyAbortDetails) => Promise<void>,
) {
  const check = () => {
    if (
      !held ||
      active !== 0 ||
      !captureRecoveryRequired ||
      captureInitializing ||
      initializedCaptureApproval ||
      recoveryRequired ||
      restoreRecoveryRequired ||
      resetRecoveryRequired ||
      settingsRestoreRecoveryRequired
    )
      throw new Error('Early capture cancellation is not ready to settle.');
  };
  check();
  await useVerifiedCoreEmptyAbortComplete(token, async (details) => {
    check();
    if (details.version !== 2 || details.state !== 'complete' || details.sourceMarker !== 'absent' || !details.continuationSha256)
      throw new Error('Early capture cancellation is not committed.');
    await verifySource(details);
    check();
  });
  check();
  captureRecoveryRequired = false;
}

export async function waitForBackupMutation() {
  let release = enterBackupMutation();
  while (!release) {
    await new Promise<void>((resolve) => {
      const notify = () => {
        available.delete(notify);
        resolve();
      };
      available.add(notify);
    });
    release = enterBackupMutation();
  }
  return release;
}

export function enterBackupMutation(): (() => void) | null {
  if (backupMaintenanceActive()) return null;
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    if (!active) for (const notify of drained) notify();
  };
}

export async function acquireBackupMaintenance(signal: AbortSignal): Promise<() => void> {
  if (held || acquiring) throw new Error('Another full backup is in progress.');
  acquiring = true;
  const deadline = Date.now() + 30_000;
  try {
    signal.throwIfAborted();
    while (active) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener('abort', cancelled);
          drained.delete(finished);
        };
        const finished = () => {
          cleanup();
          resolve();
        };
        const cancelled = () => {
          cleanup();
          reject(new Error('Backup cancelled.'));
        };
        const timeout = setTimeout(
          () => {
            cleanup();
            reject(new Error('Wait for current operations to finish, then retry the backup.'));
          },
          Math.max(0, deadline - Date.now()),
        );
        drained.add(finished);
        signal.addEventListener('abort', cancelled, { once: true });
      });
    }
    signal.throwIfAborted();
    held = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        held = false;
        if (!backupMaintenanceActive()) for (const notify of available) notify();
      }
    };
  } finally {
    acquiring = false;
  }
}

export function backupMaintenanceMiddleware(request: Request, response: Response, next: NextFunction) {
  const pathname = request.originalUrl.split('?')[0] ?? '';
  if (pathname.startsWith('/api/system-backups')) response.setHeader('Cache-Control', 'no-store');
  if (!pathname.startsWith('/api/') || /^\/api\/health\/?$/.test(pathname)) return next();
  if (captureRecoveryRequired || captureInitializing) {
    if (request.method === 'POST' && /^\/api\/auth\/(?:login|logout|verify-totp|passkeys\/login\/(?:options|verify))\/?$/.test(pathname))
      return next();
    if (request.method === 'GET' && /^\/api\/auth\/passkeys\/availability\/?$/.test(pathname)) return next();
    const recovery =
      /^\/api\/system-backups\/time-machine\/recovery\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(\/continue)?\/?$/.exec(
        pathname,
      );
    if (recovery && ((request.method === 'GET' && !recovery[1]) || (request.method === 'POST' && !!recovery[1] && !captureInitializing)))
      return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', '2');
    return response.status(503).json({ statusCode: 503, code: 'ORBIS_CAPTURE_RECOVERY_REQUIRED', message: 'Capture recovery requires review.' });
  }
  if (/^\/api\/system-backups(?:\/|$)/.test(pathname)) return next();
  // Reset acquires and retains the same drain itself; counting its admission request would deadlock it.
  if (request.method === 'POST' && /^\/api\/system-reset(?:\/(?:recover|passkey-options))?\/?$/.test(pathname)) return next();
  // A held restore must still admit fresh operator authentication for protected recovery.
  if (
    (restoreRecoveryRequired || settingsRestoreRecoveryRequired) &&
    request.method === 'POST' &&
    /^\/api\/auth\/(?:login|verify-totp|passkeys\/login\/(?:options|verify))\/?$/.test(pathname)
  )
    return next();
  // Event streams stay open for the browser session and do not mutate snapshot data.
  if (request.method === 'GET' && /^\/api\/sse\/(?:app|app-logs|runtipi-logs)\/?$/.test(pathname)) return next();
  if (
    (recoveryRequired || restoreRecoveryRequired || resetRecoveryRequired || settingsRestoreRecoveryRequired) &&
    !held &&
    (['GET', 'HEAD'].includes(request.method) || /^\/api\/auth\/(?:login|logout|verify-totp|passkeys\/login\/(?:options|verify))\/?$/.test(pathname))
  )
    return next();
  const release = enterBackupMutation();
  if (!release) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', '2');
    return response
      .status(503)
      .json({ statusCode: 503, code: 'ORBIS_BACKUP_IN_PROGRESS', message: 'A full backup is taking a consistent snapshot. Try again shortly.' });
  }
  const state = { release, entered: false, disconnected: false };
  requests.set(request, state);
  const beforeController = () => {
    if (!state.entered) release();
  };
  response.once('finish', beforeController);
  response.once('close', () => {
    state.disconnected = true;
    beforeController();
  });
  next();
}

@Injectable()
export class BackupMaintenanceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const state = requests.get(context.switchToHttp().getRequest<Request>());
    if (!state) return next.handle();
    if (state.disconnected) throw new ServiceUnavailableException('The request disconnected before it could be processed.');
    state.entered = true;
    try {
      return next.handle().pipe(finalize(state.release));
    } catch (error) {
      state.release();
      throw error;
    }
  }
}
