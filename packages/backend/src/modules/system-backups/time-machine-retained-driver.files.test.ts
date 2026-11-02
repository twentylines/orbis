import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeRetainedPhaseInput } from './time-machine-retained-driver';

it('accepts only a bounded exact phase capsule bound to the argument transaction', () => {
  const id = randomUUID();
  const input = (value: unknown) => Buffer.from(JSON.stringify(value));
  const capsule = { version: 1, transactionId: id, token: 'a'.repeat(64) };
  expect(decodeRetainedPhaseInput(id, 'prepare', input(capsule))).toEqual({ phase: 'prepare', token: capsule.token });
  for (const [arg, phase, bytes] of [
    [id, 'prepare', input({ ...capsule, transactionId: randomUUID() })],
    [id, 'prepare', input({ ...capsule, extra: true })],
    [id, 'prepare', input({ ...capsule, token: 'x'.repeat(64) })],
    [id, 'prepare', Buffer.alloc(4097)],
    [id, 'unknown', input(capsule)],
    ['invalid', 'prepare', input(capsule)],
  ] as const)
    expect(() => decodeRetainedPhaseInput(arg, phase, bytes)).toThrow();
});

it('reads the phase capsule from bounded stdin and rejects excess or cancelled input', async () => {
  const { Readable } = await import('node:stream');
  const { readRetainedPhaseInput } = await import('./time-machine-retained-driver');
  const id = randomUUID();
  const capsule = Buffer.from(JSON.stringify({ version: 1, transactionId: id, token: 'b'.repeat(64) }));
  const signal = new AbortController().signal;
  expect(await readRetainedPhaseInput(Readable.from([capsule.subarray(0, 5), capsule.subarray(5)]), id, 'verify', signal)).toEqual({
    phase: 'verify',
    token: 'b'.repeat(64),
  });
  await expect(readRetainedPhaseInput(Readable.from([Buffer.alloc(4097)]), id, 'verify', signal)).rejects.toThrow();
  const aborted = new AbortController();
  aborted.abort();
  await expect(readRetainedPhaseInput(Readable.from([capsule]), id, 'verify', aborted.signal)).rejects.toThrow();
});
