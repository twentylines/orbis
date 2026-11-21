import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricPlot, type MetricPlotHistory } from './metric-plot';

const at = '2026-11-21T06:00:00Z';
const history = (average: number | null, peak = average): MetricPlotHistory => ({
  from: '2026-11-21T05:59:00Z',
  to: at,
  points: [{ at, until: at, intervalSeconds: 60, samples: average === null ? 0 : 1, value: { average, peak, samples: average === null ? 0 : 1 } }],
});
const render = (data?: MetricPlotHistory, loading = false) =>
  renderToStaticMarkup(<MetricPlot history={data} unit="bytesPerSecond" label="Download" color="currentColor" loading={loading} />);

test('empty and unavailable recorded charts suppress axes behind the padded status message', () => {
  for (const data of [undefined, history(null), { ...history(1), points: [] }]) {
    const html = render(data);
    expect(html).toContain('data-empty="true"');
    expect(html).toContain('class="metric-chart-scale" aria-hidden="true" hidden=""');
    expect(html).toContain('class="metric-chart-times" aria-hidden="true" hidden=""');
    expect(html).toContain('metric-chart-empty');
  }
  expect(render(undefined, true)).toContain('Loading history…');
});

test('recorded bandwidth axes use clean binary steps while preserving actual sample values', () => {
  const html = render(history(563));
  expect(html).not.toContain('data-empty');
  expect(html).not.toContain('metric-chart-empty');
  expect(html).toContain('<span>1.0 KB/s</span><span>512 B/s</span><span>0</span>');
  expect(html).toContain('Download 563 B/s');
  expect(render(history(1500))).toContain('<span>2.0 KB/s</span><span>1.0 KB/s</span>');
});
