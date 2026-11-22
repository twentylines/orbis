import crypto from 'node:crypto';
import path from 'node:path';
import { TranslatableError } from '@/common/error/translatable-error';
import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { HttpStatus, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import psl from 'psl';
import validator from 'validator';
import type { LoginBody, RegisterBody } from './dto/auth.dto';
import { SessionManager } from './session.manager';
import { TotpAuthenticator } from './utils/totp-authenticator';
import { normalizeNewUsername } from './username';
import { PasskeyStore } from './passkey.store';
import { sensitiveAccountBinding } from './sensitive-action-context';
import { credentialWriters } from '../sentinel-recovery/writer-gate';
import { CredentialSynchronization } from '../sentinel-recovery/credential-synchronization.service';
import { RecoveryChangeError } from '../sentinel-recovery/change-coordinator';
import { OwnershipWriteError } from '../sentinel-recovery/ownership-authority';

const TOTP_SESSION_EXPIRATION = 60 * 5;
const MAX_TOTP_ATTEMPTS = 5;

export type OperatorActionRequest = Pick<Request, 'authMethod' | 'cookies'> & {
  user?: Pick<NonNullable<Request['user']>, 'id' | 'operator'>;
};

@Injectable()
export class AuthService {
  private operatorResetInProgress = false;

  constructor(
    private userRepository: UserRepository,
    private sessionManager: SessionManager,
    private config: ConfigurationService,
    private encryption: EncryptionService,
    private cache: CacheService,
    private filesystem: FilesystemService,
    private passwordService: PasswordService,
    private passkeys: PasskeyStore,
    @Optional() private readonly credentialSync?: CredentialSynchronization,
  ) {}

  private credentialChanges() {
    if (!this.credentialSync)
      throw new ServiceUnavailableException('The credential change could not be verified. Check recovery before trying again.');
    return this.credentialSync;
  }

  private async requireCredentialAccount(accountId: number) {
    // Address lookup preserves the existing missing-account policy; all proof
    // and authority checks are repeated against the coordinator's locked row.
    if (!(await this.userRepository.getUserById(accountId))) throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
  }

  public getCookieDomain(domain?: string) {
    if (!domain || !validator.isFQDN(domain)) {
      return undefined;
    }

    const parsed = psl.parse(domain);
    if (parsed.error) {
      return undefined;
    }

    return `.${parsed.input}`;
  }

  /**
   * Given a username and password, login the user and return the session ID.
   *
   * @param username - The username of the user to login.
   * @param password - The password of the user to login.
   * @returns The session ID.
   */
  public login = credentialWriters.wrap(async (input: LoginBody) => {
    const { username, password } = input;

    const user = await this.userRepository.getUserByUsername(username);

    let isPasswordValid = false;
    try {
      isPasswordValid = await this.passwordService.verify(password, user?.password ?? (await this.passwordService.loginFallbackHash()));
    } catch {
      await this.passwordService.verify(password, await this.passwordService.loginFallbackHash()).catch(() => false);
    }

    if (!user || !isPasswordValid) {
      throw new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS', {}, HttpStatus.BAD_REQUEST);
    }

    return this.beginVerifiedLogin(user);
  });

  public beginVerifiedLogin = credentialWriters.wrap(async (user: NonNullable<Awaited<ReturnType<UserRepository['getUserById']>>>) => {
    if (user.totpEnabled) {
      const totpSessionId = crypto.randomUUID();
      this.cache.set(totpSessionId, user.id.toString(), TOTP_SESSION_EXPIRATION);
      this.cache.set(`totp-by-user:${user.id}:${totpSessionId}`, totpSessionId, TOTP_SESSION_EXPIRATION);
      return { totpSessionId };
    }

    const sessionId = await this.sessionManager.createSession(user.id);

    return {
      sessionId,
    };
  });

  /**
   * Verify TOTP code and return a JWT token
   *
   * @param {object} params - An object containing the TOTP session ID and the TOTP code
   * @param {string} params.totpSessionId - The TOTP session ID
   * @param {string} params.totpCode - The TOTP code
   */
  public verifyTotp = credentialWriters.wrap(async (params: { totpSessionId: string; totpCode: string }) => {
    const { totpSessionId, totpCode } = params;
    const userId = this.cache.get(totpSessionId);
    const attemptKey = `totp-attempts:${totpSessionId}`;

    if (!userId) {
      throw new TranslatableError('AUTH_ERROR_TOTP_SESSION_NOT_FOUND', {}, HttpStatus.BAD_REQUEST);
    }

    const user = await this.userRepository.getUserById(Number(userId));

    if (!user) {
      throw new TranslatableError('AUTH_ERROR_USER_NOT_FOUND');
    }

    if (!user.totpEnabled || !user.totpSecret || !user.salt) {
      throw new TranslatableError('AUTH_ERROR_TOTP_NOT_ENABLED', {}, HttpStatus.BAD_REQUEST);
    }

    const totpSecret = this.encryption.decrypt(user.totpSecret, user.salt);
    const isValid = TotpAuthenticator.check(totpCode, totpSecret);

    if (!isValid) {
      const attempts = Number(this.cache.get(attemptKey) ?? 0) + 1;

      if (attempts >= MAX_TOTP_ATTEMPTS) {
        this.cache.del(attemptKey);
        this.cache.del(totpSessionId);
        this.cache.del(`totp-by-user:${user.id}:${totpSessionId}`);
        throw new TranslatableError('AUTH_ERROR_TOTP_TOO_MANY_ATTEMPTS', {}, HttpStatus.TOO_MANY_REQUESTS);
      }

      this.cache.set(attemptKey, attempts.toString(), TOTP_SESSION_EXPIRATION);
      throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE', {}, HttpStatus.BAD_REQUEST);
    }

    if (this.cache.get(totpSessionId) !== userId) throw new TranslatableError('AUTH_ERROR_TOTP_SESSION_NOT_FOUND', {}, HttpStatus.BAD_REQUEST);
    this.cache.del(`totp-by-user:${user.id}:${totpSessionId}`);
    this.cache.del(attemptKey);
    this.cache.del(totpSessionId);
    const sessionId = await this.sessionManager.createSession(user.id);

    return {
      sessionId,
    };
  });

  /**
   * Creates a new user with the provided email and password and returns a session token
   *
   * @param {LoginBody} input - An object containing the email and password fields
   */
  public register = credentialWriters.wrap(async (input: RegisterBody) => {
    if (await this.userRepository.getFirstOperator()) {
      throw new TranslatableError('AUTH_ERROR_ADMIN_ALREADY_EXISTS', {}, HttpStatus.FORBIDDEN);
    }
    const { password, username } = input;
    const identifier = normalizeNewUsername(username);

    if (!username || !password) {
      throw new TranslatableError('AUTH_ERROR_MISSING_EMAIL_OR_PASSWORD', {}, HttpStatus.BAD_REQUEST);
    }

    if (!identifier) {
      throw new TranslatableError('AUTH_ERROR_INVALID_USERNAME', {}, HttpStatus.BAD_REQUEST);
    }

    const user = await this.userRepository.getUserByUsername(identifier);

    if (user) {
      throw new TranslatableError('AUTH_ERROR_USER_ALREADY_EXISTS', {}, HttpStatus.BAD_REQUEST);
    }

    const hash = await this.passwordService.hash(password);
    const ownership = await this.credentialChanges().beginOwnership('first-registration');
    let newUser: Awaited<ReturnType<UserRepository['createFirstOperator']>>;
    try {
      // register already holds credentialWriters; Root's durable lifecycle hold
      // must still be current immediately before the SQL writer is invoked.
      await ownership.beforeWrite();
      newUser = await this.userRepository.createFirstOperator({ username: identifier, password: hash });
      if (!newUser) throw new Error('First operator creation did not confirm ownership.');
      await ownership.finishCommitted();
    } catch (error) {
      if (ownership.outcome.writes === 'not-started') {
        await ownership.cancelUnwritten().catch(() => false);
      }
      // A rejected SQL call or lost Root reply cannot prove that no account
      // was created. Keep the Root hold and never delete the resulting row.
      throw error instanceof OwnershipWriteError ? error : new OwnershipWriteError(ownership.outcome);
    }

    const sessionId = await this.sessionManager.createSession(newUser.id);

    return {
      sessionId,
    };
  });

  /**
   * Logs out the currently logged in user.
   */
  public logout = async (sessionId: string) => {
    await this.sessionManager.deleteSession(sessionId);
  };

  /**
   * Change the username of the currently logged in user.
   */
  public changeUsername = credentialWriters.wrap(async (params: { password: string; userId: number; newUsername: string }) => {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    const { newUsername, password, userId } = params;
    await this.requireCredentialAccount(userId);
    let identifier: string | null = null;
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        if (!(await this.passwordService.verify(password, user.password))) throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
        identifier = normalizeNewUsername(newUsername);
        if (!identifier) throw new TranslatableError('AUTH_ERROR_INVALID_USERNAME');
        if (await this.userRepository.getUserByUsername(identifier)) throw new TranslatableError('AUTH_ERROR_USER_ALREADY_EXISTS');
      },
      plan: () => {
        if (!identifier) throw new TranslatableError('AUTH_ERROR_INVALID_USERNAME');
        return { patch: { username: identifier }, value: true };
      },
      afterSuccess: async (value: boolean) => {
        await this.sessionManager.destroyAllSessionsByUserId(userId);
        return value;
      },
    });
  });

  public changePassword = credentialWriters.wrap(async (params: { currentPassword: string; newPassword: string; userId: number }) => {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    const { currentPassword, newPassword, userId } = params;
    await this.requireCredentialAccount(userId);
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        if (!(await this.passwordService.verify(currentPassword, user.password))) throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
        if (newPassword.length < 8) throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_LENGTH');
      },
      plan: async () => ({ patch: { password: await this.passwordService.hash(newPassword) }, value: true }),
      afterSuccess: async (value: boolean) => {
        await this.sessionManager.destroyAllSessionsByUserId(userId);
        return value;
      },
    });
  });

  /**
   * Given a userId returns the TOTP URI and the secret key
   *
   * @param {object} params - An object containing the userId and the user's password
   * @param {number} params.userId - The user's ID
   * @param {string} params.password - The user's password
   */
  public getTotpUri = credentialWriters.wrap(async (params: { userId: number; password: string }) => {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    const { userId, password } = params;
    await this.requireCredentialAccount(userId);
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        if (!(await this.passwordService.verify(password, user.password))) throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
        if (user.totpEnabled) throw new TranslatableError('AUTH_ERROR_TOTP_ALREADY_ENABLED');
      },
      plan: (user) => {
        const salt = user.salt || this.sessionManager.generateSalt();
        const secret = TotpAuthenticator.generateSecret();
        return {
          patch: { totpSecret: this.encryption.encrypt(secret, salt), salt },
          value: { uri: TotpAuthenticator.keyuri(user.username, 'Orbis', secret), key: secret },
        };
      },
    });
  });

  public setupTotp = credentialWriters.wrap(async (params: { userId: number; totpCode: string }) => {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    const { userId, totpCode } = params;
    await this.requireCredentialAccount(userId);
    return this.credentialChanges().change({
      accountId: userId,
      authorize: (user) => {
        if (user.totpEnabled || !user.totpSecret || !user.salt) throw new TranslatableError('AUTH_ERROR_TOTP_ALREADY_ENABLED');
        if (!TotpAuthenticator.check(totpCode, this.encryption.decrypt(user.totpSecret, user.salt)))
          throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE', {}, HttpStatus.BAD_REQUEST);
      },
      plan: () => ({ patch: { totpEnabled: true }, value: true }),
    });
  });

  public disableTotp = credentialWriters.wrap(async (params: { userId: number; password: string }) => {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    const { userId, password } = params;
    await this.requireCredentialAccount(userId);
    return this.credentialChanges().change({
      accountId: userId,
      authorize: async (user) => {
        if (!user.totpEnabled) throw new TranslatableError('AUTH_ERROR_TOTP_NOT_ENABLED');
        if (!(await this.passwordService.verify(password, user.password))) throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD');
      },
      plan: (_user, draft) => {
        const keys = draft.users[String(userId)];
        if (keys) delete keys.totpAfterPasskey;
        return { patch: { totpEnabled: false, totpSecret: null }, value: true };
      },
    });
  });

  /**
   * Change the password of the operator user
   *
   * @param {object} params - An object containing the new password
   * @param {string} params.newPassword - The new password
   */
  public changeOperatorPassword = async (params: { newPassword: string }) => {
    if (this.operatorResetInProgress) {
      throw new TranslatableError('AUTH_ERROR_RESET_IN_PROGRESS', {}, HttpStatus.CONFLICT);
    }

    this.operatorResetInProgress = true;
    try {
      return await credentialWriters.run(async () => {
        const isRequested = await this.checkPasswordChangeRequest();

        if (!isRequested) {
          throw new TranslatableError('AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST', {}, HttpStatus.BAD_REQUEST);
        }

        const { newPassword } = params;
        if (newPassword.length < 8) {
          throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD_LENGTH', {}, HttpStatus.BAD_REQUEST);
        }

        const user = await this.userRepository.getFirstOperator();

        if (!user) {
          throw new TranslatableError('AUTH_ERROR_OPERATOR_NOT_FOUND');
        }

        let cleanupError: TranslatableError | undefined;
        try {
          return await this.credentialChanges().change({
            accountId: user.id,
            authorize: async () => {
              if (!(await this.checkPasswordChangeRequest()))
                throw new TranslatableError('AUTH_ERROR_NO_CHANGE_PASSWORD_REQUEST', {}, HttpStatus.BAD_REQUEST);
            },
            plan: async (account, draft) => {
              delete draft.users[String(account.id)];
              return {
                patch: { password: await this.passwordService.hash(newPassword), totpEnabled: false, totpSecret: null },
                value: { email: account.username },
              };
            },
            afterSuccess: async (value: { email: string }) => {
              try {
                await this.sessionManager.destroyAllSessionsByUserId(user.id);
              } catch {
                cleanupError = new TranslatableError('AUTH_ERROR_RESET_SESSION_CLEANUP');
                throw cleanupError;
              }
              const { dataDir } = this.config.get('directories');
              const cleared = await this.filesystem.removeFile(path.join(dataDir, 'state', 'password-change-request'));
              if (!cleared) {
                cleanupError = new TranslatableError('AUTH_ERROR_RESET_REQUEST_CLEANUP');
                throw cleanupError;
              }
              return value;
            },
          });
        } catch (error) {
          if (
            cleanupError &&
            error instanceof RecoveryChangeError &&
            error.outcome.phase === 'after-success' &&
            error.outcome.sql === 'committed' &&
            error.outcome.recovery === 'completed'
          ) {
            // Preserve existing cleanup guidance without losing the internal fact
            // that credentials/Root committed. Nothing here claims a rollback.
            Object.defineProperty(cleanupError, 'recoveryOutcome', { value: error.outcome });
            throw cleanupError;
          }
          throw error;
        }
      });
    } finally {
      this.operatorResetInProgress = false;
    }
  };

  public verifySensitiveAction = async (userId: number, password: string, totpCode?: string) => {
    this.assertSecurityChangeAllowed();
    const user = await this.userRepository.getUserById(userId);
    if (!user || !(await this.passwordService.verify(password, user.password)))
      throw new TranslatableError('AUTH_ERROR_INVALID_PASSWORD', {}, HttpStatus.BAD_REQUEST);
    if (user.totpEnabled) {
      if (!totpCode || !user.totpSecret || !user.salt || !TotpAuthenticator.check(totpCode, this.encryption.decrypt(user.totpSecret, user.salt)))
        throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE', {}, HttpStatus.BAD_REQUEST);
    }
    return user;
  };

  public async operatorActionContext(request: OperatorActionRequest) {
    this.assertSecurityChangeAllowed();
    const session = request.cookies?.[SESSION_COOKIE_NAME];
    if (request.authMethod !== 'session' || request.user?.operator !== true || typeof session !== 'string' || session.length > 256)
      throw new UnauthorizedException('Sign in again before confirming this action.');
    const user = await this.userRepository.getUserById(request.user.id);
    if (!user?.operator || !this.sessionManager.isSessionForUser(session, user.id))
      throw new UnauthorizedException('Sign in again before confirming this action.');
    const state = await this.passkeys.snapshot();
    const current = await this.userRepository.getUserById(user.id);
    this.assertSecurityChangeAllowed();
    if (!current?.operator || !this.sessionManager.isSessionForUser(session, current.id))
      throw new UnauthorizedException('Sign in again before confirming this action.');
    return {
      userId: current.id,
      sessionBinding: crypto.createHash('sha256').update(session).digest('hex'),
      securityBinding: sensitiveAccountBinding(current, state),
    };
  }

  // Called only after an account-bound passkey assertion when that account requires an extra code.
  public async verifyPasskeyActionCode(userId: number, totpCode?: string) {
    this.assertSecurityChangeAllowed();
    const user = await this.userRepository.getUserById(userId);
    if (
      !user?.operator ||
      !user.totpEnabled ||
      !totpCode ||
      !user.totpSecret ||
      !user.salt ||
      !TotpAuthenticator.check(totpCode, this.encryption.decrypt(user.totpSecret, user.salt))
    )
      throw new TranslatableError('AUTH_ERROR_TOTP_INVALID_CODE', {}, HttpStatus.BAD_REQUEST);
    return user;
  }

  public assertSecurityChangeAllowed() {
    if (this.config.get('demoMode')) throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    if (this.operatorResetInProgress) throw new TranslatableError('AUTH_ERROR_RESET_IN_PROGRESS', {}, HttpStatus.CONFLICT);
  }

  /*
   * Check if there is a pending password change request for the given email
   * Returns true if there is a file in the password change requests folder with the given email
   *
   * @returns {boolean} - A boolean indicating if there is a password change request or not
   */
  public checkPasswordChangeRequest = async () => {
    const REQUEST_TIMEOUT_SECS = 15 * 60; // 15 minutes

    const { dataDir } = this.config.get('directories');
    const resetPasswordFilePath = path.join(dataDir, 'state', 'password-change-request');

    try {
      const timestamp = await this.filesystem.readTextFile(resetPasswordFilePath);

      if (!timestamp || !/^\d+$/.test(timestamp.trim())) {
        return false;
      }

      const requestCreation = Number(timestamp);
      const now = Date.now() / 1000;
      return Number.isSafeInteger(requestCreation) && requestCreation > 0 && requestCreation <= now && now - requestCreation < REQUEST_TIMEOUT_SECS;
    } catch {
      return false;
    }
  };

  /*
   * If there is a pending password change request, remove it
   * Returns true if the file is removed successfully
   *
   * @returns {boolean} - A boolean indicating if the file is removed successfully or not
   * @throws {Error} - If the file cannot be removed
   */
  public cancelPasswordChangeRequest = credentialWriters.wrap(async () => {
    const { dataDir } = this.config.get('directories');
    const changeRequestPath = path.join(dataDir, 'state', 'password-change-request');

    await this.filesystem.removeFile(changeRequestPath);

    return true;
  });
}
