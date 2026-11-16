import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BatteryDetails,
  BatteryGlyph,
  HostBatteryButton,
  batteryPanelPosition,
  batteryStateLabel,
  batteryTimeLabel,
  visibleHostBattery,
} from './host-battery';

describe('host battery indicator', () => {
  it('provides a native named details trigger with its collapsed dialog state', () => {
    const markup = renderToStaticMarkup(<HostBatteryButton battery={{ percent: 67, charging: true }} />);
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('Host battery 67%, charging. Battery details');
    expect(markup).not.toContain('desktop-battery-details');
  });

  it('shows measured health, capacity, power and charge estimates without inventing missing fields', () => {
    const markup = renderToStaticMarkup(
      <BatteryDetails
        battery={{
          percent: 67,
          charging: true,
          state: 'charging',
          healthPercent: 90,
          energyNowWh: 30.2,
          energyFullWh: 45,
          energyDesignWh: 50,
          powerWatts: 12.5,
          timeRemainingSeconds: 5400,
          cycleCount: 120,
        }}
      />,
    );
    expect(markup).toContain('90%');
    expect(markup).toContain('30.2 Wh stored');
    expect(markup).toContain('45 Wh / 50 Wh design');
    expect(markup).toContain('Charging power');
    expect(markup).toContain('12.5 W');
    expect(markup).toContain('Time to full');
    expect(markup).toContain('1h 30m');
    expect(markup).toContain('Estimated');
    expect(markup).toContain('Charge cycles');
    expect(markup).toContain('120');
    const legacy = renderToStaticMarkup(<BatteryDetails battery={{ percent: 45, charging: false }} />);
    expect(legacy).toContain('Not charging');
    expect(legacy.match(/Unavailable/g)).toHaveLength(4);
    expect(legacy).not.toContain('Charge cycles');
    expect(legacy).not.toContain('Wh');
    expect(legacy).not.toContain('estimated');
  });

  it('only labels a time estimate when its direction is known', () => {
    expect(batteryTimeLabel({ percent: 50, charging: false, state: 'discharging', timeRemainingSeconds: 7199 })).toEqual({
      label: 'Time remaining',
      value: '2h estimated',
    });
    expect(batteryTimeLabel({ percent: 50, charging: true, timeRemainingSeconds: 90 })).toEqual({ label: 'Time to full', value: '2m estimated' });
    for (const state of ['idle', 'full', 'unknown'] as const) {
      expect(batteryTimeLabel({ percent: 50, charging: false, state, timeRemainingSeconds: 5400 }).value).toBe('Unavailable');
    }
    for (const timeRemainingSeconds of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(batteryTimeLabel({ percent: 50, charging: true, timeRemainingSeconds }).value).toBe('Unavailable');
    }
    expect(batteryStateLabel({ percent: 100, charging: false, state: 'full' })).toBe('Fully charged');
    expect(batteryStateLabel({ percent: 50, charging: null })).toBe('Power state unavailable');
    const markup = renderToStaticMarkup(<BatteryDetails battery={{ percent: 20, charging: false, state: 'discharging', powerWatts: 0 }} />);
    expect(markup).toContain('Discharge rate');
    expect(markup).toContain('0 W');
  });

  it('centres the popup when room permits and keeps both narrow viewport gutters', () => {
    expect(batteryPanelPosition({ left: 600, right: 664, bottom: 60 }, 320, 1280)).toEqual({ left: 472, top: 68 });
    for (const viewportWidth of [320, 390]) {
      const width = Math.min(320, viewportWidth - 32);
      for (const left of [0, viewportWidth - 64]) {
        const position = batteryPanelPosition({ left, right: left + 64, bottom: 72 }, width, viewportWidth);
        expect(position.left).toBeGreaterThanOrEqual(16);
        expect(position.left + width).toBeLessThanOrEqual(viewportWidth - 16);
      }
    }
  });

  it('labels the actual percentage and distinguishes charging and low readings', () => {
    const charging = renderToStaticMarkup(<BatteryGlyph battery={{ percent: 12, charging: true }} />);
    expect(charging).toContain('Host battery 12%, charging');
    expect(charging).toContain('data-state="charging"');
    expect(charging).toContain('desktop-battery-charging');
    expect(charging).toContain('--battery-level:12%');
    const low = renderToStaticMarkup(<BatteryGlyph battery={{ percent: 0, charging: false }} />);
    expect(low).toContain('Host battery 0%, not charging');
    expect(low).toContain('data-state="critical"');
    const warning = renderToStaticMarkup(<BatteryGlyph battery={{ percent: 20, charging: false }} />);
    expect(warning).toContain('data-state="low"');
    const unknown = renderToStaticMarkup(<BatteryGlyph battery={{ percent: 100, charging: null }} />);
    expect(unknown).toContain('Host battery 100%');
    expect(unknown).not.toContain('not charging');
    expect(unknown).toContain('>100</span>');
    expect(unknown).not.toContain('desktop-battery-number-filled');
    const panel = renderToStaticMarkup(<BatteryGlyph battery={{ percent: 76, charging: false }} variant="panel" />);
    expect(panel).toContain('data-variant="panel"');
    expect(panel).toContain('desktop-battery-panel-number');
    expect(panel).toContain('Host battery 76%, not charging');
  });

  it('hides missing, stale, unavailable and failed readings', () => {
    const sample = {
      available: true as const,
      sampledAt: new Date().toISOString(),
      stale: false,
      battery: { percent: 40, charging: null },
      filesystems: [],
      network: [],
      disks: [],
      omitted: { filesystems: 0, network: 0, disks: 0 },
      unavailable: [],
    };
    const now = Date.now();
    const previous = visibleHostBattery(sample, false, null, now, now);
    expect(previous?.battery).toEqual(sample.battery);
    expect(visibleHostBattery({ ...sample, battery: null }, false, previous, now, now)).toBeNull();
    expect(visibleHostBattery({ ...sample, battery: undefined }, false, previous, now, now)).toBeNull();
    expect(visibleHostBattery({ ...sample, stale: true }, false, previous, now + 60_000, now + 60_000)).toEqual(previous);
    expect(visibleHostBattery({ available: false, reason: 'Collecting host readings.' }, false, previous, now + 60_000, now + 60_000)).toEqual(
      previous,
    );
    expect(visibleHostBattery({ ...sample, stale: true }, false, previous, now + 91_000, now + 91_000)).toBeNull();
    expect(visibleHostBattery({ available: false, reason: 'unavailable' }, false, previous, now, now)).toBeNull();
    expect(visibleHostBattery(sample, true, previous, now, now)).toBeNull();
  });

  it('uses client receipt age without comparing clocks on different machines', () => {
    const now = Date.now();
    const sample = {
      available: true as const,
      sampledAt: new Date(now + 3_600_000).toISOString(),
      stale: false,
      battery: { percent: 52, charging: false },
      filesystems: [],
      network: [],
      disks: [],
      omitted: { filesystems: 0, network: 0, disks: 0 },
      unavailable: [],
    };
    expect(visibleHostBattery(sample, false, null, now, now)?.battery).toEqual(sample.battery);
    expect(visibleHostBattery({ ...sample, sampledAt: new Date(now - 3_600_000).toISOString() }, false, null, now, now)?.battery).toEqual(
      sample.battery,
    );
    expect(visibleHostBattery(sample, false, null, now - 90_001, now)).toBeNull();
    expect(visibleHostBattery(sample, false, null, now + 1, now)).toBeNull();
  });
});
