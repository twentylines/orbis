import type { HostHistoryPoint, HostHistorySelection, HostTelemetry, MetricSummary } from '@runtipi/common/schemas';

export const hostHistoryTiers = [
  { seconds: 60, retentionMs: 3600000 },
  { seconds: 300, retentionMs: 86400000 },
  { seconds: 1800, retentionMs: 604800000 },
] as const;
export type HostHistoryTier = (typeof hostHistoryTiers)[number]['seconds'];
type Mean = [average: number, peak: number, count: number];
export type HostHistoryRow = HostHistorySelection & {
  sourceId: string | null;
  firstAt: number;
  lastAt: number;
  samples: number;
  inbound: Mean;
  outbound: Mean;
  busy: Mean;
};
export type HostHistoryBucket = {
  seconds: HostHistoryTier;
  bucketAt: number;
  firstAt: number;
  lastAt: number;
  samples: number;
  rows: Map<string, HostHistoryRow>;
};
export type HostHistorySample = { at: number; rows: HostHistoryRow[]; unidentified: number };
const fields = ['inbound', 'outbound', 'busy'] as const;
const validName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '.' && value !== '..' && /^[a-zA-Z0-9_.:@+!-]{1,128}$/.test(value);
const validSource = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const whole = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const validSpan = (first: number, last: number, count: number) => (count === 1 ? first === last : last - first >= (count - 1) * 2000);
const empty = (): Mean => [0, 0, 0];
const mean = (value: number | null, percentage = false): Mean => {
  if (value === null) return empty();
  if (!finite(value) || (percentage && value > 100)) throw new Error('Invalid device history reading');
  return [value, value, 1];
};
export const hostHistoryKey = ({ kind, name }: HostHistorySelection) => `${kind}:${name}`;

export function parseHostHistorySelection(value: unknown): HostHistorySelection | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 136) throw new Error('Invalid history device');
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!['network', 'disk'].includes(kind) || !validName(name)) throw new Error('Invalid history device');
  return { kind: kind as HostHistorySelection['kind'], name };
}

export function hostHistorySample(data: HostTelemetry, now: number): HostHistorySample | null {
  if (!data.available || data.stale) return null;
  const at = Date.parse(data.sampledAt);
  if (!Number.isSafeInteger(at) || at < 0 || at > now + 5000 || now - at > 30000) return null;
  if (data.network.length > 32 || data.disks.length > 32) throw new Error('Too many history devices');
  const rows: HostHistoryRow[] = [];
  const keys = new Set<string>();
  let unidentified = 0;
  for (const [kind, devices] of [
    ['network', data.network],
    ['disk', data.disks],
  ] as const) {
    for (const device of devices) {
      const name = 'interface' in device ? device.interface : device.device;
      if (!validName(name)) throw new Error('Invalid history device name');
      const key = hostHistoryKey({ kind, name });
      if (keys.has(key)) throw new Error('Duplicate history device');
      keys.add(key);
      if (device.historyId === undefined) {
        unidentified++;
        continue;
      }
      if (!validSource(device.historyId)) throw new Error('Invalid history source');
      rows.push({
        kind,
        name,
        sourceId: device.historyId,
        firstAt: at,
        lastAt: at,
        samples: 1,
        inbound: mean('interface' in device ? device.rxBytesPerSecond : device.readBytesPerSecond),
        outbound: mean('interface' in device ? device.txBytesPerSecond : device.writeBytesPerSecond),
        busy: mean('interface' in device ? null : device.busyPercent, true),
      });
    }
  }
  return { at, rows, unidentified };
}

export function hostHistoryBucket(sample: HostHistorySample, seconds: HostHistoryTier): HostHistoryBucket {
  return {
    seconds,
    bucketAt: Math.floor(sample.at / (seconds * 1000)) * seconds * 1000,
    firstAt: sample.at,
    lastAt: sample.at,
    samples: 1,
    rows: new Map(sample.rows.map((row) => [hostHistoryKey(row), row])),
  };
}

function mergeMean(left: Mean, right: Mean): Mean {
  if (!left[2]) return [...right];
  if (!right[2]) return [...left];
  const count = left[2] + right[2];
  return [left[0] + (right[0] - left[0]) * (right[2] / count), Math.max(left[1], right[1]), count];
}

export function mergeHostHistory(left: HostHistoryBucket, right: HostHistoryBucket): HostHistoryBucket {
  if (left.seconds !== right.seconds || left.bucketAt !== right.bucketAt || right.firstAt <= left.lastAt)
    throw new Error('Device history buckets must be ordered and disjoint');
  const rows = new Map(left.rows);
  for (const [key, row] of right.rows) {
    const prior = rows.get(key);
    if (!prior) {
      rows.set(key, row);
      continue;
    }
    const same = prior.sourceId !== null && prior.sourceId === row.sourceId;
    rows.set(key, {
      ...row,
      firstAt: prior.firstAt,
      samples: prior.samples + row.samples,
      sourceId: same ? row.sourceId : null,
      inbound: same ? mergeMean(prior.inbound, row.inbound) : empty(),
      outbound: same ? mergeMean(prior.outbound, row.outbound) : empty(),
      busy: same ? mergeMean(prior.busy, row.busy) : empty(),
    });
  }
  if (rows.size > 64) throw new Error('Too many merged history devices');
  return { ...right, firstAt: left.firstAt, samples: left.samples + right.samples, rows };
}

