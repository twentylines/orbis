import { test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppJob } from '@runtipi/common/schemas/app-job';
import { AppJobCancel, AppJobProgress } from './app-job-progress';

const job: AppJob = {
  requestId: '00000000-0000-4000-8000-000000000001',
  appUrn: 'demo:store' as AppJob['appUrn'],
  command: 'backup',
  status: 'running',
  startedAt: 10000,
  updatedAt: 20000,
  message: '',
  phase: 'archiving',
  cancellable: true,
};
function render(value: AppJob | null, owner = '7') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (value) client.setQueryData(['app-job', owner, job.appUrn], value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppJobProgress owner={owner} appUrn={job.appUrn} />
    </QueryClientProvider>,
  );
}
test('shows actual backup phase and a distinct cancellation control', () => {
  const html = render(job);
  expect(html).toContain('Compressing backup');
  expect(html).toContain('Cancel operation');
  expect(html).not.toContain('Stop application');
  expect(html).not.toContain('%');
});
test('shows a noncancellable deployment without an enabled cancel control', () => {
  const html = render({ ...job, command: 'update', phase: 'publishing', cancellable: false });
  expect(html).toContain('Applying update');
  expect(html).toContain('Cancellation is unavailable');
  expect(html).not.toContain('Cancel operation');
});
test('cancelled operations do not invite retry or masquerade as failures', () => {
  const html = render({ ...job, status: 'cancelled', cancellable: false });
  expect(html).toContain('Cancelled');
  expect(html).not.toContain('Cancel operation');
  expect(html).not.toContain('Failed');
});
test('a pending cancellation is disabled and remains distinct from completion', () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AppJobCancel owner="7" appUrn={job.appUrn} requestId={job.requestId} cancellable={false} status="cancelling" />
    </QueryClientProvider>,
  );
  expect(html).toContain('Cancelling');
  expect(html).toContain('disabled');
  expect(html).not.toContain('Completed');
});
test('loading a new session cannot display another session’s job', () => {
  expect(render(null, '8')).not.toContain('Cancel operation');
});
