import { expect, test } from 'bun:test';
import {
  formatAutomaticUpdateServerTime,
  readAppUpdateSchedule,
  saveAppUpdateSchedule,
  saveAutomaticUpdateSettings,
  readAutomaticUpdateSettings,
  hasIndependentUpdateSchedules,
  saveSystemUpdateSchedule,
  readSystemUpdateSchedule,
} from './automatic-updates-api';

async function withResponse(response: Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => response, { preconnect: original.preconnect });
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a gateway HTML response produces a readable schedule error', async () => {
  await withResponse(new Response('<html>Gateway unavailable</html>', { status: 502 }), async () => {
    await expect(readAppUpdateSchedule('reader:store')).rejects.toThrow('Update preferences could not be read. Try again.');
  });
  await withResponse(new Response('<html>Gateway unavailable</html>', { status: 502 }), async () => {
    await expect(saveAppUpdateSchedule('reader:store', { mode: 'disabled' })).rejects.toThrow('The update schedule could not be saved. Try again.');
  });
});

test('an empty successful response cannot silently replace saved preferences', async () => {
  await withResponse(new Response('', { status: 200 }), async () => {
    await expect(readAppUpdateSchedule('reader:store')).rejects.toThrow('Update preferences could not be read. Try again.');
  });
});

test('a server validation message is preserved for the user', async () => {
  await withResponse(Response.json({ message: 'Choose a valid custom daily time.' }, { status: 400 }), async () => {
    await expect(saveAppUpdateSchedule('reader:store', { mode: 'custom', time: '' })).rejects.toThrow('Choose a valid custom daily time.');
  });
});

