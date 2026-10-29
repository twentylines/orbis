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
    const service = new NearbyDiscoveryService({ resolve } as unknown as TransferTransport);
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ available: false });
    expect(await service.scan({ interface: 'eth0' })).toMatchObject({ available: false });
    expect(await service.status()).toMatchObject({ available: false });
    expect(await service.disable({})).toMatchObject({ available: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(socket).toHaveBeenCalledWith('scan', { interface: 'eth0' });
  });
  it('only publishes an operator-supplied HTTPS origin after private address resolution, preserving the host pin', async () => {
    const resolve = vi.fn().mockResolvedValue({ origin: 'https://source.example', address: '192.168.50.10', family: 4, port: '443' });
    const service = new NearbyDiscoveryService({ resolve } as unknown as TransferTransport);
    const socket = vi
      .spyOn(service as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ available: false });
    await service.advertise({ interface: 'eth0', origin: 'https://source.example', leaseSeconds: 120 });
    expect(socket).toHaveBeenCalledWith('advertise', {
      interface: 'eth0',
      origin: 'https://source.example',
      address: '192.168.50.10',
      leaseSeconds: 120,
    });
    resolve.mockResolvedValue({ origin: 'https://[fd00::1]', address: 'fd00::1', family: 6, port: '443' });
    await expect(service.advertise({ interface: 'eth0', origin: 'https://[fd00::1]', leaseSeconds: 120 })).rejects.toThrow('IPv4');
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
