import { expect, test } from 'bun:test';

test('Home suppresses stale capture actions while disabled or checking and restores them when enabled', async () => {
  const child = Bun.spawn([process.execPath, new URL('./setup-capture-notice.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ disabledSuppressed: true, fetchingSuppressed: true, reenabledVisible: true });
});
