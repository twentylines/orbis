import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { HostSensors } from '@runtipi/common/schemas';
import { GpuReadings } from './gpu-readings';

const data = {
  available: true,
  stale: false,
  gpus: [
    { id: 'gpu-one', label: 'Example Radeon', vendor: 'AMD', driver: 'amdgpu', utilizationPercent: 0, memoryUsedBytes: 1024, memoryTotalBytes: 4096 },
  ],
} as Extract<HostSensors, { available: true }>;

test('a measured zero is distinct from unsupported GPU utilisation and memory', () => {
  const actual = renderToStaticMarkup(<GpuReadings data={data} />);
  expect(actual).toContain('Example Radeon');
  expect(actual).toContain('0.0%');
  expect(actual).toContain('1.0 KB / 4.0 KB');
  const unknown = { ...data, gpus: [{ ...data.gpus[0], utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null }] } as Extract<
    HostSensors,
    { available: true }
  >;
  const unavailable = renderToStaticMarkup(<GpuReadings data={unknown} />);
  expect(unavailable).toContain('Not reported');
  expect(unavailable).not.toContain('<meter');
});

test('stale GPU evidence stays labelled and Home links to the GPU performance view', () => {
  const stale = renderToStaticMarkup(<GpuReadings data={data} stale />);
  expect(stale).toContain('Readings delayed');
  expect(stale).toContain('0.0%');
  const home = renderToStaticMarkup(
    <MemoryRouter>
      <GpuReadings data={data} compact />
    </MemoryRouter>,
  );
  expect(home).toContain('/monitor?section=performance&amp;metric=gpu');
  expect(home).toContain('Example Radeon');
  expect(renderToStaticMarkup(<GpuReadings data={{ available: false, reason: 'Host service unavailable' }} compact />)).toBe('');
});
