import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import * as Tabs from '@radix-ui/react-tabs';
import { MonitorChartLink, MonitorWorkspace, monitorMetricForHash, monitorSection, monitorSections } from './monitor-navigation';

describe('Monitor category navigation', () => {
  test('opens Overview by default and preserves explicitly requested categories', () => {
    expect(monitorSection(null, '')).toBe('overview');
    expect(monitorSection('unknown', '')).toBe('overview');
    for (const { value } of monitorSections) expect(monitorSection(value, '')).toBe(value);
  });

  test('existing deep links reveal their owning panel even when a different category was saved', () => {
    const links = {
      '#drive-health-title': 'drives',
      '#telemetry-cpu-title': 'performance',
      '#telemetry-memory-title': 'performance',
      '#monitor-network-history-title': 'performance',
      '#host-storage-title': 'devices',
      '#host-network-title': 'devices',
      '#host-disk-activity-title': 'devices',
      '#device-history': 'devices',
      '#telemetry-disks-title': 'devices',
      '#telemetry-network-title': 'devices',
      '#sensors': 'sensors',
      '#host-temperatures-title': 'sensors',
      '#host-fans-title': 'sensors',
      '#host-gpus-title': 'sensors',
      '#containers': 'usage',
      '#processes': 'usage',
    } as const;
    for (const [hash, expected] of Object.entries(links)) expect(monitorSection('overview', hash)).toBe(expected);
    expect(monitorSection('performance', '#unknown')).toBe('performance');
  });

  test('overview links preserve the server, history range and unrelated params while targeting the exact resource', async () => {
    const overview = '/monitor?section=overview&metric=gpu&range=24h&server=nas&hostDevice=disk%3Anvme0';
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[overview]}>
        <dl>
          <div>
            <dt>
              <MonitorChartLink resource="cpu">CPU</MonitorChartLink>
            </dt>
            <dd>47%</dd>
          </div>
          <div>
            <dt>
              <MonitorChartLink resource="memory">Memory</MonitorChartLink>
            </dt>
            <dd>63%</dd>
          </div>
          <div>
            <dt>
              <MonitorChartLink resource="network">Network</MonitorChartLink>
            </dt>
            <dd>12 MB/s</dd>
          </div>
          <div>
            <dt>
              <MonitorChartLink resource="storage">Storage</MonitorChartLink>
            </dt>
            <dd>36%</dd>
          </div>
          <div>
            <dt>
              <MonitorChartLink resource="storage" coreStorage>
                Core storage
              </MonitorChartLink>
            </dt>
            <dd>28%</dd>
          </div>
        </dl>
      </MemoryRouter>,
    );
    const links: URL[] = [];
    await new HTMLRewriter()
      .on('dl > div > dt > a[href]', {
        element(element) {
          const href = element.getAttribute('href');
          if (href) links.push(new URL(href.replaceAll('&amp;', '&'), 'https://monitor.example.test'));
        },
      })
      .transform(new Response(markup))
      .text();
    expect(links.map((link) => [link.searchParams.get('section'), link.searchParams.get('metric'), link.hash])).toEqual([
      ['performance', 'cpu', '#telemetry-cpu-title'],
      ['performance', 'memory', '#telemetry-memory-title'],
      ['performance', 'network', '#monitor-network-history-title'],
      ['devices', 'gpu', '#host-storage-title'],
      ['devices', 'gpu', '#telemetry-disks-title'],
    ]);
    for (const link of links) {
      expect(link.pathname).toBe('/monitor');
      expect(link.searchParams.get('server')).toBe('nas');
      expect(link.searchParams.get('range')).toBe('24h');
      expect(link.searchParams.get('hostDevice')).toBe('disk:nvme0');
      expect(monitorSection(link.searchParams.get('section'), link.hash)).toBe(link.searchParams.get('section') as ReturnType<typeof monitorSection>);
      if (link.searchParams.get('section') === 'performance')
        expect(monitorMetricForHash(link.hash)).toBe(link.searchParams.get('metric') as 'cpu' | 'memory' | 'network');
    }
  });

  test('sidebar tabs and compact picker share the active panel and expose a vertical keyboard model', async () => {
    for (const current of ['overview', 'performance'] as const) {
      const markup = renderToStaticMarkup(
        <MonitorWorkspace section={current} onSection={() => {}}>
          {monitorSections.map(({ value, label }) => (
            <Tabs.Content key={value} value={value}>
              <h2>{label} readings</h2>
            </Tabs.Content>
          ))}
        </MonitorWorkspace>,
      );
      const tabs: { state: string | null; selected: string | null; controls: string | null }[] = [];
      const panels: { id: string | null; state: string | null; hidden: boolean }[] = [];
      let compactLabel = '';
      const orientations: string[] = [];
      await new HTMLRewriter()
        .on('[role="tablist"]', {
          element(element) {
            const orientation = element.getAttribute('aria-orientation');
            if (orientation) orientations.push(orientation);
          },
        })
        .on('[role="tab"]', {
          element(element) {
            tabs.push({
              state: element.getAttribute('data-state'),
              selected: element.getAttribute('aria-selected'),
              controls: element.getAttribute('aria-controls'),
            });
          },
        })
        .on('[role="tabpanel"]', {
          element(element) {
            panels.push({ id: element.getAttribute('id'), state: element.getAttribute('data-state'), hidden: element.hasAttribute('hidden') });
          },
        })
        .on('.monitor-section-select .orbis-select-value', {
          text(chunk) {
            compactLabel += chunk.text;
          },
        })
        .transform(new Response(markup))
        .text();
      expect(orientations).toEqual(['vertical']);
      expect(tabs).toHaveLength(6);
      expect(tabs.filter((tab) => tab.selected === 'true')).toHaveLength(1);
      const active = tabs.find((tab) => tab.selected === 'true');
      expect(panels.filter((panel) => !panel.hidden)).toEqual([{ id: active?.controls ?? null, state: 'active', hidden: false }]);
      const label = monitorSections.find(({ value }) => value === current)?.label ?? '';
      expect(label).not.toBe('');
      expect(compactLabel.trim()).toBe(label);
      expect(markup).toContain('aria-label="Monitor section"');
      expect(markup).toContain(`${monitorSections.find(({ value }) => value === current)?.label} readings`);
    }
  });
});
