import { describe, expect, it, vi } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { NearbyDiscoveryController } from './discovery.controller';
import { NearbyDiscoveryService } from './discovery.service';
import { discoveryBody, discoveryInterface, discoveryLease, discoveryResponse } from './discovery.contracts';
import type { TransferTransport } from '../host-transfer/transfer-transport';

const candidate = {
  id: 'a'.repeat(32),
  origin: 'https://192.168.50.20:8443',
  address: '192.168.50.20',
  port: 8443,
  expiresAt: '2026-01-01T00:00:10Z',
  verified: false,
};
const config = { get: (key: string) => (key === 'userSettings' ? { localDomain: 'source.example', sslPort: 443 } : false) };
describe('nearby discovery bounds and trust', () => {
  it('only exposes bounded, explicitly unverified candidate hints', () => {
    expect(discoveryResponse({ available: true, candidates: [candidate] }, 'scan')).toEqual({ available: true, candidates: [candidate] });
    for (const change of [
      { verified: true },
      { origin: 'http://192.168.50.20:8443' },
      { origin: 'https://8.8.8.8:8443' },
      { address: '8.8.8.8' },
      { port: 1 },
      { id: 'personal-server-name' },
      { origin: 'https://u:p@192.168.50.20:8443' },
    ]) {
      expect(() => discoveryResponse({ available: true, candidates: [{ ...candidate, ...change }] }, 'scan')).toThrow();
    }
    expect(() => discoveryResponse({ available: true, candidates: Array(17).fill(candidate) }, 'scan')).toThrow();
    expect(discoveryResponse({ available: false, reason: 'private helper details' }, 'status')).toEqual({
      available: false,
      reason: 'Nearby discovery is unavailable. Enter the server address manually.',
    });
  });
  it('rejects extra request fields, interface injection and unbounded leases', () => {
    expect(discoveryBody({ interface: 'eth0' }, ['interface'])).toEqual({ interface: 'eth0' });
    for (const body of [null, [], { interface: 'eth0', password: 'fixture-only' }]) expect(() => discoveryBody(body, ['interface'])).toThrow();
    for (const value of ['', 'eth0;command', '../eth0', 'a'.repeat(16)]) expect(() => discoveryInterface(value)).toThrow();
    for (const value of [0, 29, 301, true, '120']) expect(() => discoveryLease(value)).toThrow();
    expect(discoveryLease(120)).toBe(120);
  });
  it('never resolves or contacts a candidate during scans, status or disable; absent helper is ordinary unavailable', async () => {
    const resolve = vi.fn();
    const service = new NearbyDiscoveryService({ resolve } as unknown as TransferTransport, config as never);
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ available: false });
    expect(await service.scan({ interface: 'eth0' })).toMatchObject({ available: false });
    expect(await service.status()).toMatchObject({ available: false });
    expect(await service.disable({})).toMatchObject({ available: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(socket).toHaveBeenCalledWith('scan', { interface: 'eth0' });
  });
  it('only publishes the configured local hostname on one exact matching interface', async () => {
    const resolve = vi.fn().mockResolvedValue({ origin: 'https://source.example', address: '192.168.50.10', family: 4, port: '443' });
    const service = new NearbyDiscoveryService({ resolve } as unknown as TransferTransport, config as never);
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockImplementation(async (action) =>
        action === 'interfaces'
          ? { available: true, interfaces: [{ id: 'eth0', index: 2, address: '192.168.50.10', prefixLength: 24 }] }
          : { available: true, policyVersion: 1, enabled: true, sharing: null },
      );
    await service.reconcile();
    expect(resolve).toHaveBeenCalledWith('https://source.example');
    expect(socket).toHaveBeenCalledWith('configure', {
      interface: 'eth0',
      origin: 'https://source.example',
      address: '192.168.50.10',
    });
    resolve.mockResolvedValue({ origin: 'https://[fd00::1]', address: 'fd00::1', family: 6, port: '443' });
    await service.reconcile();
    expect(socket).toHaveBeenCalledWith('suspend', {});
    expect(() => service.policy({ enabled: true, origin: 'https://other.example' })).toThrow();
  });
  it('old helpers and explicit opt-outs never trigger DNS or advertisements', async () => {
    const resolve = vi.fn();
    const service = new NearbyDiscoveryService({ resolve } as never, config as never);
    const socket = vi.spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request');
    for (const value of [
      { available: true, sharing: null },
      { available: true, policyVersion: 1, enabled: false, sharing: null },
    ]) {
      socket.mockResolvedValue(value);
      await service.reconcile();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(socket.mock.calls.every(([action]) => action === 'status')).toBe(true);
  });
  it('missing, public or ambiguous endpoint configuration suspends without changing policy', async () => {
    for (const localDomain of ['', '8.8.8.8', 'https://source.example', 'source.example/path']) {
      const resolve = vi.fn();
      const service = new NearbyDiscoveryService({ resolve } as never, { get: () => ({ localDomain, sslPort: 443 }) } as never);
      const socket = vi
        .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
        .mockResolvedValue({ available: true, policyVersion: 1, enabled: true, sharing: null });
      await service.reconcile();
      expect(resolve).not.toHaveBeenCalled();
      expect(socket).toHaveBeenCalledWith('suspend', {});
    }
    const resolve = vi.fn().mockResolvedValue({ origin: 'https://source.example', address: '192.168.50.10', family: 4 });
    const service = new NearbyDiscoveryService({ resolve } as never, config as never);
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockImplementation(async (action) =>
        action === 'interfaces'
          ? {
              available: true,
              interfaces: ['eth0', 'eth1'].map((id, index) => ({ id, index: index + 1, address: '192.168.50.10', prefixLength: 24 })),
            }
          : { available: true, policyVersion: 1, enabled: true, sharing: null },
      );
    await service.reconcile();
    expect(socket).toHaveBeenCalledWith('suspend', {});
    expect(socket.mock.calls.some(([action]) => action === 'configure')).toBe(false);
  });
  it('coalesces reconciliation and serializes a persistent opt-out after an in-flight resolution', async () => {
    let release: (value: unknown) => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const lookup = new Promise((done) => {
      release = done;
    });
    const resolve = vi.fn(() => {
      entered();
      return lookup;
    });
    const service = new NearbyDiscoveryService({ resolve } as never, config as never);
    let enabled = true;
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockImplementation(async (action, body) => {
        if (action === 'interfaces') return { available: true, interfaces: [{ id: 'eth0', index: 2, address: '192.168.50.10', prefixLength: 24 }] };
        if (action === 'policy') enabled = (body as { enabled: boolean }).enabled;
        return { available: true, policyVersion: 1, enabled, sharing: null };
      });
    const first = service.reconcile();
    await started;
    expect(service.reconcile()).toBe(first);
    const off = service.policy({ enabled: false });
    expect(() => service.policy({ enabled: true })).toThrow('finish');
    release({ origin: 'https://source.example', address: '192.168.50.10', family: 4 });
    await first;
    await off;
    await service.reconcile();
    expect(enabled).toBe(false);
    expect(socket.mock.calls.filter(([action]) => action === 'configure')).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(socket).toHaveBeenCalledWith('policy', { enabled: false });
  });
  it('held installation roles never request host configuration or resolve names', async () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', '12345678-1234-4123-8123-123456789abc');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    try {
      const resolve = vi.fn();
      const service = new NearbyDiscoveryService({ resolve } as never, config as never);
      const socket = vi.spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request');
      await service.reconcile();
      await service.policy({ enabled: false });
      expect(resolve).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('reconciles on module startup and one bounded timer, then cleans up at shutdown', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ORBIS_HOST_SOCKET', '/fixture-only/host.sock');
    const service = new NearbyDiscoveryService({ resolve: vi.fn() } as never, config as never);
    const reconcile = vi.spyOn(service, 'reconcile').mockResolvedValue({ available: false });
    try {
      service.onModuleInit();
      expect(reconcile).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
  it('guards every discovery route with session authentication and operator access', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, NearbyDiscoveryController)).toEqual([AuthGuard, HostUpdatesGuard]);
    const request = (authMethod: string, operator: boolean, origin = 'https://orbis.test') => ({
      method: 'POST',
      protocol: 'https',
      url: '/api/nearby-discovery/scan',
      headers: { host: 'orbis.test', origin },
      authMethod,
      user: { id: 1, operator },
    });
    const context = (value: object) => ({ switchToHttp: () => ({ getRequest: () => value }) }) as ExecutionContext;
    const operator = new HostUpdatesGuard();
    expect(() => operator.canActivate(context(request('api-key', true)))).toThrow();
    expect(() => operator.canActivate(context(request('session', false)))).toThrow();
    expect(operator.canActivate(context(request('session', true)))).toBe(true);
    const auth = new AuthGuard({ debug: vi.fn() } as never);
    await expect(auth.canActivate(context(request('session', true, 'https://other.test')))).rejects.toThrow('request origin');
    await expect(auth.canActivate(context(request('session', true)))).resolves.toBe(true);
  });
});
