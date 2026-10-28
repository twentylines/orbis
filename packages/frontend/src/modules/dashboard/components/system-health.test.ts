/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { HostSensors, HostTemperature } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { advanceSystemHealth, highTemperature, highUsage, temperatureLimit, type SystemHealth } from './system-health';
import { sensorOptions } from './use-system-health';

const epoch = Date.parse('2026-01-01T00:00:00Z');
const telemetry = (seconds: number, cpu = 95, memory = 95, scope: Telemetry['cpu']['scope'] = 'host-proc'): Telemetry => ({
  sampledAt: new Date(epoch + seconds * 1000).toISOString(),
  cpu: { scope, totalPercent: cpu, perCorePercent: [], uptimeSeconds: 10 },
  memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 100 - memory, swapTotalBytes: null, swapFreeBytes: null },
  filesystems: [],
  network: [],
});
const sensor = (celsius = 90, criticalCelsius: number | null = 88): HostTemperature => ({
  id: 'package',
  chip: 'coretemp',
  label: 'Package id 0',
  status: 'available',
  celsius,
  criticalCelsius,
});
const sensors = (seconds: number, reading = sensor()): HostSensors => ({
  available: true,
  sampledAt: new Date(epoch + seconds * 1000).toISOString(),
  stale: false,
  limited: false,
  unreadable: 0,
  temperatures: [reading],
  fans: [],
  gpus: [],
  omitted: { temperatures: 0, fans: 0, gpus: 0 },
  unavailable: [],
});
const step = (state: SystemHealth, seconds: number, cpu = 95, memory = 95) =>
  advanceSystemHealth(state, { telemetry: telemetry(seconds, cpu, memory) }, epoch + seconds * 1000);
const run = (from: number, through: number, state: SystemHealth = {}, cpu = 95, memory = 95) => {
  let result = state;
  for (let seconds = from; seconds <= through; seconds++) result = step(result, seconds, cpu, memory);
  return result;
};

test('colours only valid high readings, preferring host temperature limits and documented fallbacks', () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 89.99]) expect(highUsage(value)).toBe(false);
  expect(highUsage(90)).toBe(true);
  expect(temperatureLimit(sensor(90, 100))).toBe(100);
  expect(highTemperature(sensor(90, 100))).toBe(false);
  expect(highTemperature(sensor(90, null))).toBe(true);
  expect(temperatureLimit({ ...sensor(), chip: 'nvme', label: 'Composite', criticalCelsius: null })).toBe(70);
  expect(temperatureLimit({ ...sensor(), chip: 'unknown', label: 'Ambient', criticalCelsius: null })).toBeNull();
  expect(highTemperature({ ...sensor(), status: 'fault' })).toBe(false);
});

test('requires a full observed minute for CPU and two minutes for memory', () => {
  const almost = run(0, 59);
  expect(almost.cpu?.active).toBe(false);
  const minute = step(almost, 60);
  expect(minute.cpu?.active).toBe(true);
  expect(minute.memory?.active).toBe(false);
  expect(run(61, 120, minute).memory?.active).toBe(true);
});

test('isolated spikes and interrupted observations never become sustained alerts', () => {
  let state = run(0, 50);
  state = step(state, 51, 60, 60);
  expect(run(52, 100, state).cpu?.active).toBe(false);
  state = run(0, 50);
  expect(step(state, 120).cpu?.active).toBe(false);
  expect(run(121, 179, step(state, 120)).cpu?.active).toBe(false);
  expect(step(run(121, 179, step(state, 120)), 180).cpu?.active).toBe(true);
});

