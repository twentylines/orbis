import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmartToolsInstaller } from './smart-tools-installer';

function markup(missing: boolean, job: object | null = null) {
  const client = new QueryClient();
  client.setQueryData(['smart-tools-job', 'local'], { available: true, job });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SmartToolsInstaller drivePath="/api/system/drives" missing={missing} visible={false} />
    </QueryClientProvider>,
  );
}

test('missing SMART tools offer the official package installation action', () => {
  const html = markup(true);
  expect(html).toContain('Install SMART tools');
  expect(html).toContain('official Ubuntu package');
  expect(html).toContain('btn btn-primary');
  expect(html).not.toContain('disabled=""');
  expect(markup(false)).not.toContain('Install SMART tools');
});

test('real pending package work disables repeat installation and exposes its status', () => {
  const html = markup(true, { id: 'job', kind: 'smart-tools', state: 'running' });
  expect(html).toContain('disabled=""');
  expect(html).toContain('Installing SMART tools');
  expect(html).toContain('Drive health will refresh when installation finishes');
  const unrelated = markup(true, { id: 'job', state: 'running' });
  expect(unrelated).toContain('disabled=""');
  expect(unrelated).toContain('Finish the current host package transaction');
});

test('failed installations retain their actionable host reason', () => {
  const html = markup(true, { id: 'job', kind: 'smart-tools', state: 'failed', message: 'APT stopped with an error.' });
  expect(html).toContain('role="alert"');
  expect(html).toContain('APT stopped with an error.');
  expect(html).toContain('disabled=""');
});
