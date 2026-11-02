import { expect, it } from 'vitest';
import { parseRestoreWorkerArguments } from './backup-restore-worker-arguments';
const id = '11111111-1111-4111-8111-111111111111';
it('accepts only the existing exact legacy invocation', () => {
  expect(parseRestoreWorkerArguments([id])).toBe(id);
  for (const args of [[], ['invalid'], [id, '--retained-phase', 'prepare'], [id, '--retained-phase', 'commit'], [id, '--unknown']])
    expect(() => parseRestoreWorkerArguments(args)).toThrow();
});
