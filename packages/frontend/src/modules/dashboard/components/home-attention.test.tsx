import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { HomeAttentionContent } from './home-attention';

const render = (props: Partial<Parameters<typeof HomeAttentionContent>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <HomeAttentionContent apps={[]} unhealthy={0} loading={false} unavailable={false} healthUnavailable={false} hasSystemAlert={false} {...props} />
    </MemoryRouter>,
  );

test('attention distinguishes unavailable readings from a clean state', () => {
  expect(render()).toContain('No alerts to review');
  const unavailable = render({ unavailable: true });
  expect(unavailable).toContain('Application status is unavailable.');
  expect(unavailable).not.toContain('No alerts to review');
  expect(render({ healthUnavailable: true })).toContain('Container health is unavailable.');
  expect(render({ healthPending: true })).not.toContain('No alerts to review');
  expect(render({ healthUnavailable: true })).not.toContain('No alerts to review');
});

test('health and app actions lead to the exact affected controls without conflating their status', () => {
  const html = render({
    unhealthy: 1,
    apps: [
      { urn: 'notes:community', id: 'notes', name: 'Notes', stopped: true },
      { urn: 'files:official', id: 'files', name: 'Files', stopped: false },
    ],
  });
  expect(html).toContain('/monitor?section=usage&amp;health=attention#containers');
  expect(html).toContain('1 app needs a health check');
  expect(html).toContain('/apps/community/notes');
  expect(html).toContain('/apps/official/files');
  expect(html).toContain('Stopped');
  expect(html).toContain('Update available');
  expect(html.match(/loading="lazy"/g)?.length).toBe(2);
  expect(html).toContain('Manage');
  expect(html).toContain('Review');
});

test('system alerts remain visible without stopped apps and larger lists retain a route to all apps', () => {
  expect(render({ hasSystemAlert: true, systemAlerts: <p>CPU temperature alert</p> })).toContain('CPU temperature alert');
  const html = render({
    apps: Array.from({ length: 8 }, (_, id) => ({ urn: `app${id}:official`, id: `app${id}`, name: `App ${id}`, stopped: true })),
  });
  expect(html).toContain('View all 8 applications');
  expect(html).not.toContain('App 6');
});

test('operator update actions go directly to the existing review for the affected app', () => {
  const html = render({
    canUpdate: true,
    apps: [
      { urn: 'stopped:official', id: 'stopped', name: 'Stopped app', stopped: true },
      { urn: 'ready:official', id: 'ready', name: 'Ready app', stopped: false },
    ],
  });
  expect(html).toContain('href="/apps/official/ready/update"');
  expect(html).toContain('>Update</span>');
  expect(html).toContain('href="/apps/official/stopped"');
  expect(html).not.toContain('/apps/official/stopped/update');
});
