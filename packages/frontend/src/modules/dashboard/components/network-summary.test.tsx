import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NetworkSummary } from './home-system-status';
import { NetworkFacts } from './host-devices';
const network = {
  interface: 'enp1s0',
  state: 'up' as const,
  speedMbps: 1000,
  receivedBytes: 100,
  transmittedBytes: 200,
  rxBytesPerSecond: null,
  txBytesPerSecond: null,
  label: 'Network',
  scope: 'host' as const,
};
test('actual network summary renders measuring, numeric zero, and unavailable honestly', () => {
  const initial = renderToStaticMarkup(<NetworkSummary network={network} visible />);
  expect(initial.match(/Measuring…/g)).toHaveLength(2);
  expect(initial).toContain('enp1s0');
  expect(initial).toContain('1.0 Gbps');
  const zero = renderToStaticMarkup(<NetworkSummary network={{ ...network, rxBytesPerSecond: 0, txBytesPerSecond: 0 }} visible />);
  expect(zero.match(/0 B\/s/g)).toHaveLength(2);
  expect(zero).not.toContain('Measuring…');
  expect(renderToStaticMarkup(<NetworkSummary network={{ ...network, receivedBytes: null }} visible />)).toContain('Unavailable');
  expect(renderToStaticMarkup(<NetworkSummary network={null} visible />)).toContain('Unavailable');
});

test('detailed network facts use the same initial and zero presentation', () => {
  expect(renderToStaticMarkup(<NetworkFacts item={network} visible />).match(/Measuring…/g)).toHaveLength(2);
  const zero = renderToStaticMarkup(<NetworkFacts item={{ ...network, rxBytesPerSecond: 0, txBytesPerSecond: 0 }} visible />);
  expect(zero.match(/0 B\/s/g)).toHaveLength(2);
  expect(renderToStaticMarkup(<NetworkFacts item={{ ...network, receivedBytes: null }} visible />)).toContain('Unavailable');
});
