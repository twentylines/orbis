import { expect, test } from 'bun:test';

test('Home has no capture warning banner while continuing to check an enabled receipt', async () => {
  const child = Bun.spawn([process.execPath, new URL('./setup-capture-notice.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ hiddenDuringFetch: true, hiddenAfterReenable: true, statusStillChecked: true });
});
