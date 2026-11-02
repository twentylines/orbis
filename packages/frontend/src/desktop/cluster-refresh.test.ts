import { expect, test } from 'bun:test';

test('a refreshed cluster module retains the actual provider context', async () => {
  const child = Bun.spawn([process.execPath, new URL('./cluster-refresh.fixture.tsx', import.meta.url).pathname], {
    cwd: new URL('../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ separateModuleVersions: true, providerShared: true, missingProviderStillThrows: true });
});
