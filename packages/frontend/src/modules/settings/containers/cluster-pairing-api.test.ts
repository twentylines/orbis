import { expect, test } from 'bun:test';
import {
  ClusterPairingError,
  createClusterInvitation,
  pairClusterServer,
  type ClusterPairRequest,
  connectClusterServer,
  completeClusterPairing,
  clusterPairingAccess,
} from './cluster-pairing-api';

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
        expect((error as Error).message).toBe('The pairing code could not be created. Try again and check this server’s status.');
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

const connection = () => ({
  pendingId: 'c'.repeat(64),
  id: paired.id,
  name: 'Other',
  origin: 'https://peer.example.test',
  totpRequired: true,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
test('connect requests remote authorization only after verified HTTPS succeeds, with no remote password sent', async () => {
  const body = { ...pairBody(), url: 'https://peer.example.test' };
  const expected = connection();
  await withFetch(Response.json(expected), async (calls) => {
    await expect(connectClusterServer(body)).resolves.toEqual(expected);
    expect(calls[0]?.url).toBe('/api/cluster/pairing/connect');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
  });
  await withFetch(Response.json(expected), async (calls) => {
    await expect(connectClusterServer({ ...body, url: 'http://peer.example.test', allowInsecureLan: true })).rejects.toThrow('HTTPS');
    expect(calls).toHaveLength(0);
  });
});
test('remote credentials go only to the same-origin completion endpoint with the pending binding', async () => {
  const body = { pendingId: connection().pendingId, password: 'remote-test-password', totpCode: '123456' };
  await withFetch(Response.json(paired), async (calls) => {
    await expect(completeClusterPairing(body)).resolves.toEqual(paired);
    expect(calls[0]?.url).toBe('/api/cluster/pairing/complete');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(body);
  });
});
test('changed remote origin, malformed or expired challenge never becomes a credential prompt', async () => {
  for (const change of [
    { origin: 'https://unrelated.example' },
    { pendingId: 'bad' },
    { totpRequired: 'yes' },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    await withFetch(Response.json({ ...connection(), ...change }), async () => {
      await expect(connectClusterServer({ ...pairBody(), url: 'https://peer.example.test' })).rejects.toThrow(ClusterPairingError);
    });
  }
});
test('Origin, throttling and storage errors use distinct short guidance', async () => {
  for (const [status, message, expected] of [
    [403, 'Invalid request origin. private proxy detail', 'server address check'],
    [429, 'private limiter internals', 'Too many pairing attempts'],
    [503, 'The pairing code could not be saved. Check server storage permissions and free space.', 'storage permissions'],
  ] as const)
    await withFetch(Response.json({ message }, { status }), async () => {
      await expect(createClusterInvitation(credentials)).rejects.toThrow(expected);
    });
});

test('browser HTTP cannot send local or remote account pairing credentials', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:' } });
  try {
    await withFetch(Response.json(connection()), async (calls) => {
      await expect(connectClusterServer({ ...pairBody(), url: 'https://peer.example.test' })).rejects.toThrow('HTTPS');
      await expect(completeClusterPairing({ pendingId: connection().pendingId, password: 'remote-test-password' })).rejects.toThrow('HTTPS');
      expect(calls).toHaveLength(0);
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('pairing access check is read-only, bounded, same-origin and exposes only setup availability', async () => {
  const unavailable = { available: false, message: 'Secure pairing needs a private HTTPS connection and trusted proxy setup on this server.' };
  await withFetch(Response.json(unavailable), async (calls) => {
    await expect(clusterPairingAccess()).resolves.toEqual(unavailable);
    expect(calls[0]?.url).toBe('/api/cluster/pairing/access');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.redirect).toBe('error');
  });
  await withFetch(Response.json({ available: true }), async () => {
    await expect(clusterPairingAccess()).resolves.toEqual({ available: true });
  });
  await withFetch(Response.json({ available: false, message: 'private ingress details' }), async () => {
    await expect(clusterPairingAccess()).rejects.toThrow('could not be checked');
  });
});
