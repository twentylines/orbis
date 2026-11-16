import { expect, test } from 'bun:test';

test('successful sign-in unmount preserves the shared morph while failure restores the real form', async () => {
  const child = Bun.spawn([process.execPath, new URL('./sign-in-morph.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ navigationKeepsPersistentMorph: true, failedHandoffRestoresFormOnce: true });
});
