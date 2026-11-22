import { expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SystemGauges } from './system-gauges';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import english from '../../../../../backend/src/modules/i18n/translations/en.json';
import german from '../../../../../backend/src/modules/i18n/translations/de-DE.json';

const render = (
  clockGHz?: number | null,
  gpus?: ComponentProps<typeof SystemGauges>['gpus'],
  memoryScope?: ComponentProps<typeof SystemGauges>['memoryScope'],
) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SystemGauges
        cpu={10}
        clockGHz={clockGHz}
        gpus={gpus}
        memoryUsed={50}
        memoryTotal={100}
        memoryScope={memoryScope}
        diskUsed={10}
        diskTotal={100}
        diskLabel="Storage"
      />
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

test('estimated container memory is identified visibly and in the accessible reading', () => {
  const html = render(undefined, undefined, 'containers');
  expect(html).toContain('Memory, 50.0 percent, estimated');
  expect(html).toContain('<small>estimated</small>');
  expect(html).toContain('<dt>Memory · estimated</dt>');
  expect(html).toContain('Estimated Docker container memory');
  expect(html.match(/class="system-gauge"/g)?.length).toBe(3);
});

test('LXC and Core capacity retain their source while host memory remains unqualified', () => {
  expect(render(undefined, undefined, 'cgroup')).toContain('LXC memory, 50.0 percent');
  expect(render(undefined, undefined, 'runtime')).toContain('Core memory, 50.0 percent');
  const host = render(undefined, undefined, 'host-proc');
  expect(host).toContain('Memory, 50.0 percent');
  expect(host).not.toContain('<small>estimated</small>');
});

test('the estimate caption uses its supported translation and falls back without a raw key', async () => {
  for (const [language, caption] of [
    ['de-DE', 'geschätzt'],
    ['ar-SA', 'estimated'],
  ]) {
    const instance = createInstance();
    await instance
      .use(initReactI18next)
      .init({ lng: language, fallbackLng: 'en', resources: { en: { translation: english }, 'de-DE': { translation: german } } });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={instance}>
        <MemoryRouter>
          <SystemGauges cpu={0} memoryUsed={50} memoryTotal={100} memoryScope="containers" diskUsed={0} diskTotal={100} diskLabel="Storage" />
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(html).toContain(`<small>${caption}</small>`);
    expect(html).not.toContain('DASHBOARD_MEMORY_ESTIMATED');
  }
});
