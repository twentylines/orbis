import { LoggerService } from '@/core/logger/logger.service';
import { PasswordService } from '@/core/password/password.service';
import { UserRepository } from '@/modules/user/user.repository';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ArkValidationPipe } from 'nestjs-arktype';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { CacheService } from '@/core/cache/cache.service';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { PasskeyService } from '../passkey.service';
import { SessionManager } from '../session.manager';

const knownUser = {
  id: 31,
  username: 'known@example.invalid',
  password: '',
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_000,
  totpEnabled: true,
  totpSecret: 'opaque-encrypted-fixture',
  salt: 'opaque-salt-fixture',
  locale: 'en',
  operator: true,
  hasSeenWelcome: true,
};

it('returns indistinguishable HTTP failures for unknown and wrong-password accounts after real password verification', async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      AuthService,
      PasswordService,
      { provide: PasskeyService, useValue: mock<PasskeyService>() },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
      { provide: CacheService, useValue: mock<CacheService>() },
    ],
  })
    .useMocker(mock)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(new ArkValidationPipe());

  const passwordService = moduleRef.get(PasswordService);
  const userRepository = moduleRef.get(UserRepository) as MockProxy<UserRepository>;
  const sessionManager = moduleRef.get(SessionManager) as MockProxy<SessionManager>;
  const cache = moduleRef.get(CacheService) as MockProxy<CacheService>;
  const knownHash = await passwordService.hash('correct-fixture-password');
  knownUser.password = knownHash;
  userRepository.getUserByUsername.mockImplementation(async (username: string) => (username === knownUser.username ? knownUser : undefined));
  const verify = vi.spyOn(passwordService, 'verify');

  await app.listen(0, '127.0.0.1');
  try {
    const fallbackHash = await passwordService.loginFallbackHash();
    expect(fallbackHash).not.toBe(knownHash);

    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'unknown@example.invalid', password: 'wrong-fixture-password' });
    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: knownUser.username, password: 'wrong-fixture-password' });
    const unknownAgain = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: 'unknown-again@example.invalid', password: 'wrong-fixture-password' });

    expect(unknown.status).toBe(400);
    expect(wrongPassword.status).toBe(unknown.status);
    expect(unknown.body).toEqual(wrongPassword.body);
    expect(unknown.headers['content-type']).toBe(wrongPassword.headers['content-type']);
    for (const response of [unknown, wrongPassword, unknownAgain]) {
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers.location).toBeUndefined();
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body).not.toHaveProperty('success');
      expect(response.body).not.toHaveProperty('sessionId');
      expect(response.body).not.toHaveProperty('totpSessionId');
      expect(response.body.message).toBe('AUTH_ERROR_INVALID_CREDENTIALS');
    }
    expect(unknownAgain.body).toEqual(unknown.body);

    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify.mock.calls[0]).toEqual(['wrong-fixture-password', fallbackHash]);
    expect(verify.mock.calls[1]).toEqual(['wrong-fixture-password', knownHash]);
    expect(verify.mock.calls[2]).toEqual(['wrong-fixture-password', fallbackHash]);
    expect(await passwordService.loginFallbackHash()).toBe(fallbackHash);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
