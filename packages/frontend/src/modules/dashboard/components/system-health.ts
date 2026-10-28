import type { HostSensors, HostTemperature } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { usagePercent } from './system-readings';

export const highUsagePercent = 90;
export const highUsage = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= highUsagePercent;

export function temperatureLimit(sensor: Pick<HostTemperature, 'chip' | 'label' | 'criticalCelsius'>) {
  if (sensor.criticalCelsius !== null && Number.isFinite(sensor.criticalCelsius) && sensor.criticalCelsius > 0) return sensor.criticalCelsius;
  const name = `${sensor.chip} ${sensor.label}`;
  if (/nvme|drivetemp|sata|disk/i.test(name)) return 70;
  if (/coretemp|k10temp|zenpower|cpu[_ -]?thermal|\bcpu\b|package id|\btctl\b|\btdie\b|amdgpu|nouveau|nvidia|radeon/i.test(name)) return 85;
  return null;
}

export const highTemperature = (sensor: HostTemperature) => {
  const limit = temperatureLimit(sensor);
  return sensor.status === 'available' && sensor.celsius !== null && Number.isFinite(sensor.celsius) && limit !== null && sensor.celsius >= limit;
};

type Reading = {
  id: string;
  label: string;
  href: string;
  value: number;
  threshold: number;
  recovery: number;
  sustainMs: number;
  maxGapMs: number;
  freshForMs: number;
  at: number;
  source: string;
  unit: '%' | '°C';
};
export type HealthCondition = Reading & {
  highSince: number | null;
  recoverySince: number | null;
  active: boolean;
  fresh: boolean;
};
export type SystemHealth = Record<string, HealthCondition>;
export type HealthSamples = { telemetry?: Telemetry; sensors?: HostSensors; telemetryError?: boolean; sensorsError?: boolean };

const validTime = (value: string, now: number, maxAge: number) => {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now + 5000 && now - at <= maxAge ? at : null;
};

// Windows advance only on distinct server samples: 60s CPU/temperature, 120s memory.
// Recovery needs 30s below 80% CPU, 85% memory or 5°C below the temperature limit.
export function advanceSystemHealth(previous: SystemHealth, samples: HealthSamples, now: number): SystemHealth {
  const readings: Reading[] = [];
  const telemetry = samples.telemetry;
  const telemetryAt = telemetry && !samples.telemetryError ? validTime(telemetry.sampledAt, now, 5000) : null;
  if (telemetry && telemetryAt !== null) {
    const cpu = telemetry.cpu.totalPercent;
    if (cpu !== null && Number.isFinite(cpu) && cpu >= 0) {
      readings.push({
        id: 'cpu',
        label: telemetry.cpu.scope === 'runtime' ? 'Core CPU load' : 'CPU load',
        href: '/monitor#telemetry-cpu-title',
        value: cpu,
        threshold: 90,
        recovery: 80,
        sustainMs: 60_000,
        maxGapMs: 5000,
        freshForMs: 5000,
        at: telemetryAt,
        source: telemetry.cpu.scope,
        unit: '%',
      });
    }
    const { totalBytes, availableBytes } = telemetry.memory;
    const memory = usagePercent(totalBytes !== null && availableBytes !== null ? totalBytes - availableBytes : null, totalBytes);
    if (memory !== null)
      readings.push({
        id: 'memory',
        label: 'Memory use',
        href: '/monitor#telemetry-memory-title',
        value: memory,
        threshold: 90,
        recovery: 85,
        sustainMs: 120_000,
        maxGapMs: 5000,
        freshForMs: 5000,
        at: telemetryAt,
        source: telemetry.memory.scope,
        unit: '%',
      });
  }
  const sensors = samples.sensors;
  const sensorAt = sensors?.available && !sensors.stale && !samples.sensorsError ? validTime(sensors.sampledAt, now, 90_000) : null;
  if (sensors?.available && sensorAt !== null) {
    for (const sensor of sensors.temperatures) {
      const threshold = temperatureLimit(sensor);
      if (sensor.status !== 'available' || sensor.celsius === null || !Number.isFinite(sensor.celsius) || threshold === null) continue;
      readings.push({
        id: `temperature:${sensor.id}`,
        label: `${sensor.label} temperature`,
        href: '/monitor#host-temperatures-title',
        value: sensor.celsius,
        threshold,
        recovery: Math.max(0, threshold - 5),
        sustainMs: 60_000,
        maxGapMs: 45_000,
        freshForMs: 90_000,
        at: sensorAt,
        source: `${sensor.chip}:${threshold}`,
        unit: '°C',
      });
    }
  }
  const next: SystemHealth = {};
  for (const [id, state] of Object.entries(previous)) next[id] = { ...state, fresh: false, highSince: null, recoverySince: null };
  for (const reading of readings) {
    const old = previous[reading.id];
    if (old && reading.at < old.at) continue;
    if (old && reading.at === old.at && old.source === reading.source) {
      next[reading.id] = { ...old, fresh: true };
      continue;
    }
    const continuous = old?.fresh && old.source === reading.source && reading.at - old.at <= reading.maxGapMs;
    const active = old?.source === reading.source && old.active;
    const highSince = reading.value >= reading.threshold ? ((continuous ? old.highSince : null) ?? reading.at) : null;
    const recoverySince = active && reading.value <= reading.recovery ? ((continuous ? old.recoverySince : null) ?? reading.at) : null;
    next[reading.id] = {
      ...reading,
      highSince,
      recoverySince,
      active: Boolean(
        active ? recoverySince === null || reading.at - recoverySince < 30_000 : highSince !== null && reading.at - highSince >= reading.sustainMs,
      ),
      fresh: true,
    };
  }
  return next;
}

export function expireSystemHealth(state: SystemHealth, now: number): SystemHealth {
  let expired = state;
  for (const [id, condition] of Object.entries(state)) {
    if (!condition.fresh || now <= condition.at + condition.freshForMs) continue;
    if (expired === state) expired = { ...state };
    expired[id] = { ...condition, fresh: false, highSince: null, recoverySince: null };
  }
  return expired;
}
