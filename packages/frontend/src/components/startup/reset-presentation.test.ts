import { expect, test } from 'bun:test';
import { resetLoadingPresentation } from './reset-presentation';

test('reset loading distinguishes unknown status, a lost connection, confirmed stages and recovery', () => {
  expect(resetLoadingPresentation(null).message).not.toContain('unavailable');
  expect(resetLoadingPresentation({ state: 'checking', supported: true, unavailable: true }).message).toContain('connection was interrupted');
  expect(resetLoadingPresentation({ state: 'idle', supported: true }).stage).toBe('Checking reset');
  expect(resetLoadingPresentation({ state: 'resetting', supported: true, stage: 'verifying' }).stage).toBe('Verifying reset');
  expect(resetLoadingPresentation({ state: 'resetting', supported: true }).stage).toBe('Resetting preferences');
  expect(resetLoadingPresentation({ state: 'recovery', supported: true }).recovery).toBe(true);
  expect(resetLoadingPresentation({ state: 'resetting', supported: true, stage: 'recovering' }).title).toBe('Reset needs attention');
  expect(resetLoadingPresentation({ state: 'recovery', supported: true, unavailable: true }).recovery).toBe(false);
});
