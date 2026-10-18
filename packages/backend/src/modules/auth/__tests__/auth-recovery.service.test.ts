import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthService } from '../auth.service';
import { SessionManager } from '../session.manager';

describe('Local operator recovery', () => {
  const now = 1_800_000_000;
  const operator = {
    id: 41,
    username: 'recovery-fixture@example.test',
    password: 'retained-password-hash',
    createdAt: 1,
    updatedAt: 1,
    totpEnabled: true,
    totpSecret: 'retained-encrypted-secret',
    salt: 'retained-salt',
    locale: 'en',
    operator: true,
    hasSeenWelcome: true,
  };
  let directory: string;
  let requestFile: string;
  let auth: AuthService;
  let users: ReturnType<typeof mock<UserRepository>>;
  let sessions: ReturnType<typeof mock<SessionManager>>;
  let filesystem: ReturnType<typeof mock<FilesystemService>>;
  let passwords: PasswordService;

  beforeEach(async () => {
    directory = await mkdtemp('/tmp/orbis-recovery-test-');
    await mkdir(path.join(directory, 'state'), { mode: 0o700 });
    requestFile = path.join(directory, 'state', 'password-change-request');
    users = mock<UserRepository>();
    users.getFirstOperator.mockResolvedValue({ ...operator });
    sessions = mock<SessionManager>();
    filesystem = mock<FilesystemService>();
    filesystem.readTextFile.mockImplementation((file) => readFile(file, 'utf8').catch(() => null));
    filesystem.removeFile.mockImplementation((file) =>
      unlink(file).then(
        () => true,
        () => false,
      ),
    );
    const config = mock<ConfigurationService>();
    config.get.mockReturnValue(mock<ReturnType<ConfigurationService['getConfig']>['directories']>({ dataDir: directory }));
    passwords = new PasswordService();
    vi.spyOn(passwords, 'hash');
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    auth = new AuthService(users, sessions, config, mock<EncryptionService>(), mock<CacheService>(), filesystem, passwords);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function request(timestamp = String(now)) {
    await writeFile(requestFile, timestamp, { mode: 0o600 });
  }

  function unchanged() {
    expect(users.updateUser).not.toHaveBeenCalled();
    expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
  }

  it.each(['', 'short', '1234567'])('rejects a short reset password without consuming the request (%j)', async (newPassword) => {
    await request();
    await expect(auth.changeOperatorPassword({ newPassword })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_INVALID_PASSWORD_LENGTH',
    });
    expect(await readFile(requestFile, 'utf8')).toBe(String(now));
    unchanged();
  });

  it.each(['', ' ', 'NaN', 'Infinity', '-1', String(now + 1), String(now * 1000), '1800000000.5', '1.8e9', '0x6b49d200'])(
    'does not authorize recovery from a malformed/future timestamp (%j)',
    async (timestamp) => {
      await request(timestamp);
      expect(await auth.checkPasswordChangeRequest()).toBe(false);
      await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toMatchObject({
        status: 400,
        message: 'AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST',
      });
      expect(await readFile(requestFile, 'utf8')).toBe(timestamp);
      unchanged();
    },
  );

  it.each([0, 899])('accepts a decimal CLI timestamp aged %i seconds, including a trailing newline', async (age) => {
    await request(`${now - age}\n`);
    expect(await auth.checkPasswordChangeRequest()).toBe(true);
    unchanged();
  });

  it.each([900, 901])('rejects a reset request aged %i seconds without changing the account', async (age) => {
    await request(String(now - age));
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST',
    });
    unchanged();
  });

  it('does not reset an account without a local request', async () => {
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST',
    });
    unchanged();
  });

  it('hashes an eight-character password, clears TOTP and request once, and revokes the operator sessions', async () => {
    await request();
    await writeFile(path.join(directory, 'state', 'unrelated'), 'keep');
    await expect(auth.changeOperatorPassword({ newPassword: '12345678' })).resolves.toEqual({ email: operator.username });
    expect(users.updateUser).toHaveBeenCalledOnce();
    const saved = users.updateUser.mock.calls.at(0);
    if (!saved) throw new Error('Expected one account update');
    const [id, update] = saved;
    expect(id).toBe(operator.id);
    expect(update).toEqual({ password: expect.any(String), totpEnabled: false, totpSecret: null });
    if (typeof update.password !== 'string') throw new Error('Expected a saved password hash');
    expect(update.password).not.toBe('12345678');
    expect(await passwords.verify('12345678', update.password)).toBe(true);
    expect(await passwords.verify('previous-password', update.password)).toBe(false);
    expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledExactlyOnceWith(operator.id);
    await expect(readFile(requestFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(directory, 'state', 'unrelated'), 'utf8')).toBe('keep');
    await expect(auth.changeOperatorPassword({ newPassword: 'a-different-password' })).rejects.toMatchObject({ status: 400 });
    expect(users.updateUser).toHaveBeenCalledOnce();
    expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledOnce();
  });

  it('retains the request and account if password hashing fails', async () => {
    await request();
    vi.mocked(passwords.hash).mockRejectedValueOnce(new Error('synthetic hash failure'));
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toThrow('synthetic hash failure');
    expect(await readFile(requestFile, 'utf8')).toBe(String(now));
    expect(users.updateUser).not.toHaveBeenCalled();
    expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).resolves.toEqual({ email: operator.username });
  });

  it('retains the request and sessions if saving the new password fails', async () => {
    await request();
    users.updateUser.mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toThrow('synthetic database failure');
    expect(await readFile(requestFile, 'utf8')).toBe(String(now));
    expect(sessions.destroyAllSessionsByUserId).not.toHaveBeenCalled();
  });

  it('revokes sessions and reports incomplete cleanup after the password was changed', async () => {
    await request();
    filesystem.removeFile.mockResolvedValueOnce(false);
    await expect(auth.changeOperatorPassword({ newPassword: 'new-password-123' })).rejects.toMatchObject({
      status: 500,
      message: 'AUTH_ERROR_RESET_REQUEST_CLEANUP',
    });
    expect(users.updateUser).toHaveBeenCalledOnce();
    expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledExactlyOnceWith(operator.id);
    expect(await readFile(requestFile, 'utf8')).toBe(String(now));
  });

  it('rejects a parallel reset instead of changing the password twice', async () => {
    await request();
    const hash = await new PasswordService().hash('new-password-123');
    let began: () => void = () => undefined;
    let release: (hash: string) => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const hashing = new Promise<string>((resolve) => {
      release = resolve;
    });
    vi.mocked(passwords.hash).mockImplementationOnce(() => {
      began();
      return hashing;
    });
    const first = auth.changeOperatorPassword({ newPassword: 'new-password-123' });
    await started;
    try {
      await expect(auth.changeOperatorPassword({ newPassword: 'second-password-456' })).rejects.toMatchObject({
        status: 409,
        message: 'AUTH_ERROR_RESET_IN_PROGRESS',
      });
    } finally {
      release(hash);
      await first;
    }
    expect(passwords.hash).toHaveBeenCalledOnce();
    expect(users.updateUser).toHaveBeenCalledOnce();
    expect(sessions.destroyAllSessionsByUserId).toHaveBeenCalledExactlyOnceWith(operator.id);
  });
});
