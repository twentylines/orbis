import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Tabs from '@radix-ui/react-tabs';
import { MonitorWorkspace, monitorSection, monitorSections } from './monitor-navigation';

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
