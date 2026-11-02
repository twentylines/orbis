import { expect, test } from 'bun:test';
import { Children, isValidElement } from 'react';
import { AutomaticUpdatesSettings, UpdateSchedules } from './automatic-updates-settings';
import { SystemUpdatesSettings } from './system-updates-settings';
const scenarios = [
  'policy-shared-draft',
  'policy-queued-session',
  'apps-queued-session',
  'core-queued-session',
  'system-queued-session',
  'policy-late-ack',
  'apps-late-ack',
  'core-late-ack',
  'system-late-ack',
  'apps-preserve-policy',
  'core-preserve-policy',
  'policy-newer-draft',
  'apps-newer-draft',
  'core-newer-draft',
  'system-newer-draft',
  'global-session-prepare',
  'global-session-error',
  'global-session-new-save',
  'global-unmount',
  'global-activity',
  'global-background-activity',
];
for (const scenario of scenarios) {
  test(`mounted update settings lifetime: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL(scenario.startsWith('global-') ? './global-settings-save.fixture.tsx' : './update-settings-save.fixture.tsx', import.meta.url)
          .pathname,
        scenario,
      ],
      {
        cwd: new URL('../../../../..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ scenario, mountedReact: true, network: false, layout: false });
  });
}

test('Orbis, app and system schedules are peer cards rather than nested inside one schedule', () => {
  const sections = Children.toArray(UpdateSchedules().props.children);
  expect(sections).toHaveLength(3);
  const [orbis, apps, system] = sections;
  expect(isValidElement(orbis) && orbis.type).toBe(AutomaticUpdatesSettings);
  expect(isValidElement<{ mode?: string }>(apps) && apps.type).toBe(AutomaticUpdatesSettings);
  expect(isValidElement<{ mode?: string }>(apps) && apps.props.mode).toBe('apps');
  expect(isValidElement(system) && system.type).toBe(SystemUpdatesSettings);
});
