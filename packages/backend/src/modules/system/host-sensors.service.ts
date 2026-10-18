import { Injectable } from '@nestjs/common';
import type { HostFan, HostGpu, HostSensors, HostSensorStatus, HostTemperature } from '@runtipi/common/schemas';
import { readHostSocket } from './host-socket';

const unavailable = (reason = 'Sensor readings are unavailable. Check the Orbis host service.'): HostSensors => ({ available: false, reason });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sensor reading');
  return value as Record<string, unknown>;
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Invalid sensor count');
  return value;
}
function number(value: unknown, minimum: number, maximum: number, integer = false): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value)))
    throw new Error('Invalid sensor value');
  return value;
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Array.from(value).length > 128 ||
    Array.from(value).some((character) => character !== ' ' && /[\p{C}\p{Z}]/u.test(character))
  )
    throw new Error('Invalid sensor label');
  return value;
}
function status(value: unknown): HostSensorStatus {
  if (value !== 'available' && value !== 'fault' && value !== 'disabled' && value !== 'unavailable') throw new Error('Invalid sensor state');
  return value;
}

export function parseHostSensors(value: unknown, now = Date.now()): HostSensors {
  const data = record(value);
  if (data.available === false) return unavailable(data.reason === 'Collecting sensor readings.' ? data.reason : undefined);
  if (data.available !== true || typeof data.stale !== 'boolean' || typeof data.limited !== 'boolean') throw new Error('Invalid sensor sample');
  const sampledAt = data.sampledAt;
  const timestamp =
    typeof sampledAt === 'string' && sampledAt.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(sampledAt) ? Date.parse(sampledAt) : Number.NaN;
  if (typeof sampledAt !== 'string' || !Number.isFinite(timestamp) || timestamp > now + 5000) throw new Error('Invalid sensor timestamp');
  const seen = new Set<string>();
  const rows = <T>(value: unknown, kind: string, parse: (value: Record<string, unknown>) => T): T[] => {
    if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid sensor rows');
    return value.map((value) => {
      const row = record(value);
      if (typeof row.id !== 'string' || !new RegExp(`^${kind}:[a-f0-9]{16}$`).test(row.id) || seen.has(row.id))
        throw new Error('Invalid sensor identity');
      seen.add(row.id);
      return parse(row);
    });
  };
  const temperatures = rows<HostTemperature>(data.temperatures, 'temperature', (row) => {
    const state = status(row.status);
    const celsius = number(row.celsius, -273.15, 1000);
    if ((state === 'available') !== (celsius !== null)) throw new Error('Inconsistent temperature state');
    return {
      id: row.id as string,
      label: text(row.label),
      chip: text(row.chip),
      status: state,
      celsius,
      criticalCelsius: number(row.criticalCelsius, -273.15, 1000),
    };
  });
  const fans = rows<HostFan>(data.fans, 'fan', (row) => {
    const state = status(row.status);
    const rpm = number(row.rpm, 0, 1_000_000, true);
    if ((state === 'available') !== (rpm !== null)) throw new Error('Inconsistent fan state');
    return { id: row.id as string, label: text(row.label), chip: text(row.chip), status: state, rpm };
  });
  const gpus = rows<HostGpu>(data.gpus, 'gpu', (row) => {
    const memoryUsedBytes = number(row.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER, true);
    const memoryTotalBytes = number(row.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER, true);
    if (memoryUsedBytes !== null && memoryTotalBytes !== null && memoryUsedBytes > memoryTotalBytes) throw new Error('Invalid GPU memory');
    const utilizationPercent = number(row.utilizationPercent, 0, 100);
    if (row.driver !== 'amdgpu' && (utilizationPercent !== null || memoryUsedBytes !== null || memoryTotalBytes !== null))
      throw new Error('Unsupported GPU metric source');
    return {
      id: row.id as string,
      label: text(row.label),
      vendor: row.vendor === null ? null : text(row.vendor),
      driver: row.driver === null ? null : text(row.driver),
      utilizationPercent,
      memoryUsedBytes,
      memoryTotalBytes,
    };
  });
  const omitted = record(data.omitted);
  const groups = ['temperatures', 'fans', 'gpus'] as const;
  if (
    !Array.isArray(data.unavailable) ||
    data.unavailable.length > 3 ||
    new Set(data.unavailable).size !== data.unavailable.length ||
    !data.unavailable.every((group) => groups.includes(group))
  )
    throw new Error('Invalid sensor coverage');
  return {
    available: true,
    sampledAt,
    stale: data.stale || now - timestamp > 90_000,
    limited: data.limited,
    unreadable: count(data.unreadable, 16384),
    temperatures,
    fans,
    gpus,
    omitted: { temperatures: count(omitted.temperatures, 16384), fans: count(omitted.fans, 16384), gpus: count(omitted.gpus, 16384) },
    unavailable: data.unavailable,
  };
}

@Injectable()
export class HostSensorsService {
  private readonly socketPath = process.env.ORBIS_HOST_SOCKET;
  private cached: { expiresAt: number; result: HostSensors } | null = null;
  private pending: Promise<HostSensors> | null = null;

  read(): Promise<HostSensors> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      const result = this.cached.result;
      return Promise.resolve(result.available ? { ...result, stale: result.stale || Date.now() - Date.parse(result.sampledAt) > 90_000 } : result);
    }
    if (!this.pending) {
      const startedAt = Date.now();
      this.pending = readHostSocket(this.socketPath, '/v1/sensors', parseHostSensors, (reason) =>
        unavailable(
          reason === 'missing'
            ? 'Connect the Orbis host service to see sensors.'
            : reason === 'older'
              ? 'Update the Orbis host service to see sensors.'
              : undefined,
        ),
      )
        .catch(() => unavailable())
        .then((result) => {
          this.cached = { expiresAt: result.available ? startedAt + 25_000 : Date.now() + 2000, result };
          return result;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }
}
