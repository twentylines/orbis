import { expect, test } from 'bun:test';
import type { Telemetry } from '@/desktop/telemetry';
import { appendProcessorSample, processorChartSegments } from './logical-processor-history';
const sample = (seconds: number, values: (number | null)[], model = 'Test CPU') =>
  ({
    sampledAt: new Date(1_790_000_000_000 + seconds * 1000).toISOString(),
    cpu: { scope: 'host-proc', model, perCorePercent: values },
  }) as Telemetry;

test('preserves idle and missing processor readings without drawing across collection gaps', () => {
  let points = appendProcessorSample([], sample(0, [0, 30]));
  points = appendProcessorSample(points, sample(1, [20, null]));
  points = appendProcessorSample(points, sample(2, [30, 50]));
  expect(processorChartSegments(points, 0, Date.parse(sample(2, []).sampledAt))).toHaveLength(1);
  expect(processorChartSegments(points, 1, Date.parse(sample(2, []).sampledAt))).toHaveLength(2);
  points = appendProcessorSample(points, sample(10, [40, 60]));
  expect(processorChartSegments(points, 0, Date.parse(sample(10, []).sampledAt))).toHaveLength(2);
  expect(points[0]?.values[0]).toBe(0);
});

test('does not blend sources, processor counts or CPU models, or accept duplicate/backwards times', () => {
  const first = appendProcessorSample([], sample(0, [20, 30]));
  expect(appendProcessorSample(first, sample(0, [40, 50]))).toBe(first);
  expect(appendProcessorSample(first, sample(-1, [40, 50]))).toBe(first);
  expect(appendProcessorSample(first, sample(1, [40]))).toHaveLength(1);
  expect(appendProcessorSample(first, sample(1, [40, 50], 'Other CPU'))).toHaveLength(1);
  const runtime = sample(1, [40, 50]);
  runtime.cpu.scope = 'runtime';
  expect(appendProcessorSample(first, runtime)).toHaveLength(1);
});

test('retains only the last minute and treats invalid utilisation as missing', () => {
  let points = appendProcessorSample([], sample(0, [10]));
  for (let second = 1; second <= 120; second++) points = appendProcessorSample(points, sample(second, [second === 120 ? Number.NaN : 50]));
  expect(points).toHaveLength(61);
  expect(points[0]?.at).toBe(Date.parse(sample(60, []).sampledAt));
  expect(points.at(-1)?.values).toEqual([null]);
  expect(appendProcessorSample(points, { ...sample(121, [50]), sampledAt: 'invalid' })).toBe(points);
  expect(appendProcessorSample([], sample(0, [-1, 101, Number.POSITIVE_INFINITY, null]))[0]?.values).toEqual([null, null, null, null]);
});
