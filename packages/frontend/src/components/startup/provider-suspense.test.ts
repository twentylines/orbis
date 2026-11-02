import { expect, test } from 'bun:test';

test('the shared startup cover returns for provider suspension and clears after resuming', async () => {
  const child = Bun.spawn([process.execPath, new URL('./provider-suspense.fixture.tsx', import.meta.url).pathname], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: '', stdout: 'ready recovered' });
});
