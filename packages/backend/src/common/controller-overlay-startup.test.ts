import dotenv from 'dotenv';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['1', '0', true],
  ['0', '1', false],
  ['', '1', false],
  ['true', '1', false],
] as const)('keeps the captured runtime policy when persisted settings replace %s with %s', async (runtime, persisted, expected) => {
  vi.resetModules();
  vi.stubEnv('ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS', runtime);
  const { controllerOverlayStartup } = await import('./controller-overlay-startup');
  dotenv.populate(process.env as Record<string, string>, { ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS: persisted }, { override: true });
  expect(process.env.ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS).toBe(persisted);
  expect(controllerOverlayStartup()).toBe(expected);
});
