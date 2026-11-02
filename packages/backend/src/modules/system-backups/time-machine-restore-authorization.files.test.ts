import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockReset } from 'vitest-mock-extended';
import { AuthService } from '../auth/auth.service';
import { PasskeyService } from '../auth/passkey.service';
import { TimeMachineRestoreAuthorization } from './time-machine-restore-authorization';
import type { BackupRestoreJournal } from './backup-restore-journal';

const binding = {
  pointId: '11111111-1111-4111-8111-111111111111',
  reviewId: '22222222-2222-4222-8222-222222222222',
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  machineId: 'c'.repeat(64),
} as const;
const actor = { userId: 17, sessionBinding: 'd'.repeat(64), securityBinding: 'e'.repeat(64) };

describe('fresh account proof before restore authorization', () => {
  const auth = mock<AuthService>();
  const passkeys = mock<PasskeyService>();
  let authorization: TimeMachineRestoreAuthorization;
  const request = {} as Request;
  beforeEach(() => {
    mockReset(auth);
    mockReset(passkeys);
    auth.operatorActionContext.mockResolvedValue(actor);
    passkeys.verifySensitive.mockResolvedValue(actor);
    authorization = new TimeMachineRestoreAuthorization(auth, passkeys);
  });
  it('verifies password and configured code before minting a single-use grant', async () => {
    const grant = await authorization.password(request, binding, { password: 'fresh proof', totpCode: '123456' });
    expect(auth.verifySensitiveAction).toHaveBeenCalledWith(17, 'fresh proof', '123456');
    expect(JSON.stringify(grant)).not.toContain('fresh proof');
    expect(JSON.stringify(grant)).not.toContain(actor.sessionBinding);
    await expect(authorization.consume(request, binding, grant.grantId)).resolves.toBeUndefined();
    await expect(authorization.consume(request, binding, grant.grantId)).rejects.toThrow();
  });
  it('issues nothing after a rejected password or account change during proof', async () => {
    auth.verifySensitiveAction.mockRejectedValueOnce(new Error('credential rejection'));
    await expect(authorization.password(request, binding, { password: 'wrong' })).rejects.toThrow('credential rejection');
    auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, securityBinding: 'f'.repeat(64) });
    await expect(authorization.password(request, binding, { password: 'fresh proof' })).rejects.toThrow('Verify this exact restore');
  });
  it('authorizes at most one concurrent activation after asynchronous session checks', async () => {
    const grant = await authorization.password(request, binding, { password: 'fresh proof' });
    const results = await Promise.allSettled([
      authorization.consume(request, binding, grant.grantId),
      authorization.consume(request, binding, grant.grantId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('binds the standalone passkey ceremony to a domain-separated action digest', async () => {
    passkeys.sensitiveOptions.mockResolvedValue({ challengeId: binding.pointId, options: {} as never, expiresAt: 100, requiresTotp: false });
    const options = await authorization.passkeyOptions(request, binding);
    expect(options).toMatchObject({ method: 'passkey', reviewId: binding.reviewId, requiresTotp: false });
    const digest = passkeys.sensitiveOptions.mock.calls[0]?.[1];
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const grant = await authorization.passkey(request, binding, { challengeId: binding.pointId, response: {} });
    expect(passkeys.verifySensitive).toHaveBeenCalledWith(request, digest, { challengeId: binding.pointId, response: {} });
    expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
    await expect(authorization.consume(request, binding, grant.grantId)).resolves.toBeUndefined();
  });
  it('rejects passkey proof if the account security state changes before issuance', async () => {
    auth.operatorActionContext.mockResolvedValue({ ...actor, securityBinding: 'f'.repeat(64) });
    await expect(authorization.passkey(request, binding, { response: {} })).rejects.toThrow('Verify this exact restore');
  });
  it('rereads the actual session and policy at consumption and refuses a different review', async () => {
    const grant = await authorization.password(request, binding, { password: 'fresh proof' });
    auth.operatorActionContext.mockResolvedValueOnce({ ...actor, sessionBinding: 'f'.repeat(64) });
    await expect(authorization.consume(request, binding, grant.grantId)).rejects.toThrow();
    await expect(authorization.consume(request, binding, grant.grantId)).rejects.toThrow();
    const other = await authorization.password(request, binding, { password: 'fresh proof' });
    await expect(authorization.consume(request, { ...binding, reviewId: '33333333-3333-4333-8333-333333333333' }, other.grantId)).rejects.toThrow();
  });
  it('does not invoke cryptographic proof for malformed bindings or credential fields', async () => {
    await expect(authorization.password(request, { ...binding, machineId: 'not a machine' }, { password: 'fresh proof' })).rejects.toThrow();
    await expect(authorization.password(request, binding, { password: 'fresh proof', arbitrary: true })).rejects.toThrow();
    expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
    expect(passkeys.verifySensitive).not.toHaveBeenCalled();
  });
  it('refuses admission without a fresh grant before reading or creating any journal receipt', async () => {
    const journal = {} as BackupRestoreJournal;
    await expect(authorization.admit(request, binding, binding.pointId, binding.reviewId, journal)).rejects.toThrow('Verify this exact restore');
    const grant = await authorization.password(request, binding, { password: 'fresh proof' });
    await authorization.consume(request, binding, grant.grantId);
    await expect(authorization.admit(request, binding, grant.grantId, binding.reviewId, journal)).rejects.toThrow('Verify this exact restore');
  });
});
