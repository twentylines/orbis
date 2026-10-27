import { CacheService } from '@/core/cache/cache.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock, mockReset } from 'vitest-mock-extended';
import { AuthService } from '../auth.service';
import { TotpAuthenticator } from '../utils/totp-authenticator';
import { SessionManager } from '../session.manager';

describe('AuthService', () => {
  let authService: AuthService;
  let cacheService: MockProxy<CacheService>;
  let userRepository: MockProxy<UserRepository>;
  let passwordService: MockProxy<PasswordService>;
  let encryptionService: MockProxy<EncryptionService>;
  let sessionManager: MockProxy<SessionManager>;

  const totpUser = {
    id: 1,
    username: 'operator@example.com',
    password: 'hashed-password',
    createdAt: 1,
    updatedAt: 1,
    totpEnabled: true,
    totpSecret: 'encrypted-secret',
    salt: 'totp-salt',
    locale: 'en',
    operator: true,
    hasSeenWelcome: true,
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AuthService],
    })
      .useMocker(mock)
      .compile();

    authService = moduleRef.get(AuthService);
    cacheService = moduleRef.get(CacheService);
    userRepository = moduleRef.get(UserRepository);
    passwordService = moduleRef.get(PasswordService);
    encryptionService = moduleRef.get(EncryptionService);
    sessionManager = moduleRef.get(SessionManager);
    mockReset(cacheService);
    mockReset(userRepository);
    mockReset(passwordService);
    mockReset(encryptionService);
    mockReset(sessionManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(authService).toBeDefined();
  });

  it.each(['unknown-account', 'wrong-password', 'invalid-stored-hash'] as const)(
    'returns the same credential failure without creating a session or challenge for %s',
    async (failure) => {
      userRepository.getUserByUsername.mockResolvedValue(failure === 'unknown-account' ? undefined : totpUser);
      passwordService.loginFallbackHash.mockResolvedValue('dummy-encoded-hash');
      passwordService.verify.mockResolvedValue(false);
      if (failure === 'invalid-stored-hash') passwordService.verify.mockRejectedValueOnce(new Error('Malformed stored hash'));
      await expect(authService.login({ username: 'fixture@example.invalid', password: 'wrong-password' })).rejects.toMatchObject({
        response: { message: 'AUTH_ERROR_INVALID_CREDENTIALS', intlParams: {} },
        status: 400,
      });
      expect(passwordService.verify).toHaveBeenCalledWith('wrong-password', failure === 'unknown-account' ? 'dummy-encoded-hash' : totpUser.password);
      if (failure === 'invalid-stored-hash') expect(passwordService.verify).toHaveBeenLastCalledWith('wrong-password', 'dummy-encoded-hash');
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
    },
  );

  it('never grants an unknown account a session even if the fallback verification were to match', async () => {
    userRepository.getUserByUsername.mockResolvedValue(undefined);
    passwordService.loginFallbackHash.mockResolvedValue('dummy-encoded-hash');
    passwordService.verify.mockResolvedValue(true);
    await expect(authService.login({ username: 'fixture@example.invalid', password: 'fixture-password' })).rejects.toMatchObject({
      response: { message: 'AUTH_ERROR_INVALID_CREDENTIALS', intlParams: {} },
      status: 400,
    });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(cacheService.set).not.toHaveBeenCalled();
  });

  it.each(['operator@example.com', 'absent@example.invalid'])(
    'blocks configured-server registration before any identifier lookup for %s',
    async (username) => {
      userRepository.getFirstOperator.mockResolvedValue(totpUser);
      await expect(authService.register({ username, password: 'fixture-password' })).rejects.toMatchObject({
        response: { message: 'AUTH_ERROR_ADMIN_ALREADY_EXISTS', intlParams: {} },
        status: 403,
      });
      expect(userRepository.getUserByUsername).not.toHaveBeenCalled();
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(userRepository.createFirstOperator).not.toHaveBeenCalled();
    },
  );

  it('preserves reserved legacy account login while rejecting the same identifier for new registration or changes', async () => {
    userRepository.getUserByUsername.mockResolvedValue({ ...totpUser, username: 'admin', totpEnabled: false });
    passwordService.verify.mockResolvedValue(true);
    sessionManager.createSession.mockResolvedValue('550e8400-e29b-41d4-a716-446655440010');
    expect(await authService.login({ username: 'admin', password: 'password' })).toEqual({ sessionId: '550e8400-e29b-41d4-a716-446655440010' });
    await expect(authService.register({ username: 'admin', password: 'password' })).rejects.toMatchObject({ message: 'AUTH_ERROR_INVALID_USERNAME' });
    userRepository.getUserById.mockResolvedValue(totpUser);
    await expect(authService.changeUsername({ userId: 1, newUsername: 'ROOT', password: 'password' })).rejects.toMatchObject({
      message: 'AUTH_ERROR_INVALID_USERNAME',
    });
    expect(userRepository.createFirstOperator).not.toHaveBeenCalled();
    expect(userRepository.updateUser).not.toHaveBeenCalled();
  });

  it('creates and changes a normalized bare username using the existing Runtipi account column', async () => {
    userRepository.getUserByUsername.mockResolvedValue(undefined);
    userRepository.createFirstOperator.mockResolvedValue({ ...totpUser, username: 'sai.home' });
    passwordService.hash.mockResolvedValue('hash');
    sessionManager.createSession.mockResolvedValue('550e8400-e29b-41d4-a716-446655440011');
    await authService.register({ username: ' Sai.Home ', password: 'password' });
    expect(userRepository.createFirstOperator).toHaveBeenCalledWith({ username: 'sai.home', password: 'hash' });
    userRepository.getUserById.mockResolvedValue(totpUser);
    passwordService.verify.mockResolvedValue(true);
    await authService.changeUsername({ userId: 1, newUsername: 'Sai-New', password: 'password' });
    expect(userRepository.updateUser).toHaveBeenCalledWith(1, { username: 'sai-new' });
    expect(sessionManager.destroyAllSessionsByUserId).toHaveBeenCalledWith(1);
  });

  it('labels new authenticator enrollments Orbis and keeps an existing encryption salt', async () => {
    userRepository.getUserById.mockResolvedValue({ ...totpUser, totpEnabled: false });
    passwordService.verify.mockResolvedValue(true);
    encryptionService.encrypt.mockReturnValue('new-encrypted-secret');
    vi.spyOn(TotpAuthenticator, 'generateSecret').mockReturnValue('JBSWY3DPEHPK3PXP');

    const result = await authService.getTotpUri({ userId: 1, password: 'fixture-password' });
    const uri = new URL(result.uri);

    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('issuer')).toBe('Orbis');
    expect(decodeURIComponent(uri.pathname)).toBe('/Orbis:operator@example.com');
    expect(encryptionService.encrypt).toHaveBeenCalledWith(result.key, totpUser.salt);
    expect(userRepository.updateUser).toHaveBeenCalledWith(1, { totpSecret: 'new-encrypted-secret', salt: totpUser.salt });
    expect(sessionManager.generateSalt).not.toHaveBeenCalled();
  });

  it('authenticates a retained encrypted TOTP secret without reenrollment', async () => {
    cacheService.get.mockImplementation((key) => (key === 'legacy-totp-session' ? '1' : undefined));
    userRepository.getUserById.mockResolvedValue(totpUser);
    encryptionService.decrypt.mockReturnValue('retained-secret');
    sessionManager.createSession.mockResolvedValue('550e8400-e29b-41d4-a716-446655440000');
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(true);

    await expect(authService.verifyTotp({ totpSessionId: 'legacy-totp-session', totpCode: '123456' })).resolves.toEqual({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(encryptionService.decrypt).toHaveBeenCalledWith(totpUser.totpSecret, totpUser.salt);
    expect(TotpAuthenticator.check).toHaveBeenCalledWith('123456', 'retained-secret');
    expect(userRepository.updateUser).not.toHaveBeenCalled();
    expect(cacheService.del).toHaveBeenCalledWith('legacy-totp-session');
  });

  it('stores TOTP login sessions for five minutes', async () => {
    userRepository.getUserByUsername.mockResolvedValue(totpUser);
    passwordService.verify.mockResolvedValue(true);

    const result = await authService.login({ username: totpUser.username, password: 'password' });

    expect(result.totpSessionId).toEqual(expect.any(String));
    expect(cacheService.set).toHaveBeenCalledWith(expect.any(String), '1', 300);
  });

  it('counts invalid TOTP attempts for the session', async () => {
    cacheService.get.mockImplementation((key: string) => {
      if (key === 'session-id') {
        return '1';
      }

      return undefined;
    });
    userRepository.getUserById.mockResolvedValue(totpUser);
    encryptionService.decrypt.mockReturnValue('decrypted-secret');
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(false);

    await expect(authService.verifyTotp({ totpSessionId: 'session-id', totpCode: '000000' })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_TOTP_INVALID_CODE',
    });

    expect(cacheService.set).toHaveBeenCalledWith('totp-attempts:session-id', '1', 300);
    expect(cacheService.del).not.toHaveBeenCalled();
  });

  it('invalidates the TOTP session after the fifth invalid code', async () => {
    cacheService.get.mockImplementation((key: string) => {
      if (key === 'session-id') {
        return '1';
      }

      if (key === 'totp-attempts:session-id') {
        return '4';
      }

      return undefined;
    });
    userRepository.getUserById.mockResolvedValue(totpUser);
    encryptionService.decrypt.mockReturnValue('decrypted-secret');
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(false);

    await expect(authService.verifyTotp({ totpSessionId: 'session-id', totpCode: '000000' })).rejects.toMatchObject({
      status: 429,
      message: 'AUTH_ERROR_TOTP_TOO_MANY_ATTEMPTS',
    });

    expect(cacheService.del).toHaveBeenCalledWith('totp-attempts:session-id');
    expect(cacheService.del).toHaveBeenCalledWith('session-id');
  });

  it('reports an expired or already used TOTP challenge as a client error', async () => {
    cacheService.get.mockReturnValue(undefined);
    await expect(authService.verifyTotp({ totpSessionId: 'expired-challenge', totpCode: '123456' })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_TOTP_SESSION_NOT_FOUND',
    });
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('rejects a wrong enrollment code without treating it as a server failure', async () => {
    userRepository.getUserById.mockResolvedValue({ ...totpUser, totpEnabled: false });
    encryptionService.decrypt.mockReturnValue('decrypted-secret');
    vi.spyOn(TotpAuthenticator, 'check').mockReturnValue(false);
    await expect(authService.setupTotp({ userId: 1, totpCode: '000000' })).rejects.toMatchObject({
      status: 400,
      message: 'AUTH_ERROR_TOTP_INVALID_CODE',
    });
    expect(userRepository.updateUser).not.toHaveBeenCalled();
  });

  describe('getCookieDomain', () => {
    it('should return undefined if the domain is localhost', async () => {
      const domain = 'localhost';
      const result = await authService.getCookieDomain(domain);
      expect(result).toBeUndefined();
    });

    it('should return undefined if the domain is an IP address', async () => {
      const domain = '192.168.3.20';
      const result = await authService.getCookieDomain(domain);
      expect(result).toBeUndefined();
    });

    it('should return with subdomain', async () => {
      const domain = 'example.duckdns.org';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe(`.${domain}`);
    });

    it('should return input if domain is not using a standard tld', async () => {
      const domain = 'example.whatever';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe(`.${domain}`);
    });

    it('should return all subdomains when using multiple levels of subdomains', async () => {
      const domain = 'sub.sub.duckdns.org';
      const result = await authService.getCookieDomain(domain);

      expect(result).toBe('.sub.sub.duckdns.org');
    });
  });
});