test('duplicate, old, invalid, stale and failed samples cannot advance alert windows', () => {
  const first = step({}, 0);
  expect(advanceSystemHealth(first, { telemetry: telemetry(0) }, epoch + 60_000).cpu?.active).toBe(false);
  const state = run(0, 59);
  expect(step(state, 58).cpu?.active).toBe(false);
  expect(advanceSystemHealth(state, { telemetry: telemetry(60), telemetryError: true }, epoch + 60_000).cpu?.fresh).toBe(false);
  const invalid = telemetry(60);
  invalid.cpu.totalPercent = Number.NaN;
  invalid.memory.availableBytes = 101;
  const missing = advanceSystemHealth(state, { telemetry: invalid }, epoch + 60_000);
  expect(missing.cpu?.highSince).toBeNull();
  expect(missing.memory?.highSince).toBeNull();
  expect(step(state, 60, 95, 95).cpu?.active).toBe(true);
});

test('recovery needs 30 continuous seconds below lower thresholds and does not chatter in the deadband', () => {
  const active = run(0, 120);
  const stillHigh = run(121, 180, active, 85, 88);
  expect(stillHigh.cpu?.active).toBe(true);
  expect(stillHigh.memory?.active).toBe(true);
  const almost = run(181, 210, stillHigh, 80, 85);
  expect(almost.cpu?.active).toBe(true);
  expect(almost.memory?.active).toBe(true);
  const recovered = step(almost, 211, 80, 85);
  expect(recovered.cpu?.active).toBe(false);
  expect(recovered.memory?.active).toBe(false);
  expect(step(recovered, 212).cpu?.active).toBe(false);
});

test('missing readings retain an existing alert as delayed, never invent recovery', () => {
  const active = run(0, 60);
  const missing = advanceSystemHealth(active, {}, epoch + 61_000);
  expect(missing.cpu).toMatchObject({ active: true, fresh: false, highSince: null, recoverySince: null });
  const resumed = run(120, 149, missing, 10, 10);
  expect(resumed.cpu?.active).toBe(true);
  expect(step(resumed, 150, 10, 10).cpu?.active).toBe(false);
});

test('temperature uses real 30-second sample times, host limits and recovery hysteresis', () => {
  let state: SystemHealth = {};
  for (const seconds of [0, 30, 60]) state = advanceSystemHealth(state, { sensors: sensors(seconds) }, epoch + seconds * 1000);
  expect(state['temperature:package']?.active).toBe(true);
  const delayed = advanceSystemHealth(state, { sensors: { ...sensors(90), stale: true } as HostSensors }, epoch + 90_000);
  expect(delayed['temperature:package']).toMatchObject({ active: true, fresh: false });
  const cooling = advanceSystemHealth(delayed, { sensors: sensors(120, sensor(83)) }, epoch + 120_000);
  expect(cooling['temperature:package']?.active).toBe(true);
  expect(advanceSystemHealth(cooling, { sensors: sensors(150, sensor(83)) }, epoch + 150_000)['temperature:package']?.active).toBe(false);
});

test('a changed CPU source or sensor threshold starts a new observation window', () => {
  const state = run(0, 59);
  expect(advanceSystemHealth(state, { telemetry: telemetry(60, 95, 95, 'runtime') }, epoch + 60_000).cpu?.active).toBe(false);
  let thermal = advanceSystemHealth({}, { sensors: sensors(0) }, epoch);
  thermal = advanceSystemHealth(thermal, { sensors: sensors(30) }, epoch + 30_000);
  expect(advanceSystemHealth(thermal, { sensors: sensors(60, sensor(95, 90)) }, epoch + 60_000)['temperature:package']?.active).toBe(false);
});

test('a missed hardware sampling interval restarts the temperature observation window', () => {
  const first = advanceSystemHealth({}, { sensors: sensors(0) }, epoch);
  const afterGap = advanceSystemHealth(first, { sensors: sensors(60) }, epoch + 60_000);
  expect(afterGap['temperature:package']?.active).toBe(false);
  expect(afterGap['temperature:package']?.highSince).toBe(epoch + 60_000);
});

test('sensor observers stop requests when their window is hidden and never poll in the background', () => {
  expect(sensorOptions(false).enabled).toBe(false);
  expect(sensorOptions(false).refetchIntervalInBackground).toBe(false);
  expect([...sensorOptions(true).queryKey]).toEqual(['host-sensors', '/api/system/host-sensors']);
});
