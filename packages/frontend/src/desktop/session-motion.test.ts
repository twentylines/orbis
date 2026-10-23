/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { sessionExitBootstrap } from './session-motion';

function firstPaint(saved: string | null, blocked = false) {
  const dataset: Record<string, string> = {};
  runInNewContext(sessionExitBootstrap, {
    document: { documentElement: { dataset } },
    Date: { now: () => 100000 },
    sessionStorage: {
      getItem(key: string) {
        expect(key).toBe('orbis-session-exit');
        if (blocked) throw new Error('Storage unavailable');
        return saved;
      },
    },
  });
  return dataset;
}

describe('logout wording before hydration', () => {
  test('keeps Logging off visible from the first reload paint', () => {
    expect(firstPaint('99500')).toEqual({ orbisSessionState: 'logging-out' });
  });

  test.each([null, '0', 'not-a-timestamp', '80000', '101000'])('normal boot ignores an absent or stale marker: %s', (saved) => {
    expect(firstPaint(saved)).toEqual({});
  });

  test('normal boot still works when session storage is unavailable', () => {
    expect(firstPaint('99500', true)).toEqual({});
  });
});
