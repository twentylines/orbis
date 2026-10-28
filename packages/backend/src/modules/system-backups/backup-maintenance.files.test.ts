import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  acquireBackupMaintenance,
  BackupMaintenanceInterceptor,
  backupMaintenanceActive,
  backupMaintenanceMiddleware,
  enterBackupMutation,
  setBackupRecoveryRequired,
  setRestoreRecoveryRequired,
  waitForBackupMutation,
} from '@/common/backup-maintenance';
import { Subject } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';

afterEach(() => {
  setBackupRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
});
it('retains independent restore and backup recovery holds until both are cleared', async () => {
  setBackupRecoveryRequired(true);
  setRestoreRecoveryRequired(true);
  let admitted = false;
  const waiting = waitForBackupMutation().then((release) => {
    admitted = true;
    return release;
  });
  setBackupRecoveryRequired(false);
  await Promise.resolve();
  expect(backupMaintenanceActive()).toBe(true);
  expect(admitted).toBe(false);
  setRestoreRecoveryRequired(false);
  const release = await waiting;
  expect(admitted).toBe(true);
  release();
});
it('keeps fresh sign-in and progress available during restore recovery while blocking other mutations', () => {
  setRestoreRecoveryRequired(true);
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
  const next = vi.fn();
  for (const [method, originalUrl] of [
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/verify-totp'],
    ['GET', '/api/user'],
    ['GET', '/api/system-backups/restores'],
    ['POST', '/api/apps'],
    ['POST', '/api/auth/change-password'],
  ])
    backupMaintenanceMiddleware({ method, originalUrl } as Request, response as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(4);
  expect(response.status).toHaveBeenCalledTimes(2);
});
it('closes admission, drains existing operations and releases exactly once', async () => {
  const first = enterBackupMutation();
  expect(first).not.toBeNull();
  const waiting = acquireBackupMaintenance(new AbortController().signal);
  const concurrent = enterBackupMutation();
  expect(concurrent).not.toBeNull();
  concurrent?.();
  first?.();
  first?.();
  const release = await waiting;
  expect(backupMaintenanceActive()).toBe(true);
  expect(enterBackupMutation()).toBeNull();
  await expect(acquireBackupMaintenance(new AbortController().signal)).rejects.toThrow('Another full backup');
  release();
  release();
  const next = enterBackupMutation();
  expect(next).not.toBeNull();
  next?.();
});
it('cancels a waiting snapshot without stranding the admission lock', async () => {
  const release = enterBackupMutation();
  const abort = new AbortController();
  const waiting = acquireBackupMaintenance(abort.signal);
  abort.abort();
  await expect(waiting).rejects.toThrow('cancelled');
  release?.();
  expect(backupMaintenanceActive()).toBe(false);
});
it('keeps writes and background operations blocked when app recovery is required', () => {
  setBackupRecoveryRequired(true);
  expect(enterBackupMutation()).toBeNull();
  setBackupRecoveryRequired(false);
  const release = enterBackupMutation();
  expect(release).not.toBeNull();
  release?.();
});
it('retains the recovery and health routes while returning a retryable response for other API requests', async () => {
  const release = await acquireBackupMaintenance(new AbortController().signal);
  try {
    const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
    const next = vi.fn();
    backupMaintenanceMiddleware({ originalUrl: '/api/apps' } as Request, response as unknown as Response, next);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    backupMaintenanceMiddleware({ originalUrl: '/api/system-backups' } as Request, response as unknown as Response, next);
    backupMaintenanceMiddleware({ originalUrl: '/api/health' } as Request, response as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
  } finally {
    release();
  }
});
it('waits for a disconnected handler to finish before taking a snapshot', async () => {
  const request = { originalUrl: '/api/apps', method: 'POST' } as Request;
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
  backupMaintenanceMiddleware(request, response as unknown as Response, () => undefined);
  const handler = new Subject<void>();
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  const subscription = new BackupMaintenanceInterceptor().intercept(context, { handle: () => handler }).subscribe();
  let acquired = false;
  const waiting = acquireBackupMaintenance(new AbortController().signal).then((release) => {
    acquired = true;
    return release;
  });
  response.emit('close');
  await Promise.resolve();
  expect(acquired).toBe(false);
  handler.complete();
  const release = await waiting;
  expect(acquired).toBe(true);
  release();
  subscription.unsubscribe();
});
it('allows sign-in and read-only recovery UI while uncertain app recovery blocks changes', () => {
  setBackupRecoveryRequired(true);
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() });
  const next = vi.fn();
  for (const [method, originalUrl] of [
    ['POST', '/api/auth/login'],
    ['GET', '/api/user'],
    ['POST', '/api/apps'],
  ])
    backupMaintenanceMiddleware({ method, originalUrl } as Request, response as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(response.status).toHaveBeenCalledWith(503);
});
it('refuses controller execution when a request disconnected during authentication', async () => {
  const request = { originalUrl: '/api/apps', method: 'POST' } as Request;
  const response = Object.assign(new EventEmitter(), { setHeader: vi.fn() });
  backupMaintenanceMiddleware(request, response as unknown as Response, () => undefined);
  response.emit('close');
  const release = await acquireBackupMaintenance(new AbortController().signal);
  const handle = vi.fn(() => new Subject<void>());
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  try {
    expect(() => new BackupMaintenanceInterceptor().intercept(context, { handle })).toThrow('disconnected');
    expect(handle).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
