import { expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { authorizeBackupRestoreSession, authorizeBackupActionSession } from './backup-session-authorization';

const actor = { userId: 7, sessionBinding: 'session', securityBinding: 'security' };
const request = {} as Request;
const auth = () => ({ operatorActionContext: vi.fn().mockResolvedValue(actor), verifySensitiveAction: vi.fn().mockResolvedValue(undefined) });
const security = (required = false, revision = 1) => ({
  read: vi.fn().mockResolvedValue({ version: 1, revision, requireCaptureAuthentication: false, requireRestoreAuthentication: required }),
});

it('authorizes only the real owner session by default and rejects changed bindings', async () => {
  const a = auth();
  const s = security();
  const grant = await authorizeBackupRestoreSession(a as never, s as never, request, 7, undefined);
  expect(a.verifySensitiveAction).not.toHaveBeenCalled();
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 8, undefined)).rejects.toThrow();
  a.operatorActionContext.mockResolvedValueOnce({ ...actor, sessionBinding: 'different' });
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 7, undefined, grant)).rejects.toThrow();
  s.read.mockResolvedValueOnce({ version: 1, revision: 2, requireCaptureAuthentication: false, requireRestoreAuthentication: true });
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 7, undefined, grant)).rejects.toThrow();
  await expect(authorizeBackupRestoreSession(a as never, undefined, request, 7, undefined)).rejects.toThrow();
});

it('enforces the opted-in password and checks the session and policy again', async () => {
  const a = auth();
  const s = security(true);
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 7, undefined)).rejects.toThrow();
  await authorizeBackupRestoreSession(a as never, s as never, request, 7, { password: 'proof', totpCode: '123456' });
  expect(a.verifySensitiveAction).toHaveBeenCalledWith(7, 'proof', '123456');
  expect(a.operatorActionContext).toHaveBeenCalledTimes(3);
  a.verifySensitiveAction.mockRejectedValueOnce(new Error('invalid proof'));
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 7, { password: 'bad' })).rejects.toThrow('invalid proof');
});

it('uses the existing backup opt-in independently of the restore opt-in and fails closed on unreadable policy', async () => {
  const a = auth();
  const s = security(true);
  const granted = await authorizeBackupActionSession(a as never, s as never, request, 7, undefined);
  expect(granted.userId).toBe(7);
  expect(a.verifySensitiveAction).not.toHaveBeenCalled();
  s.read.mockResolvedValue({ version: 1, revision: 1, requireCaptureAuthentication: true, requireRestoreAuthentication: true });
  await expect(authorizeBackupActionSession(a as never, s as never, request, 7, undefined)).rejects.toThrow('account password');
  await authorizeBackupActionSession(a as never, s as never, request, 7, { password: 'proof' });
  expect(a.verifySensitiveAction).toHaveBeenCalledWith(7, 'proof', undefined);
  s.read.mockRejectedValueOnce(new Error('unavailable policy'));
  await expect(authorizeBackupActionSession(a as never, s as never, request, 7, undefined)).rejects.toThrow('unavailable policy');
});

it('reuses only the real action-bound proof receipt after rechecking current session and policy', async () => {
  const a = auth();
  const s = security(true);
  s.read.mockResolvedValue({ version: 1, revision: 1, requireCaptureAuthentication: true, requireRestoreAuthentication: true });
  const receipt = await authorizeBackupActionSession(a as never, s as never, request, 7, { password: 'proof' });
  await authorizeBackupActionSession(a as never, s as never, request, 7, undefined, 'backup', receipt);
  expect(a.verifySensitiveAction).toHaveBeenCalledTimes(1);
  await expect(authorizeBackupActionSession(a as never, s as never, request, 7, undefined, 'backup', { ...receipt })).rejects.toThrow(
    'account password',
  );
  await expect(authorizeBackupRestoreSession(a as never, s as never, request, 7, undefined, receipt)).rejects.toThrow('account password');
});
