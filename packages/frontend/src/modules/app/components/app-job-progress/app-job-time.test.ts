import { test, expect } from 'bun:test';
import type { AppJob } from '@runtipi/common/schemas/app-job';
import { createServerClock, jobElapsed } from './app-job-time';

const job: AppJob = {
  requestId: '00000000-0000-4000-8000-000000000001',
  appUrn: 'demo:store' as AppJob['appUrn'],
  command: 'backup',
  status: 'running',
  startedAt: 10000,
  updatedAt: 20000,
  message: '',
  cancellable: true,
};
test('elapsed time advances between polls without trusting the browser wall clock', () => {
  let time = 0;
  const clock = createServerClock(() => time);
  clock.observe(20000);
  time += 5000;
  expect(jobElapsed(job, clock.now())).toBe('15s');
  clock.observe(20000);
  time += 5000;
  expect(jobElapsed(job, clock.now())).toBe('20s');
});
test('out-of-order polls cannot wind the elapsed display back', () => {
  let time = 0;
  const clock = createServerClock(() => time);
  clock.observe(20000);
  time += 5000;
  clock.observe(19000);
  expect(jobElapsed(job, clock.now())).toBe('15s');
});
test('unknown server time does not fabricate an elapsed estimate', () => {
  const clock = createServerClock(() => 0);
  clock.observe(Number.NaN);
  expect(jobElapsed(job, clock.now())).toBeNull();
});
test.each(['succeeded', 'failed', 'cancelled', 'interrupted'] as const)('freezes duration after %s', (status) => {
  expect(jobElapsed({ ...job, status }, 60000)).toBe('10s');
});
test('an invalid future start is unavailable rather than a negative duration', () => {
  expect(jobElapsed({ ...job, startedAt: 30000 }, 20000)).toBeNull();
});
