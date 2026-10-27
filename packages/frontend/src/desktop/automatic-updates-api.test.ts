import { expect, test } from 'bun:test';
import { readAppUpdateSchedule, saveAppUpdateSchedule } from './automatic-updates-api';

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
