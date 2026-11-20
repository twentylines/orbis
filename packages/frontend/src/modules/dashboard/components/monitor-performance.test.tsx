import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { HostSensors } from '@runtipi/common/schemas';
import type { Telemetry } from '@/desktop/telemetry';
import { MonitorPerformance } from './monitor-performance';

test('GPU identity and metrics remain accessible when CPU telemetry is unavailable', () => {
  const sensors = {
    available: true,
    gpus: [
      { id: 'one', label: 'Independent GPU', vendor: null, driver: null, utilizationPercent: 27, memoryUsedBytes: null, memoryTotalBytes: null },
    ],
  } as HostSensors;
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/monitor?section=performance&metric=gpu']}>
      <MonitorPerformance sensors={sensors} delayed sensorsDelayed={false} loading={false} historyControls={<p>Recorded range</p>} />
    </MemoryRouter>,
  );
  expect(html).toContain('Independent GPU');
  expect(html).toContain('27.0%');
  expect(html).not.toContain('Live readings are delayed.');
  expect(html).not.toContain('Recorded range');
});

test('impossible memory and swap counters cannot produce negative use or valid percentages', () => {
  const sample: Telemetry = {
    sampledAt: new Date().toISOString(),
    cpu: { scope: 'host-proc', totalPercent: 10, perCorePercent: [], uptimeSeconds: 100 },
    memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 101, swapTotalBytes: 50, swapFreeBytes: 60 },
    network: [],
    filesystems: [],
  };
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/monitor?section=performance&metric=memory']}>
      <MonitorPerformance sample={sample} delayed={false} sensorsDelayed={false} loading={false} historyControls={null} />
    </MemoryRouter>,
  );
  expect(html).toContain('In use · Unavailable');
  expect(html).toContain('<dt>Swap used</dt><dd>Unavailable</dd>');
  expect(html).not.toContain('-1 B');
  expect(html).not.toContain('-10 B');
});

test('existing Home Memory anchor renders the Memory chart even when an older CPU query is present', () => {
  for (const entry of ['/monitor#telemetry-memory-title', '/monitor?section=performance&metric=cpu&range=24h#telemetry-memory-title']) {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[entry]}>
        <MonitorPerformance delayed={false} sensorsDelayed={false} loading={false} historyControls={<p>Recorded range</p>} />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-labelledby="telemetry-memory-title"');
    expect(html).toContain('id="telemetry-memory-title">Memory</h2>');
    expect(html).toContain('Host memory utilisation');
    expect(html).toContain('Recorded range');
  }
});

test('the Network chart anchor selects Performance networking and exposes its recorded chart heading', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/monitor?section=performance&metric=cpu#monitor-network-history-title']}>
      <MonitorPerformance delayed={false} sensorsDelayed={false} loading={false} historyControls={null} />
    </MemoryRouter>,
  );
  expect(html).toContain('id="monitor-network-history-title" class="monitor-chart-subtitle">Network history</h3>');
  expect(html).not.toContain('id="telemetry-memory-title"');
});

test('the Home CPU deep link has a destination when total CPU readings are unavailable', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/monitor?section=performance&metric=memory#telemetry-cpu-title']}>
      <MonitorPerformance delayed={false} sensorsDelayed={false} loading={false} historyControls={null} />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-labelledby="telemetry-cpu-title"');
  expect(html).toContain('CPU readings are unavailable.');
  expect(html).not.toContain('id="telemetry-memory-title"');
});
