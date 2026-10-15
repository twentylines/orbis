import type { MetricHistoryPoint, MetricSummary } from '@runtipi/common/schemas';
import type { SystemService } from './system.service';

type Accumulator = [sum: number, peak: number, count: number];
export type MetricBucket = {
  bucketAt: number;
  firstAt: number;
  lastAt: number;
  samples: number;
  cpuScope: MetricHistoryPoint['cpuScope'];
  cpu: Accumulator;
  memory: Accumulator;
  download: Accumulator;
  upload: Accumulator;
};
export const metricFields = ['cpu', 'memory', 'download', 'upload'] as const;
const safe = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const percentage = (value: number | null) => (value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
const accumulator = (value: number | null): Accumulator => (value === null ? [0, 0, 0] : [value, value, 1]);

export function metricSample(sample: Awaited<ReturnType<SystemService['getTelemetry']>>): MetricBucket | null {
  const at = Date.parse(sample.sampledAt);
  if (!Number.isFinite(at)) return null;
  const total = safe(sample.memory.totalBytes);
  const available = safe(sample.memory.availableBytes);
  const memory = total && available !== null ? percentage(((total - available) / total) * 100) : null;
  const network = sample.network.filter((item) => item.interface !== 'lo');
  const networkRate = (field: 'rxBytesPerSecond' | 'txBytesPerSecond') =>
    network.length && network.every((item) => safe(item[field]) !== null) ? network.reduce((sum, item) => sum + (item[field] ?? 0), 0) : null;
  return {
    bucketAt: Math.floor(at / 60000) * 60000,
    firstAt: at,
    lastAt: at,
    samples: 1,
    cpuScope: sample.cpu.scope === 'host-proc' ? 'host-proc' : 'runtime',
    cpu: accumulator(percentage(safe(sample.cpu.totalPercent))),
    memory: accumulator(memory),
    download: accumulator(networkRate('rxBytesPerSecond')),
    upload: accumulator(networkRate('txBytesPerSecond')),
  };
}

export function mergeBuckets(left: MetricBucket, right: MetricBucket): MetricBucket {
  const cpuScope = left.cpuScope === right.cpuScope ? left.cpuScope : 'mixed';
  const merged = {
    bucketAt: left.bucketAt,
    firstAt: Math.min(left.firstAt, right.firstAt),
    lastAt: Math.max(left.lastAt, right.lastAt),
    samples: left.samples + right.samples,
    cpuScope,
  } as MetricBucket;
  for (const field of metricFields) {
    merged[field] =
      field === 'cpu' && cpuScope === 'mixed'
        ? [0, 0, 0]
        : [left[field][0] + right[field][0], Math.max(left[field][1], right[field][1]), left[field][2] + right[field][2]];
  }
  return merged;
}

export function historyPoint(bucket: MetricBucket, intervalSeconds: number): MetricHistoryPoint {
  const summary = ([sum, peak, count]: Accumulator): MetricSummary => ({
    average: count ? sum / count : null,
    peak: count ? peak : null,
    samples: count,
  });
  return {
    at: new Date(bucket.firstAt).toISOString(),
    until: new Date(bucket.lastAt).toISOString(),
    intervalSeconds,
    samples: bucket.samples,
    cpuScope: bucket.cpuScope,
    cpu: summary(bucket.cpu),
    memory: summary(bucket.memory),
    download: summary(bucket.download),
    upload: summary(bucket.upload),
  };
}

export function encodeBucket(bucket: MetricBucket): string {
  return JSON.stringify([
    bucket.bucketAt,
    bucket.firstAt,
    bucket.lastAt,
    bucket.samples,
    ['host-proc', 'runtime', 'mixed'].indexOf(bucket.cpuScope),
    ...bucket.cpu,
    ...bucket.memory,
    ...bucket.download,
    ...bucket.upload,
  ]);
}

export function decodeBucket(value: unknown, now: number): MetricBucket {
  if (!Array.isArray(value) || value.length !== 17 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item < 0))
    throw new Error('Invalid metric history record');
  const [bucketAt, firstAt, lastAt, samples, scope] = value as number[];
  if (
    bucketAt === undefined ||
    firstAt === undefined ||
    lastAt === undefined ||
    samples === undefined ||
    scope === undefined ||
    bucketAt % 60000 !== 0 ||
    firstAt < bucketAt ||
    firstAt >= bucketAt + 60000 ||
    lastAt < firstAt ||
    lastAt >= bucketAt + 60000 ||
    lastAt > now + 300000 ||
    !Number.isInteger(samples) ||
    samples < 1 ||
    samples > 120 ||
    ![0, 1, 2].includes(scope)
  )
    throw new Error('Invalid metric history bounds');
  const bucket = { bucketAt, firstAt, lastAt, samples, cpuScope: (['host-proc', 'runtime', 'mixed'] as const)[scope] } as MetricBucket;
  for (const [index, field] of metricFields.entries()) {
    const [sum = 0, peak = 0, count = 0] = value.slice(5 + index * 3, 8 + index * 3) as number[];
    if (
      !Number.isInteger(count) ||
      count > samples ||
      (count === 0 && (sum !== 0 || peak !== 0)) ||
      peak > sum ||
      sum > peak * count + 0.00001 ||
      ((field === 'cpu' || field === 'memory') && peak > 100) ||
      (field === 'cpu' && scope === 2 && count !== 0)
    )
      throw new Error('Invalid metric aggregate');
    bucket[field] = [sum, peak, count];
  }
  return bucket;
}
