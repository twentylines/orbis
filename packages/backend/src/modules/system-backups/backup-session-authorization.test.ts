import { expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { authorizeBackupRestoreSession } from './backup-session-authorization';

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
