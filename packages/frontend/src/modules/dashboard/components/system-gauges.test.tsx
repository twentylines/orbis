import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SystemGauges } from './system-gauges';

const render = (clockGHz?: number | null, gpus?: ComponentProps<typeof SystemGauges>['gpus']) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SystemGauges cpu={10} clockGHz={clockGHz} gpus={gpus} memoryUsed={50} memoryTotal={100} diskUsed={10} diskTotal={100} diskLabel="Storage" />
    </MemoryRouter>,
  );

test('Home retains actual reported CPU clock without substituting a nominal speed', () => {
  expect(render(3.456)).toContain('<dt>CPU clock</dt><dd>3.46 GHz</dd>');
  expect(render(0.4)).toContain('<dt>CPU clock</dt><dd>0.40 GHz</dd>');
});

test('Home clock row remains visible when the host does not report a valid frequency', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(render(value)).toContain('<dt>CPU clock</dt><dd>Unavailable</dd>');
  }
});

test('Home hides unavailable GPU utilisation but retains a reported idle GPU alongside the system dials', () => {
  const unavailable = [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 101].map((utilizationPercent, index) => ({
    id: `gpu${index}`,
    label: 'GPU',
    utilizationPercent,
  }));
  expect(render(undefined, unavailable)).not.toContain('metric=gpu');
  const html = render(undefined, [...unavailable, { id: 'card0', label: 'Graphics', utilizationPercent: 0 }]);
  expect(html).toContain('GPU, 0.0 percent');
  expect(html.indexOf('CPU,')).toBeLessThan(html.indexOf('GPU,'));
  expect(html.indexOf('GPU,')).toBeLessThan(html.indexOf('Memory,'));
  expect(html.match(/class="system-gauge"/g)?.length).toBe(4);
  expect(html).toContain('/monitor?section=performance&amp;metric=gpu');
});

test('multiple reporting GPUs have separate, correctly valued system dials', () => {
  const html = render(undefined, [
    { id: 'card0', label: 'GPU 0', utilizationPercent: 18.2 },
    { id: 'card1', label: 'GPU 1', utilizationPercent: 99 },
  ]);
  expect(html).toContain('GPU 1, 18.2 percent');
  expect(html).toContain('GPU 2, 99.0 percent, high');
});

test('a simulated preview reading is identified in the accessible GPU label', () => {
  const html = render(undefined, [{ id: 'preview', label: 'Preview GPU (simulated)', utilizationPercent: 24, simulated: true }]);
  expect(html).toContain('GPU, 24.0 percent, simulated preview');
});
