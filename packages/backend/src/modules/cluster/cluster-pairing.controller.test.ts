import { ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { ClusterPairingController, ClusterPairingExceptionFilter } from './cluster-pairing.controller';
import type { ClusterPairingService } from './cluster-pairing.service';
import { digest } from './cluster-transport';
const pairing = { connect: vi.fn(), complete: vi.fn(), challenge: vi.fn(), authorize: vi.fn() };
let trustedProxyIps: string[] = [];
const config = { get: () => ({ trustedProxyIps }) } as unknown as ConfigurationService;
const controller = new ClusterPairingController(pairing as unknown as ClusterPairingService, config);
const request = (overrides: Partial<Request> = {}) =>
  ({
    method: 'POST',
    url: '/cluster/pairing/connect',
    protocol: 'https',
    secure: true,
    socket: { remoteAddress: '192.168.40.10', encrypted: true },
    ip: '192.168.40.10',
    rawHeaders: [],
    headers: { host: 'local.home.arpa', origin: 'https://local.home.arpa' },
    cookies: { 'runtipi-sid': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    authMethod: 'session',
    user: { id: 1, operator: true },
    ...overrides,
  }) as Request;
const context = (req: Request) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as ExecutionContext;
const authGuard = new AuthGuard({ debug: vi.fn() } as unknown as LoggerService);
beforeEach(() => {
  vi.clearAllMocks();
  trustedProxyIps = [];
});
it.each(['connect', 'complete'] as const)('%s forwards only exact actor and hashed browser session binding', (action) => {
  const req = request();
  controller[action](req, { pendingId: 'fixture' });
  expect(pairing[action]).toHaveBeenCalledWith({ pendingId: 'fixture' }, { userId: 1, session: digest(req.cookies['runtipi-sid']) });
});
it.each(['cli', 'forward-auth', undefined] as const)('refuses %s as a browser pairing actor', (authMethod) => {
  expect(() => controller.connect(request({ authMethod }), {})).toThrow('operator session');
  expect(pairing.connect).not.toHaveBeenCalled();
});
it('does not accept a missing session binding or non-operator account', () => {
  for (const req of [request({ cookies: {} }), request({ user: { id: 1, operator: false } as Request['user'] })])
    expect(() => controller.complete(req, {})).toThrow('operator session');
});
it('existing session operator and Origin guards still refuse cross-site requests', async () => {
  const cross = request({ headers: { host: 'local.home.arpa', origin: 'https://other.example' } });
  await expect(authGuard.canActivate(context(cross))).rejects.toThrow('Invalid request origin');
  expect(() => new HostUpdatesGuard().canActivate(context(request({ authMethod: 'cli' })))).toThrow('operator session');
});
it.each(['challenge', 'authorize'] as const)('%s accepts only HTTPS server-to-server traffic without browser authority', (action) => {
  const good = request({ headers: { host: 'local.home.arpa' }, cookies: {}, authMethod: undefined, user: undefined });
  controller[action](good, { protocol: 'fixture' });
  expect(pairing[action]).toHaveBeenCalledWith({ protocol: 'fixture' });
  for (const req of [
    request({ secure: false }),
    request(),
    request({ headers: { cookie: 'opaque' } }),
    request({ headers: { 'sec-fetch-site': 'cross-site' } }),
  ])
    expect(() => controller[action](req, {})).toThrow('HTTPS');
});
it('refuses an unencrypted local browser hop for remote account credentials', () => {
  expect(() => controller.complete(request({ secure: false }), {})).toThrow('HTTPS');
  expect(pairing.complete).not.toHaveBeenCalled();
});
it('removes account bodies from the request before awaiting service work', () => {
  const body = { password: 'private-test-password', totpCode: '123456', pendingId: 'binding' };
  const req = request({ body });
  controller.complete(req, body);
  expect(req.body).toEqual({});
  expect(body).toEqual({});
  expect(pairing.complete.mock.calls[0]?.[0]).toEqual({ password: 'private-test-password', totpCode: '123456', pendingId: 'binding' });
});

it('unexpected account failures are returned without request bodies or error details', () => {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const host = { switchToHttp: () => ({ getResponse: () => ({ status, json }) }) } as unknown as import('@nestjs/common').ArgumentsHost;
  new ClusterPairingExceptionFilter().catch(new Error('private-test-password'), host);
  expect(status).toHaveBeenCalledWith(503);
  expect(JSON.stringify(json.mock.calls)).not.toContain('private-test-password');
  expect(json.mock.calls[0]?.[0].message).toContain('not confirmed');
});

it('keeps only the explicit public storage guidance on saved-code failure', () => {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const host = { switchToHttp: () => ({ getResponse: () => ({ status, json }) }) } as unknown as import('@nestjs/common').ArgumentsHost;
  new ClusterPairingExceptionFilter().catch(
    new ServiceUnavailableException('The pairing code could not be saved. Check server storage permissions and free space.'),
    host,
  );
  expect(json.mock.calls[0]?.[0].message).toContain('storage permissions');
});

it('actual Express secure getter can be spoofed through globally trusted forwarded protocol', () => {
  const app = new ExpressAdapter().getInstance();
  app.set('trust proxy', true);
  const req = Object.create(app.request) as Request;
  Object.assign(req, {
    app,
    socket: { remoteAddress: '192.168.40.99', encrypted: false },
    headers: { 'x-forwarded-proto': 'https' },
    rawHeaders: ['X-Forwarded-Proto', 'https'],
  });
  expect(req.protocol).toBe('https');
  expect(req.secure).toBe(true);
  expect((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted).toBe(false);
  expect(() => controller.challenge(req, {})).toThrow('trusted proxy setup');
  expect(controller.access(req)).toMatchObject({ available: false });
  expect(pairing.challenge).not.toHaveBeenCalled();
});

it('reports direct private TLS availability and rejects unconfigured or neighboring ingress', () => {
  expect(controller.access(request())).toEqual({ available: true });
  const throughProxy = request({
    socket: { remoteAddress: '192.168.40.2' } as Request['socket'],
    ip: '192.168.40.10',
    rawHeaders: ['X-Forwarded-For', '192.168.40.10', 'X-Forwarded-Proto', 'https'],
    headers: { 'x-forwarded-for': '192.168.40.10', 'x-forwarded-proto': 'https' },
  });
  expect(controller.access(throughProxy)).toMatchObject({ available: false });
  trustedProxyIps = ['192.168.40.2'];
  expect(controller.access(throughProxy)).toEqual({ available: true });
  expect(() => controller.challenge(throughProxy, {})).not.toThrow();
  trustedProxyIps = ['192.168.40.0/24'];
  expect(controller.access(throughProxy)).toMatchObject({ available: false });
});
