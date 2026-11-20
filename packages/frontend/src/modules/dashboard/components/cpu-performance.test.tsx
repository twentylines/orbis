import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetricHistory } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { CpuPerformance } from './cpu-performance';

const sample: Telemetry = {
  sampledAt: '2026-11-19T04:00:00.000Z',
  cpu: { scope: 'host-proc', model: 'Actual CPU model', totalPercent: 18, perCorePercent: [0, 36], uptimeSeconds: 100 },
  memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 50, swapTotalBytes: 0, swapFreeBytes: 0 },
  filesystems: [],
  network: [],
};
const render = (cpu = sample.cpu, history?: MetricHistory, logicalProcessors?: boolean) =>
  renderToStaticMarkup(
    <CpuPerformance sample={{ ...sample, cpu }} history={history} loading={false} delayed={false} logicalProcessors={logicalProcessors} />,
  );

test('CPU offers one labelled logical processor switch inside the CPU view and preserves actual model and idle utilisation', () => {
  const html = render({ ...sample.cpu, totalPercent: 0 });
  expect(html).toContain('Actual CPU model');
  expect(html).toContain('role="switch"');
  expect(html).toContain('Logical processors');
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('<strong>0.0%</strong>');
  expect(html).toContain('2 logical processors');
  expect(html).toContain('aria-label="Logical processor utilisation charts"');
  expect(html).not.toContain('aria-pressed');
});

test('runtime-only CPU values cannot appear as system or logical processor load', () => {
  const html = render({ ...sample.cpu, scope: 'runtime', totalPercent: 81.25, perCorePercent: [91.5, 71] });
  expect(html).toContain('<strong>Unavailable</strong>');
  expect(html).toContain('Host CPU counters are unavailable.');
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('81.3%');
  expect(html).not.toContain('91.5%');
  expect(html).not.toContain('2 logical processors');
});

test('system CPU history leaves runtime and mixed readings as gaps', () => {
  const summary = (average: number) => ({ average, peak: average, samples: 1 });
  const history: MetricHistory = {
    range: '5m',
    from: '2026-11-19T03:55:00.000Z',
    to: sample.sampledAt,
    resolutionSeconds: 10,
    sampledEverySeconds: 10,
    retentionDays: 7,
    storage: 'persistent',
    collectorAvailable: true,
    lastSampleAt: sample.sampledAt,
    persistedThrough: sample.sampledAt,
    points: (['host-proc', 'runtime', 'mixed'] as const).map((cpuScope, index) => ({
      at: new Date(Date.parse(sample.sampledAt) - (2 - index) * 10000).toISOString(),
      until: new Date(Date.parse(sample.sampledAt) - (2 - index) * 10000).toISOString(),
      intervalSeconds: 10,
      samples: 1,
      cpuScope,
      cpu: summary(index === 0 ? 18 : 94),
      memory: summary(50),
      download: summary(0),
      upload: summary(0),
    })),
  };
  const html = render(sample.cpu, history, false);
  expect(html).toContain('aria-checked="false"');
  expect(html).not.toContain('aria-label="Logical processor utilisation charts"');
  expect(html).toContain('Inspect System CPU utilisation history');
  expect(html).not.toContain('data-history-segment');
  expect(html).toContain('<circle');
  expect(html).not.toContain('94.0%');
  expect(history.points[1]?.cpu.average).toBe(94);
});

test('invalid total percentages and missing per-processor data remain unavailable', () => {
  for (const totalPercent of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const html = render({ ...sample.cpu, totalPercent, perCorePercent: [] });
    expect(html).toContain('<strong>Unavailable</strong>');
    expect(html).toContain('Per-processor readings are unavailable.');
    expect(html).toContain('disabled=""');
  }
});
