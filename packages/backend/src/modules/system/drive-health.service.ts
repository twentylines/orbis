import { Injectable } from '@nestjs/common';
import type { DriveHealth, DriveHealthPoint, DriveHealthSample, DriveHealthState } from '@runtipi/common/schemas/drive-health';
import { readHostSocket } from './host-socket';

const unavailable = (reason = 'Drive health is unavailable. Check the Orbis host service.'): DriveHealthSample => ({ available: false, reason });
const states = new Set(['passed', 'warning', 'failed', 'unavailable', 'sleeping']);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid drive reading');
  return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 128): string => {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\p{C}\p{Zl}\p{Zp}]/u.test(value))
    throw new Error('Invalid drive text');
  return value;
};
const number = (value: unknown, low = 0, high = Number.MAX_SAFE_INTEGER): number | null => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (low >= 0 && !Number.isSafeInteger(value)))
    throw new Error('Invalid drive value');
  return value;
};
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid drive flag');
  return value;
};
const state = (value: unknown): DriveHealthState => {
  if (typeof value !== 'string' || !states.has(value)) throw new Error('Invalid drive health');
  return value as DriveHealthState;
};
const timestamp = (value: unknown): string => {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result)) || Date.parse(result) > Date.now() + 5000)
    throw new Error('Invalid drive timestamp');
  return result;
};
function list<T>(value: unknown, limit: number, parse: (row: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid drive rows');
  return value.map((row) => parse(record(row)));
}
const point = (row: Record<string, unknown>): DriveHealthPoint => ({
  at: timestamp(row.at),
  health: state(row.health),
  temperature: number(row.temperature, -100, 300),
  percentageUsed: number(row.percentageUsed, 0, 255),
  pendingSectors: number(row.pendingSectors),
  mediaErrors: number(row.mediaErrors),
});
export function parseDriveHealth(value: unknown): DriveHealthSample {
  const data = record(value);
  if (data.available === false) return unavailable(text(data.reason, 256));
  if (data.available !== true) throw new Error('Invalid drive sample');
  const sampledAt = timestamp(data.sampledAt);
  const seen = new Set<string>();
  const drives = list<DriveHealth>(data.drives, 32, (row) => {
    const id = text(row.id);
    if (!/^drive:[a-f0-9]{24}$/.test(id) || seen.has(id)) throw new Error('Invalid drive identity');
    seen.add(id);
    const test = record(row.selfTest);
    if (!Array.isArray(row.reasons) || row.reasons.length > 12) throw new Error('Invalid drive reasons');
    return {
      id,
      device: text(row.device),
      model: text(row.model),
      firmware: row.firmware === null ? null : text(row.firmware),
      protocol: text(row.protocol),
      capacityBytes: number(row.capacityBytes),
      health: state(row.health),
      reasons: row.reasons.map((reason) => text(reason, 256)),
      sampledAt: timestamp(row.sampledAt),
      temperature: number(row.temperature, -100, 300),
      powerOnHours: number(row.powerOnHours),
      percentageUsed: number(row.percentageUsed, 0, 255),
      availableSpare: number(row.availableSpare, 0, 100),
      spareThreshold: number(row.spareThreshold, 0, 100),
      reallocatedSectors: number(row.reallocatedSectors),
      pendingSectors: number(row.pendingSectors),
      uncorrectableSectors: number(row.uncorrectableSectors),
      mediaErrors: number(row.mediaErrors),
      errorCount: number(row.errorCount),
      unsafeShutdowns: number(row.unsafeShutdowns),
      bytesRead: number(row.bytesRead),
      bytesWritten: number(row.bytesWritten),
      selfTest: {
        supported: bool(test.supported),
        running: bool(test.running),
        remainingPercent: number(test.remainingPercent, 0, 100),
        shortMinutes: number(test.shortMinutes),
        extendedMinutes: number(test.extendedMinutes),
      },
      tests: list(row.tests, 10, (test) => ({
        type: text(test.type),
        status: text(test.status),
        passed: test.passed === null ? null : bool(test.passed),
        hours: number(test.hours),
      })),
      errors: list(row.errors, 20, (error) => ({ summary: text(error.summary, 256), hours: number(error.hours) })),
      attributes: list(row.attributes, 64, (attribute) => ({
        id: number(attribute.id, 1, 255) as number,
        name: text(attribute.name),
        value: number(attribute.value),
        worst: number(attribute.worst),
        threshold: number(attribute.threshold),
        raw: text(attribute.raw, 64),
        failing: bool(attribute.failing),
      })),
      history: list(row.history, 168, point),
    };
  });
  return {
    available: true,
    sampledAt,
    stale: bool(data.stale) || Date.now() - Date.parse(sampledAt) > 180_000,
    limited: bool(data.limited),
    historyAvailable: bool(data.historyAvailable),
    drives,
  };
}

@Injectable()
export class DriveHealthService {
  private cached: { at: number; data: DriveHealthSample } | null = null;
  private pending: Promise<DriveHealthSample> | null = null;
  private revision = 0;

  invalidate() {
    this.revision += 1;
    this.cached = null;
    this.pending = null;
  }

  read(): Promise<DriveHealthSample> {
    if (this.cached && Date.now() - this.cached.at < (this.cached.data.available ? 10_000 : 2000)) return Promise.resolve(this.cached.data);
    if (this.pending) return this.pending;
    const revision = this.revision;
    const pending = readHostSocket(process.env.ORBIS_HOST_SOCKET, '/v1/drives', parseDriveHealth, (reason) =>
      unavailable(
        reason === 'missing'
          ? 'Connect the Orbis host service to read physical drive health.'
          : reason === 'older'
            ? 'Update the Orbis host service to enable drive health.'
            : undefined,
      ),
    )
      .catch(() => unavailable())
      .then((data) => {
        if (revision === this.revision) this.cached = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }
}
