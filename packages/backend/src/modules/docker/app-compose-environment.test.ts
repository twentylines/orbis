import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const execFile = Object.defineProperty(
    () => {
      throw new Error('Unexpected callback launch');
    },
    Symbol.for('nodejs.util.promisify.custom'),
    { value: execute },
  );
  return { ...actual, execFile };
});
import { readEffectiveAppCompose } from './app-volume-invocation';

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ stdout: JSON.stringify({ services: { web: { image: 'selected:1' } } }), stderr: '' });
  vi.stubEnv('ORBIS_CORE_PRIVATE_CANARY', 'synthetic-private-parent');
  vi.stubEnv('APP_INTERPOLATION_SENTINEL', 'synthetic-parent-app-override');
  vi.stubEnv('DOCKER_HOST', 'tcp://synthetic-context:2376');
  vi.stubEnv('DOCKER_CONTEXT', 'synthetic-other-context');
  vi.stubEnv('DOCKER_TLS_VERIFY', '1');
  vi.stubEnv('TZ', 'UTC');
  vi.stubEnv('LANG', 'synthetic-parent-locale');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
it('resolves explicit app/user files without inheriting Core or unrelated parent values', async () => {
  expect(await readEffectiveAppCompose(['--env-file', '/selected-app-values', '--file', '/selected-source'])).toMatchObject({
    services: { web: { image: 'selected:1' } },
  });
  const args = execute.mock.lastCall?.[1];
  const options = execute.mock.lastCall?.[2];
  expect(args).toEqual(['--env-file', '/selected-app-values', '--file', '/selected-source', 'config', '--format', 'json']);
  expect(options.env.ORBIS_CORE_PRIVATE_CANARY).toBeUndefined();
  expect(options.env.APP_INTERPOLATION_SENTINEL).toBeUndefined();
  expect(options.env.TZ).toBeUndefined();
  expect(options.env.LANG).toBeUndefined();
  expect(options.env.DOCKER_CONTEXT).toBe('synthetic-other-context');
  expect(process.env.ORBIS_CORE_PRIVATE_CANARY).toBe('synthetic-private-parent');
});
it('binds fresh configuration resolution to the local enrolled socket rather than an inherited remote context', async () => {
  await readEffectiveAppCompose(['--file', '/selected-source'], undefined, { resolveImageDigests: true, localSocket: true });
  expect(execute.mock.lastCall?.[2]?.env).toMatchObject({ DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '' });
  expect(execute.mock.lastCall?.[1]).toContain('--resolve-image-digests');
  expect(execute.mock.lastCall?.[2]?.env.ORBIS_CORE_PRIVATE_CANARY).toBeUndefined();
});