export function hostHistoryPoint(row: HostHistoryRow, intervalSeconds: number): HostHistoryPoint {
  const summary = ([average, peak, count]: Mean): MetricSummary => ({ average: count ? average : null, peak: count ? peak : null, samples: count });
  return {
    at: new Date(row.firstAt).toISOString(),
    until: new Date(row.lastAt).toISOString(),
    intervalSeconds,
    samples: row.samples,
    sourceId: row.sourceId,
    inbound: summary(row.inbound),
    outbound: summary(row.outbound),
    busy: summary(row.busy),
  };
}

export function encodeHostHistory(bucket: HostHistoryBucket, evictedDevices: number): string {
  return JSON.stringify([
    1,
    bucket.seconds,
    bucket.bucketAt,
    bucket.firstAt,
    bucket.lastAt,
    bucket.samples,
    evictedDevices,
    [...bucket.rows.values()]
      .sort((a, b) => hostHistoryKey(a).localeCompare(hostHistoryKey(b)))
      .map((row) => [
        row.kind === 'network' ? 0 : 1,
        row.name,
        row.sourceId,
        row.firstAt,
        row.lastAt,
        row.samples,
        ...row.inbound,
        ...row.outbound,
        ...row.busy,
      ]),
  ]);
}

export function decodeHostHistory(value: unknown, now: number): { bucket: HostHistoryBucket; evictedDevices: number } {
  if (!Array.isArray(value) || value.length !== 8 || value[0] !== 1) throw new Error('Invalid device history record');
  const [, seconds, bucketAt, firstAt, lastAt, samples, evictedDevices, entries] = value;
  if (
    !hostHistoryTiers.some((tier) => tier.seconds === seconds) ||
    !whole(bucketAt) ||
    !whole(firstAt) ||
    !whole(lastAt) ||
    !whole(samples) ||
    !whole(evictedDevices) ||
    bucketAt % (seconds * 1000) !== 0 ||
    firstAt < bucketAt ||
    firstAt >= bucketAt + seconds * 1000 ||
    lastAt < firstAt ||
    lastAt >= bucketAt + seconds * 1000 ||
    lastAt > now + 300000 ||
    samples < 1 ||
    samples > seconds / 2 + 1 ||
    !validSpan(firstAt, lastAt, samples) ||
    !Array.isArray(entries) ||
    entries.length > 64
  )
    throw new Error('Invalid device history bounds');
  const rows = new Map<string, HostHistoryRow>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 15) throw new Error('Invalid history device row');
    const [kind, name, sourceId, rowFirst, rowLast, rowSamples] = entry;
    if (
      ![0, 1].includes(kind) ||
      !validName(name) ||
      (sourceId !== null && !validSource(sourceId)) ||
      !whole(rowFirst) ||
      !whole(rowLast) ||
      !whole(rowSamples) ||
      rowSamples < 1 ||
      rowSamples > samples ||
      rowFirst < firstAt ||
      rowLast < rowFirst ||
      rowLast > lastAt ||
      !validSpan(rowFirst, rowLast, rowSamples)
    )
      throw new Error('Invalid history device identity');
    const row = { kind: kind === 0 ? 'network' : 'disk', name, sourceId, firstAt: rowFirst, lastAt: rowLast, samples: rowSamples } as HostHistoryRow;
    for (const [index, field] of fields.entries()) {
      const [average, peak, count] = entry.slice(6 + index * 3, 9 + index * 3);
      if (
        !finite(average) ||
        !finite(peak) ||
        !whole(count) ||
        count > rowSamples ||
        (count === 0 && (average !== 0 || peak !== 0)) ||
        (count === 1 && average !== peak) ||
        average > peak * (1 + 1e-12) + 1e-8 ||
        (field === 'busy' && (peak > 100 || (kind === 0 && count !== 0))) ||
        (count > 0 && average + peak * 1e-12 + 1e-8 < peak / count) ||
        (sourceId === null && count !== 0)
      )
        throw new Error('Invalid device history aggregate');
      row[field] = [average, peak, count];
    }
    const key = hostHistoryKey(row);
    if (rows.has(key)) throw new Error('Duplicate stored history device');
    rows.set(key, row);
  }
  return { bucket: { seconds, bucketAt, firstAt, lastAt, samples, rows }, evictedDevices };
}
