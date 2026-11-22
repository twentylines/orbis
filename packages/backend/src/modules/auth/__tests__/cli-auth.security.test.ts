import { CacheService } from '@/core/cache/cache.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { afterEach, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthMiddleware } from '../auth.middleware';

const encryption = 'encryption-fixture';
const cli = 'c'.repeat(64);
const user = { id: 1, operator: true };
afterEach(() => vi.unstubAllEnvs());

const setup = () => {
  const config = mock<ConfigurationService>();
  config.get.calledWith('jwtSecret').mockReturnValue(encryption);
  config.get.calledWith('cliSecret').mockReturnValue(cli);
  const users = mock<UserRepository>();
  users.getFirstOperator.mockResolvedValue(user as never);
  const cache = mock<CacheService>();
  return { config, users, cache, middleware: new AuthMiddleware(cache, config, users) };
};

test.each([
  ['separate CLI key', cli, 'HS256', true],
  ['legacy encryption key', encryption, 'HS256', false],
  ['different HMAC algorithm', cli, 'HS512', false],
] as const)('accepts only the actual upstream CLI contract: %s', async (_, key, algorithm, accepted) => {
  const { middleware, users } = setup();
  const token = jwt.sign({ sub: 'cli' }, key, { algorithm, expiresIn: '24h', notBefore: 0 });
  const req = { cookies: {}, headers: { authorization: `Bearer ${token}` } } as Request;
  const next = vi.fn();
  await middleware.use(req, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  expect(req.authMethod).toBe(accepted ? 'cli' : undefined);
  expect(Boolean(req.user)).toBe(accepted);
  expect(users.getFirstOperator).toHaveBeenCalledTimes(accepted ? 1 : 0);
});

test.each(['absent-key', 'absent-operator', 'wrong-subject', 'expired', 'wrong-scheme', 'extra-token', 'installation-hold'])(
  'does not grant CLI authority for %s',
  async (fault) => {
    const { middleware, config, users } = setup();
    if (fault === 'absent-key') config.get.calledWith('cliSecret').mockReturnValue(null);
    if (fault === 'absent-operator') users.getFirstOperator.mockResolvedValue(undefined as never);
    if (fault === 'installation-hold') {
      vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'f92e8862-38b5-4e81-bc84-f9131944872d');
      vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    }
    const token = jwt.sign({ sub: fault === 'wrong-subject' ? 'session' : 'cli' }, cli, { expiresIn: fault === 'expired' ? -1 : '24h' });
    const req = {
      cookies: {},
      headers: { authorization: `${fault === 'wrong-scheme' ? 'Token' : 'Bearer'} ${token}${fault === 'extra-token' ? ' extra' : ''}` },
    } as Request;
    await middleware.use(req, {} as Response, vi.fn());
    expect(req.authMethod).toBeUndefined();
    expect(req.user).toBeUndefined();
  },
);

test('preserves browser-session precedence without reading the CLI key', async () => {
  const { middleware, config, users, cache } = setup();
  cache.get.mockReturnValue('1');
  users.getUserDtoById.mockResolvedValue(user as never);
  const req = { cookies: { [SESSION_COOKIE_NAME]: 'session-fixture' }, headers: { authorization: 'Bearer invalid' } } as unknown as Request;
  await middleware.use(req, {} as Response, vi.fn());
  expect(req.authMethod).toBe('session');
  expect(config.get).not.toHaveBeenCalled();
});
