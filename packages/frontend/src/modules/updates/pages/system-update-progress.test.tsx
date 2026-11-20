import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SystemUpdateProgress, UpdateRequestError } from './system-update-progress';

test('running jobs show indeterminate progress and preserve real output without fabricating completion', () => {
  const html = renderToStaticMarkup(
    <SystemUpdateProgress
      job={{
        id: 'one',
        state: 'running',
        operationCount: 3,
        message: 'Unpacking packages',
        output: { text: 'real apt output', bytes: 15, truncated: false, updatedAt: null },
      }}
    />,
  );
  expect(html).toContain('Installing system updates');
  expect(html).toContain('Unpacking packages');
  expect(html).toMatch(/<progress[^>]*><\/progress>/);
  expect(html).not.toMatch(/<progress[^>]*value=/);
  expect(html).toContain('real apt output');
  expect(html).toContain('View live output');
});

test('a completed index refresh never claims packages were installed and terminal history stays optional', () => {
  const html = renderToStaticMarkup(
    <SystemUpdateProgress job={{ id: 'one', kind: 'refresh', state: 'complete', message: 'APT refreshed the package lists.' }} />,
  );
  expect(html).toContain('Update check complete');
  expect(html).not.toContain('System update complete');
  expect(html).not.toContain('<progress');
  expect(html).toContain('<details>');
  expect(html).not.toContain('<details open');
});

test('the exact capture interlock gets a recovery destination while other failures remain distinct', () => {
  const capture = renderToStaticMarkup(
    <MemoryRouter>
      <UpdateRequestError error={new Error('a protected controller capture requires completion or explicit reconciliation')} />
    </MemoryRouter>,
  );
  expect(capture).toContain('/settings?tab=time-machine');
  expect(capture).toContain('A Time Machine capture is holding system changes.');
  const other = renderToStaticMarkup(
    <MemoryRouter>
      <UpdateRequestError error={new Error('APT candidate changed')} />
    </MemoryRouter>,
  );
  expect(other).toContain('APT candidate changed');
  expect(other).not.toContain('Time Machine');
});
