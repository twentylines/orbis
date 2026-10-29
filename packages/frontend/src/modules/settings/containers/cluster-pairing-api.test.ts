import { expect, test } from 'bun:test';
import { ClusterPairingError, createClusterInvitation, pairClusterServer, type ClusterPairRequest } from './cluster-pairing-api';

async function withFetch(response: Response, run: (calls: { url: unknown; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: { url: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return response;
    },
    { preconnect: original.preconnect },
  );
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const credentials = { password: 'fresh-password', totpCode: '123456' };
const certificate = {
  peerCertificatePem: '-----BEGIN CERTIFICATE-----\nMAIBAA==\n-----END CERTIFICATE-----\n',
  peerCertificateSha256: 'a'.repeat(64),
  confirmPeerCertificate: true as const,
};
const paired = { paired: true as const, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Peer', certificateSha256: 'a'.repeat(64) };

function pairBody(overrides: Partial<ClusterPairRequest> = {}): ClusterPairRequest {
  return { ...credentials, url: 'https://peer.private', code: 'A'.repeat(24), ...certificate, ...overrides };
}

test('invite uses fresh credentials in a same-origin bounded POST and validates its response', async () => {
  await withFetch(Response.json({ code: 'A'.repeat(24), expiresAt: '2026-10-29T10:00:00.000Z' }), async (calls) => {
    await expect(createClusterInvitation(credentials)).resolves.toEqual({ code: 'A'.repeat(24), expiresAt: '2026-10-29T10:00:00.000Z' });
    expect(calls[0]?.url).toBe('/api/cluster/invite');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(credentials);
    expect(String(calls[0]?.url)).not.toContain(credentials.password);
  });
});

test('pair sends reviewed certificate fields and optional fresh authentication code only in the body', async () => {
  await withFetch(Response.json(paired), async (calls) => {
    await expect(pairClusterServer(pairBody())).resolves.toEqual(paired);
    expect(calls[0]?.url).toBe('/api/cluster/pair');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(pairBody());
    expect(String(calls[0]?.url)).not.toContain('fresh-password');
  });
  await withFetch(Response.json({ paired: true, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Peer' }), async (calls) => {
    await pairClusterServer({ password: credentials.password, url: 'http://peer.private', code: 'A'.repeat(24), allowInsecureLan: true });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      password: credentials.password,
      url: 'http://peer.private',
      code: 'A'.repeat(24),
      allowInsecureLan: true,
    });
  });
});

test('only exact known backend pairing messages are surfaced', async () => {
  await withFetch(
    Response.json(
      { message: 'Cannot reach the paired server. Use a hostname matching its HTTPS certificate and check certificate trust and connection.' },
      { status: 503 },
    ),
    async () => {
      await expect(createClusterInvitation(credentials)).rejects.toThrow('Use a hostname matching its HTTPS certificate');
    },
  );
  for (const response of [
    Response.json({ message: 'private server detail with password=secret' }, { status: 400 }),
    Response.json({ message: ['Confirm pairing with your account password and authentication code if enabled.'] }, { status: 400 }),
    new Response('{', { status: 503 }),
  ]) {
    await withFetch(response, async () => {
      try {
        await createClusterInvitation(credentials);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ClusterPairingError);
        expect((error as Error).message).toBe('The cluster pairing request did not finish. Check the server address and try again.');
        expect((error as Error).message).not.toContain('secret');
      }
    });
  }
});

test('oversized responses are cancelled and malformed success shapes are refused', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(new Response(body, { status: 503 }), async () => {
    await expect(createClusterInvitation(credentials)).rejects.toThrow(ClusterPairingError);
  });
  expect(cancelled).toBe(true);
  await withFetch(Response.json({ paired: true, id: 'private', name: 'Peer' }), async () => {
    await expect(pairClusterServer(pairBody())).rejects.toThrow(ClusterPairingError);
  });
});

test('fresh authentication and operator failures return actionable safe messages', async () => {
  for (const [status, message] of [
    [401, 'Confirm your account password'],
    [403, 'operator browser session'],
  ] as const) {
    await withFetch(Response.json({ message: 'private authentication implementation detail' }, { status }), async () => {
      await expect(createClusterInvitation(credentials)).rejects.toThrow(message);
    });
  }
});

test('pair result must acknowledge the exact independently confirmed fingerprint', async () => {
  for (const result of [
    { ...paired, certificateSha256: 'b'.repeat(64) },
    { paired: true, id: paired.id, name: paired.name },
  ]) {
    await withFetch(Response.json(result), async () => {
      await expect(pairClusterServer(pairBody())).rejects.toThrow(ClusterPairingError);
    });
  }
});

test('actual sensitive-action HTTP400 translation keys give password and TOTP guidance', async () => {
  for (const [message, guidance] of [
    ['AUTH_ERROR_INVALID_PASSWORD', 'Check your account password'],
    ['AUTH_ERROR_TOTP_INVALID_CODE', 'current six-digit authentication code'],
  ] as const) {
    await withFetch(Response.json({ message }, { status: 400 }), async () => {
      await expect(createClusterInvitation(credentials)).rejects.toThrow(guidance);
    });
    await withFetch(Response.json({ message }, { status: 400 }), async () => {
      await expect(pairClusterServer(pairBody())).rejects.toThrow(guidance);
    });
  }
});
