import { expect, test } from 'bun:test';
import { formatAutomaticUpdateServerTime, readAppUpdateSchedule, saveAppUpdateSchedule, saveAutomaticUpdateSettings } from './automatic-updates-api';

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
