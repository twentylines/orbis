/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { HostTelemetry } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { statusNetwork, usagePercent } from './system-readings';
const network = (name: string, rx: number, speed: number | null = 1000) => ({
  interface: name,
  state: 'up',
  speedMbps: speed,
  rxBytesPerSecond: rx,
  txBytesPerSecond: 2,
  receivedBytes: 100,
  transmittedBytes: 20,
});
test('shows one explicitly named host interface instead of double-counting virtual bridges', () => {
  const host = {
    available: true,
    stale: false,
    network: [network('docker0', 9000), network('br-apps', 8000), network('eth0', 100)],
  } as HostTelemetry;
  expect(statusNetwork(host, undefined)).toMatchObject({ interface: 'eth0', rxBytesPerSecond: 100, label: 'Network', scope: 'host' });
});
test('does not present stale host counters as current or disguise container rates as host rates', () => {
  const host = { available: true, stale: true, network: [network('eth0', 100)] } as HostTelemetry;
  const core = {
    network: [{ interface: 'eth0', rxBytesPerSecond: 5, txBytesPerSecond: null, receivedBytes: 10, transmittedBytes: 20, scope: 'runtime' }],
  } as Telemetry;
  expect(statusNetwork(host, core)).toMatchObject({ label: 'Orbis core network', rxBytesPerSecond: 5, speedMbps: null, scope: 'runtime' });
  expect(statusNetwork(undefined, undefined)).toBeNull();
});
test('rejects invalid memory and filesystem readings instead of drawing invented percentages', () => {
  expect(usagePercent(12, 48)).toBe(25);
  expect(usagePercent(60, 48)).toBeNull();
  expect(usagePercent(null, 48)).toBeNull();
  expect(usagePercent(0, 0)).toBeNull();
});
