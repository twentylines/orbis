import { beforeEach, expect, it, vi } from 'vitest';
import { PasswordService } from './password.service';

let service: PasswordService;
beforeEach(() => {
  service = new PasswordService();
});

it('warms one random fallback with the ordinary password cost and reuses it for concurrent unknown-account checks', async () => {
  const hash = vi.spyOn(service, 'hash');
  const initializing = service.onModuleInit();
  const [one, two] = await Promise.all([service.loginFallbackHash(), service.loginFallbackHash()]);
  await initializing;
  expect(one).toBe(two);
  expect(hash).toHaveBeenCalledTimes(1);
  expect(hash.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(one).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  expect(await service.verify('not-the-random-fallback-password', one)).toBe(false);
});

it('uses a fresh random fallback for a fresh service instance', async () => {
  const [one, two] = await Promise.all([service.loginFallbackHash(), new PasswordService().loginFallbackHash()]);
  expect(one).not.toBe(two);
});
