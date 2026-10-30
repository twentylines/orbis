import { expect, test } from 'bun:test';
import { PreferenceSaveQueue, PreferenceSession } from './preference-save-queue';

const scenarios = [
  'batched-edit-commit',
  'newer-edit-during-save',
  'queued-account-switch',
  'autosave-account-switch',
  'onboarding-account-switch',
  'dirty-name-remote-refresh',
  'name-acknowledgement',
  'load-failure-recovery',
  'user-session-lifetime',
];
for (const scenario of scenarios) {
  test(`mounted preference lifecycle: ${scenario}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL(scenario === 'user-session-lifetime' ? './user-session-lifetime.fixture.tsx' : './preferences-save.fixture.tsx', import.meta.url)
          .pathname,
        scenario,
      ],
      {
        cwd: new URL('../..', import.meta.url).pathname,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ scenario, mountedReact: true, network: false, layout: false });
  });
}

test('session cancellation rejects queued work while a fresh session proceeds independently', async () => {
  const old = new PreferenceSession(true);
  const queue = new PreferenceSaveQueue(old.signal);
  let release!: () => void;
  const started = queue.enqueue(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  let ran = false;
  const waiting = queue
    .enqueue(async () => {
      ran = true;
    })
    .catch((error: unknown) => error);
  old.invalidate();
  const fresh = new PreferenceSession(true);
  expect(fresh.epoch).not.toBe(old.epoch);
  await new PreferenceSaveQueue(fresh.signal).enqueue(async () => {
    expect(fresh.signal.aborted).toBe(false);
  });
  release();
  await started;
  expect(await waiting).toBeInstanceOf(Error);
  expect(ran).toBe(false);
  expect(new PreferenceSession(false).signal.aborted).toBe(true);
});
