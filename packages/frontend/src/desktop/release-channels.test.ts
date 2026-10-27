import { expect, test } from 'bun:test';
import { createAppQueryClient } from '@/lib/query-client';
import { enrollOrbisReleaseChannel, orbisReleaseChannelsOptions, ReleaseChannelRequestError, ReleaseChannelsStatusError } from './release-channels';

async function withResponse<T>(response: Response, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => response, { preconnect: originalFetch.preconnect }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function captureError(run: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await run();
    return new Error('Expected request to fail.');
  } catch (error) {
    return error;
  }
}

test('a host capability code gives the operator a safe installer action', async () => {
  await withResponse(
    Response.json({ code: 'host-channel-support-required', message: 'private internal exception details' }, { status: 503 }),
    async () => {
      const error = await captureError(() => enrollOrbisReleaseChannel('nightly', 'revision-1', true));
      expect(error).toBeInstanceOf(ReleaseChannelRequestError);
      expect(error).toMatchObject({
        message:
          'The host service needs an update to support release channels. Update the host service using the current installer, then retry this change.',
        canForce: false,
      });
      expect((error as Error).message).not.toContain('private internal');
    },
  );
});

test('unknown and malformed mutation errors never expose response text', async () => {
  await withResponse(Response.json({ code: 'unrecognized-code', message: 'internal stack trace' }, { status: 503 }), async () => {
    const error = await captureError(() => enrollOrbisReleaseChannel('stable', 'revision-2'));
    expect(error).toBeInstanceOf(ReleaseChannelRequestError);
    expect(error).toMatchObject({ message: 'The host could not complete the release channel request (HTTP 503). Try again.' });
    expect((error as Error).message).not.toContain('internal stack trace');
  });

  await withResponse(new Response('<html>private gateway detail</html>', { status: 502 }), async () => {
    const error = await captureError(() => enrollOrbisReleaseChannel('stable', 'revision-3'));
    expect(error).toBeInstanceOf(ReleaseChannelRequestError);
    expect((error as Error).message).toBe('The host could not complete the release channel request (HTTP 502). Try again.');
  });
});

test('the existing canForce signal remains available with allowlisted error parsing', async () => {
  await withResponse(Response.json({ code: 'other-code', canForce: true, message: 'internal compatibility detail' }, { status: 400 }), async () => {
    const error = await captureError(() => enrollOrbisReleaseChannel('stable', 'revision-4'));
    expect(error).toBeInstanceOf(ReleaseChannelRequestError);
    expect(error).toMatchObject({ canForce: true });
    expect((error as Error).message).toBe('The release channel request was rejected. Refresh the status and review the request before trying again.');
    expect((error as Error).message).not.toContain('internal compatibility detail');
  });
});

test('a channel storage error code gives a safe repair action on status reads', async () => {
  const options = orbisReleaseChannelsOptions();
  const queryFn = options.queryFn;
  if (!queryFn) throw new Error('Expected release channel query function.');

  await withResponse(
    Response.json({ code: 'channel-storage-invalid', message: 'private file path and policy internals' }, { status: 503 }),
    async () => {
      const error = await captureError(() =>
        queryFn({
          client: createAppQueryClient(),
          queryKey: options.queryKey,
          signal: new AbortController().signal,
          meta: undefined,
        }),
      );
      expect(error).toBeInstanceOf(ReleaseChannelsStatusError);
      expect(error).toMatchObject({
        status: 503,
        message: 'The private release channel settings need repair. Review the host service with the current installer before retrying.',
      });
      expect((error as Error).message).not.toContain('private file path');
    },
  );
});

test('unknown or malformed channel status bodies fall back to safe status copy', async () => {
  const options = orbisReleaseChannelsOptions();
  const queryFn = options.queryFn;
  if (!queryFn) throw new Error('Expected release channel query function.');

  await withResponse(Response.json({ code: ['channel-storage-invalid'], message: 'private details' }, { status: 503 }), async () => {
    const error = await captureError(() =>
      queryFn({
        client: createAppQueryClient(),
        queryKey: options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    );
    expect(error).toBeInstanceOf(ReleaseChannelsStatusError);
    expect(error).toMatchObject({
      status: 503,
      message: 'The host could not read release channel status (HTTP 503). Try again.',
    });
    expect((error as Error).message).not.toContain('private details');
  });

  await withResponse(new Response('not-json or private details', { status: 502 }), async () => {
    const error = await captureError(() =>
      queryFn({
        client: createAppQueryClient(),
        queryKey: options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
      }),
    );
    expect(error).toBeInstanceOf(ReleaseChannelsStatusError);
    expect((error as Error).message).toBe('The host could not read release channel status (HTTP 502). Try again.');
  });
});
