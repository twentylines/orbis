import { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { expect, it, vi } from 'vitest';
import { retainedImageDocker } from './time-machine-retained-images';
it('forwards cancellation and the fixed Docker load request while retaining root storage preflight', async () => {
  const preflight = vi.fn(async () => undefined);
  const dial = vi.fn((options: Record<string, unknown>, callback: (error: unknown, value: unknown) => void) => {
    expect(options.path).toBe('/images/load?');
    expect(options.method).toBe('POST');
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    callback(null, Readable.from(['{}\n']));
  });
  const docker = { modem: { dial } } as unknown as Dockerode;
  const adapter = retainedImageDocker(docker, preflight);
  const signal = new AbortController().signal;
  await adapter.preflightLoad(1024, signal);
  const output = await adapter.load(Readable.from(['archive']), signal);
  const chunks: Buffer[] = [];
  for await (const chunk of output) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('{}\n');
  expect(preflight).toHaveBeenCalledWith(1024, signal);
  expect(dial).toHaveBeenCalledOnce();
});
it('aborts a pending load without waiting for a late Docker callback', async () => {
  let complete: ((error: unknown, value: unknown) => void) | undefined;
  const docker = {
    modem: {
      dial: (_options: unknown, callback: (error: unknown, value: unknown) => void) => {
        complete = callback;
      },
    },
  } as unknown as Dockerode;
  const adapter = retainedImageDocker(docker, async () => undefined);
  const abort = new AbortController();
  const source = Readable.from(['archive']);
  source.on('error', () => undefined);
  const result = adapter.load(source, abort.signal);
  abort.abort();
  await expect(result).rejects.toThrow();
  expect(source.destroyed).toBe(true);
  const late = Readable.from(['late']);
  complete?.(null, late);
  expect(late.destroyed).toBe(true);
});
