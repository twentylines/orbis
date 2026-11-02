import path from 'node:path';
import fs from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { DATA_DIR } from './constants';
import { readRootCoreState, readRootRestorationState, type RootRestorationState } from './restoration-root-status';
import { BackupRestoreJournal } from '@/modules/system-backups/backup-restore-journal';
import { ResetState } from '@/modules/system-reset/reset-state';

export type RestorationStatus =
  | { state: 'idle' | 'checking' }
  | { state: 'restoring'; stage: 'preparing' | 'restoring' }
  | { state: 'recovery'; stage: 'recovering' };

async function readJournalStatus(store: string, root: RootRestorationState | null): Promise<RestorationStatus> {
  try {
    const journal = await BackupRestoreJournal.active(store);
    if (!journal) return { state: 'idle' };
    if (['completed', 'rolled-back', 'discarded'].includes(journal.state.phase)) {
      for (const name of ['retained-binding.json', 'retained-root-request.json']) {
        try {
          await fs.lstat(path.join(journal.directory, name));
          return root === 'idle' ? { state: 'idle' } : { state: 'checking' };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { state: 'checking' };
        }
      }
      return { state: 'idle' };
    }
    if (journal.state.phase === 'rolling-back') return { state: 'recovery', stage: 'recovering' };
    return {
      state: 'restoring',
      stage: ['staging', 'preparing', 'prepared'].includes(journal.state.phase) ? 'preparing' : 'restoring',
    };
  } catch {
    return { state: 'checking' };
  }
}

let rootPreviouslyActive = false;
export async function readRestorationStatus(
  store = path.join(DATA_DIR, 'backups', 'restores'),
  readRoot = readRootRestorationState,
): Promise<RestorationStatus> {
  const root = await readRoot();
  if (root && root !== 'idle') rootPreviouslyActive = true;
  if (root === 'idle') rootPreviouslyActive = false;
  const journal = await readJournalStatus(store, root);
  if (root === 'checking' || (!root && rootPreviouslyActive)) return { state: 'checking' };
  if (root === 'recovery') return { state: 'recovery', stage: 'recovering' };
  if (root === 'restoring' && journal.state === 'idle') return { state: 'restoring', stage: 'restoring' };
  return journal;
}

export type OperationStatus =
  | RestorationStatus
  | { state: 'updating' | 'downgrading' }
  | { state: 'resetting'; stage: 'preparing' | 'resetting' | 'recovering' };
let corePreviouslyActive = false;
export async function readOperationStatus(
  readRestore = readRestorationStatus,
  readCore = readRootCoreState,
  readReset = () => new ResetState(DATA_DIR).active(),
): Promise<OperationStatus> {
  const [restore, core] = await Promise.all([readRestore(), readCore()]);
  if (core && core !== 'idle') corePreviouslyActive = true;
  if (core === 'idle') corePreviouslyActive = false;
  if (restore.state !== 'idle') return restore;
  if (core === 'checking' || (!core && corePreviouslyActive)) return { state: 'checking' };
  if (core === 'recovery') return { state: 'recovery', stage: 'recovering' };
  if (core === 'updating' || core === 'downgrading') return { state: core };
  try {
    const reset = await readReset();
    if (reset && reset.phase !== 'complete')
      return { state: 'resetting', stage: reset.phase === 'recovery' ? 'recovering' : reset.phase === 'prepared' ? 'preparing' : 'resetting' };
  } catch {
    return { state: 'checking' };
  }
  return { state: 'idle' };
}

export function createRestorationMiddleware(readStatus = readOperationStatus) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const pathname = request.originalUrl.split('?')[0] ?? '';
    const statusRoute = /^\/api\/system\/(?:restoration-status|operation-status)\/?$/.test(pathname);
    if (statusRoute && ['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Cache-Control', 'no-store');
      return response.json(await readStatus());
    }
    if (!pathname.startsWith('/api/')) return next();
    if (/^\/api\/(?:health\/?$|installation\/status\/?$)/.test(pathname)) return next();
    if (request.method === 'GET' && /^\/api\/auth\/passkeys\/availability\/?$/.test(pathname)) return next();
    if (request.method === 'POST' && /^\/api\/auth\/(?:login|logout|verify-totp|passkeys\/login\/(?:options|verify))\/?$/.test(pathname))
      return next();
    if (request.method === 'GET' && /^\/api\/(?:system-backups\/restores|host-updates\/status|system\/build|user-context)\/?$/.test(pathname))
      return next();
    if (request.method === 'POST' && /^\/api\/host-updates\/recover\/?$/.test(pathname)) return next();
    if (request.method === 'POST' && /^\/api\/system-reset\/(?:recover|passkey-options)\/?$/.test(pathname)) return next();
    if (request.method === 'POST' && /^\/api\/system-backups\/time-machine\/points\/[a-f0-9-]+\/recover\/?$/.test(pathname)) return next();
    if (request.method === 'POST' && /^\/api\/system-backups\/restores\/[a-f0-9-]+\/(?:recover|cancel)\/?$/.test(pathname)) return next();
    const status = await readStatus();
    if (status.state === 'idle') return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', '2');
    return response.status(503).json({ statusCode: 503, code: 'ORBIS_RESTORATION_IN_PROGRESS', message: 'Restoration is in progress.' });
  };
}

export const restorationMiddleware = createRestorationMiddleware();
