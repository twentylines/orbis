import { expect, test } from 'bun:test';

test('advanced settings open immediately as an unsaved form draft', async () => {
  const child = Bun.spawn([process.execPath, new URL('./advanced-settings.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../../../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ toggleUpdatesDraft: true, noSaveOnToggle: true });
});
