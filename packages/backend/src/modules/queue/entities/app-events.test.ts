import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { appEventSchema } from './app-events';

test.each([
  [{}, true],
  [{ performBackup: true }, true],
  [{ performBackup: false }, false],
])('keeps the default backup protection and explicit update choice: %j', (options, expected) => {
  const event = appEventSchema.assert({
    appUrn: 'demo:store',
    command: 'update',
    requestId: randomUUID(),
    form: {},
    ...options,
  });

  expect(event).toMatchObject({ command: 'update', performBackup: expected });
});