test('saving a daily time sends no browser timezone and preserves the disabled opt-in', async () => {
  const original = globalThis.fetch;
  let submitted: unknown;
  globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, request?: RequestInit) => {
      submitted = JSON.parse(String(request?.body));
      return Response.json({
        available: true,
        settings: { orbis: { enabled: false, mode: 'scheduled' }, schedule: { time: '08:09', timezone: 'Asia/Singapore' } },
        serverTime: { now: Date.parse('2026-10-27T03:20:00Z'), timezone: 'Asia/Singapore' },
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    const result = await saveAutomaticUpdateSettings({
      orbis: { enabled: false, mode: 'scheduled' },
      schedule: { time: '08:09', timezone: 'America/New_York' },
    });
    expect(submitted).toEqual({ orbis: { enabled: false, mode: 'scheduled' }, schedule: { time: '08:09' } });
    expect(result.settings.orbis.enabled).toBe(false);
    expect(result.serverTime?.timezone).toBe('Asia/Singapore');
  } finally {
    globalThis.fetch = original;
  }
});

test('server clock formatting uses the server timezone and elapsed time, with minute precision', () => {
  const now = Date.parse('2026-10-27T03:20:00Z');
  expect(formatAutomaticUpdateServerTime({ now, timezone: 'Asia/Singapore' })).toBe('11:20');
  expect(formatAutomaticUpdateServerTime({ now, timezone: 'UTC' })).toBe('03:20');
  expect(formatAutomaticUpdateServerTime({ now, timezone: 'Asia/Singapore' }, 60_000)).toBe('11:21');
  expect(formatAutomaticUpdateServerTime({ now: Date.parse('2026-11-01T05:45:00Z'), timezone: 'America/New_York' }, 60 * 60_000)).toBe('01:45');
  expect(formatAutomaticUpdateServerTime({ now, timezone: 'Asia/Singapore' }, -1)).toBeNull();
  expect(formatAutomaticUpdateServerTime({ now, timezone: 'Asia/Singapore' }, Number.POSITIVE_INFINITY)).toBeNull();
});

test.each(
  [
    null,
    [],
    123,
    { now: -1, timezone: 'UTC' },
    { now: 8_640_000_000_000_001, timezone: 'UTC' },
    { now: '123', timezone: 'UTC' },
    { now: 1.5, timezone: 'UTC' },
    { now: 123, timezone: '' },
    { now: 123, timezone: 'invalid/server-zone' },
    { now: 123, timezone: 'a'.repeat(101) },
    { now: 123, timezone: 'UTC', unexpected: 'rejected' },
  ].map((serverTime) => ({ serverTime })),
)('invalid or unbounded server clock metadata fails safely: %#', async ({ serverTime }) => {
  await withResponse(Response.json({ rule: { mode: 'disabled' }, available: true, serverTime }), async () => {
    await expect(readAppUpdateSchedule('reader:store')).rejects.toThrow('The server time could not be read safely.');
  });
});

test('independent schedule capability is absent on older backends and never inferred from shared time', async () => {
  await withResponse(
    Response.json({ available: true, settings: { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } } }),
    async () => {
      const result = await readAutomaticUpdateSettings();
      expect(hasIndependentUpdateSchedules(result)).toBe(false);
    },
  );
});
test('independent Orbis and app times serialize separately, without browser timezone or mutation-context leakage', async () => {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  const settings = { orbis: { enabled: false, mode: 'scheduled' as const }, apps: { enabled: true }, schedule: { time: '04:00', timezone: 'UTC' } };
  globalThis.fetch = Object.assign(
    async (_url: unknown, request?: RequestInit) => {
      calls.push(JSON.parse(String(request?.body)));
      return Response.json({
        available: true,
        settings,
        revision: 3,
        capabilities: ['independent-schedules.v1'],
        orbisSchedule: { time: '03:00', timezone: 'UTC' },
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    const result = await saveAutomaticUpdateSettings(settings, { orbisSchedule: { time: '03:00' }, expectedRevision: 2 });
    expect(hasIndependentUpdateSchedules(result)).toBe(true);
    expect(calls[0]).toEqual({
      orbis: settings.orbis,
      apps: settings.apps,
      schedule: { time: '04:00' },
      orbisSchedule: { time: '03:00' },
      expectedRevision: 2,
    });
    await saveAutomaticUpdateSettings(settings, { client: {} } as never);
    expect(calls[1]).toEqual({ orbis: settings.orbis, apps: settings.apps, schedule: { time: '04:00' } });
  } finally {
    globalThis.fetch = original;
  }
});
test('system configuration is explicit and serializers retain only chosen time and revision', async () => {
  const original = globalThis.fetch;
  let submitted: unknown;
  globalThis.fetch = Object.assign(
    async (_url: unknown, request?: RequestInit) => {
      submitted = JSON.parse(String(request?.body));
      return Response.json({
        available: true,
        settings: { enabled: true, schedule: { time: '05:00', timezone: 'UTC' } },
        revision: 4,
        capabilities: ['independent-schedules.v1'],
        shared: { time: '04:00', timezone: 'UTC' },
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    const result = await saveSystemUpdateSchedule({ enabled: true, schedule: { time: '05:00' }, expectedRevision: 3 });
    expect(submitted).toEqual({ enabled: true, schedule: { time: '05:00' }, expectedRevision: 3 });
    expect(result.settings.schedule?.time).toBe('05:00');
    expect(result.shared.time).toBe('04:00');
  } finally {
    globalThis.fetch = original;
  }
});
test('new capability with missing or invalid independent schedule metadata fails closed', async () => {
  for (const metadata of [
    { revision: -1, orbisSchedule: { time: '03:00', timezone: 'UTC' } },
    { revision: 0 },
    { revision: 0, orbisSchedule: { time: '25:00', timezone: 'UTC' } },
    { revision: 0, orbisSchedule: { time: '03:00', timezone: 'invalid/server' } },
  ])
    await withResponse(Response.json({ capabilities: ['independent-schedules.v1'], ...metadata }), async () => {
      await expect(
        saveAutomaticUpdateSettings({ orbis: { enabled: false, mode: 'idle' }, schedule: { time: '04:00', timezone: 'UTC' } }),
      ).rejects.toThrow('independent update schedule');
    });
});

test('a cancelled settings lifetime cannot dispatch either schedule read or write', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const controller = new AbortController();
  controller.abort(new DOMException('Session ended', 'AbortError'));
  const settings = { orbis: { enabled: false, mode: 'idle' as const }, schedule: { time: '04:00', timezone: 'UTC' } };
  try {
    await expect(readAutomaticUpdateSettings(controller.signal)).rejects.toThrow('Session ended');
    await expect(readSystemUpdateSchedule(controller.signal)).rejects.toThrow('Session ended');
    await expect(saveAutomaticUpdateSettings(settings, {}, controller.signal)).rejects.toThrow('Session ended');
    await expect(saveSystemUpdateSchedule({ enabled: false }, controller.signal)).rejects.toThrow('Session ended');
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});

test('all schedule requests carry the captured signal and reject a response delivered after cancellation', async () => {
  const original = globalThis.fetch;
  const signals: Array<AbortSignal | null | undefined> = [];
  const releases: Array<(response: Response) => void> = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>((resolve) => releases.push(resolve));
    },
    { preconnect: original.preconnect },
  );
  const controller = new AbortController();
  const settings = { orbis: { enabled: false, mode: 'idle' as const }, schedule: { time: '04:00', timezone: 'UTC' } };
  try {
    const pending = [
      readAutomaticUpdateSettings(controller.signal),
      readSystemUpdateSchedule(controller.signal),
      saveAutomaticUpdateSettings(settings, {}, controller.signal),
      saveSystemUpdateSchedule({ enabled: false }, controller.signal),
    ].map((request) => request.catch((error: unknown) => error));
    expect(signals).toHaveLength(4);
    controller.abort(new DOMException('Session ended', 'AbortError'));
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    for (const release of releases) release(Response.json({}));
    for (const result of await Promise.all(pending)) expect(result).toBeInstanceOf(DOMException);
  } finally {
    globalThis.fetch = original;
  }
});

test('system schedule helper still ignores a mutation context rather than treating it as a cancellation signal', async () => {
  const original = globalThis.fetch;
  let submitted: unknown;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return Response.json({ available: true, settings: { enabled: false, schedule: null } });
    },
    { preconnect: original.preconnect },
  );
  try {
    await saveSystemUpdateSchedule({ enabled: false }, { client: {} } as never);
    expect(submitted).toEqual({ enabled: false });
  } finally {
    globalThis.fetch = original;
  }
});
