import type { NextFunction, Request, Response } from 'express';
import { Injectable, ServiceUnavailableException, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs';

let held = false;
let acquiring = false;
// Production queue consumers must remain closed until backup journals have been checked.
let recoveryRequired = process.env.NODE_ENV === 'production';
let restoreRecoveryRequired = false;
let active = 0;
const drained = new Set<() => void>();
const available = new Set<() => void>();
const requests = new WeakMap<Request, { release: () => void; entered: boolean; disconnected: boolean }>();

export const backupMaintenanceActive = () => held || recoveryRequired || restoreRecoveryRequired;
export const setBackupRecoveryRequired = (required: boolean) => {
  recoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};

export const setRestoreRecoveryRequired = (required: boolean) => {
  restoreRecoveryRequired = required;
  if (!backupMaintenanceActive()) for (const notify of available) notify();
};

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
  if (!pathname.startsWith('/api/') || /^\/api\/(?:health\/?$|system-backups(?:\/|$))/.test(pathname)) return next();
  // Event streams stay open for the browser session and do not mutate snapshot data.
  if (request.method === 'GET' && /^\/api\/sse\/(?:app|app-logs|runtipi-logs)\/?$/.test(pathname)) return next();
  if (
    (recoveryRequired || restoreRecoveryRequired) &&
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
