import { afterEach, expect, test } from 'bun:test';
import { frameworkCatalogueNotice, readFrameworkCatalogue } from './framework-catalogue';
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const signal = () => new AbortController().signal;
const empty = { schema: 'orbis.theme-framework-catalogue.v1', themes: [] };
function respond(value: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(value), { status })) as unknown as typeof fetch;
}
test('accepts real empty and stale validated catalogues, and preserves runtime availability', async () => {
  for (const status of ['ready', 'stale']) {
    respond({ status, catalogue: empty, checkedAt: '2026-11-03T00:00:00.000Z', runtimeAvailable: false });
    expect(await readFrameworkCatalogue(signal())).toMatchObject({ status, catalogue: empty, runtimeAvailable: false });
  }
  respond({ status: 'unavailable', catalogue: null, checkedAt: null, runtimeAvailable: false });
  expect((await readFrameworkCatalogue(signal())).status).toBe('unavailable');
});
test('rejects unsupported or malformed catalogues and surfaces authorization failure', async () => {
  respond({ status: 'ready', catalogue: { schema: 'future', themes: [] }, checkedAt: null, runtimeAvailable: false });
  await expect(readFrameworkCatalogue(signal())).rejects.toThrow();
  respond({ status: 'ready', catalogue: null, checkedAt: null, runtimeAvailable: false });
  await expect(readFrameworkCatalogue(signal())).rejects.toThrow();
  respond({}, 403);
  await expect(readFrameworkCatalogue(signal())).rejects.toThrow('operator');
});

test('mounted catalogue refresh retains stale data and stops while hidden or unmounted', async () => {
  const child = Bun.spawn([process.execPath, new URL('./framework-catalogue.fixture.tsx', import.meta.url).pathname], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toBe('mounted polling passed');
});

test('catalogue status prioritizes the error while preserving the stale-data explanation', () => {
  const stale = {
    status: 'stale' as const,
    catalogue: { ...empty, schema: 'orbis.theme-framework-catalogue.v1' as const },
    checkedAt: null,
    runtimeAvailable: false,
  };
  expect(frameworkCatalogueNotice(stale, 'Connection failed.')).toBe('Connection failed. Showing the last known catalogue.');
  expect(frameworkCatalogueNotice(stale, '')).toBe('Showing an older theme catalogue.');
  expect(frameworkCatalogueNotice(null, '')).toBe('Loading theme catalogue…');
});
