import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SystemGauges } from './system-gauges';

const render = (clockGHz?: number | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SystemGauges cpu={10} clockGHz={clockGHz} memoryUsed={50} memoryTotal={100} diskUsed={10} diskTotal={100} diskLabel="Storage" />
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
