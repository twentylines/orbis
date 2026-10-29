import { expect, test } from 'bun:test';
import { authorityRequestGate, certificateReadGate, pairingRequest, requestScope, type PairingDraft } from './cluster-pairing-state';
const certificate = { pem: 'public-certificate-only', sha256: 'a'.repeat(64), confirmed: false };
const draft = (overrides: Partial<PairingDraft> = {}): PairingDraft => ({
  url: 'https://peer.home.arpa',
  code: 'a'.repeat(24),
  name: 'Peer',
  password: 'unit-password',
  totpCode: '123456',
  allowInsecureLan: false,
  certificateMode: 'peer',
  certificate,
  confirmedCertificate: true,
  ...overrides,
});
test('reviewed certificate is carried only with exact origin and fresh credentials', () => {
  expect(pairingRequest(draft())).toEqual({
    url: 'https://peer.home.arpa',
    code: 'A'.repeat(24),
    name: 'Peer',
    password: 'unit-password',
    totpCode: '123456',
    peerCertificatePem: certificate.pem,
    peerCertificateSha256: certificate.sha256,
    confirmPeerCertificate: true,
  });
});
test('normal HTTPS mode cannot retain a previously uploaded trust anchor', () => {
  expect(pairingRequest(draft({ certificateMode: 'system' }))).not.toHaveProperty('peerCertificatePem');
  expect(pairingRequest(draft({ certificateMode: 'system' }))).not.toHaveProperty('peerCertificateSha256');
  expect(pairingRequest(draft({ certificateMode: 'system' }))).not.toHaveProperty('confirmPeerCertificate');
});
test('each origin, mode, cancelled or unmounted selection invalidates late certificate reads', async () => {
  const gate = certificateReadGate();
  const first = gate.begin();
  let release!: (value: typeof certificate) => void;
  const pending = new Promise<typeof certificate>((resolve) => {
    release = resolve;
  });
  gate.invalidate();
  release(certificate);
  await pending;
  expect(gate.current(first)).toBe(false);
  const second = gate.begin();
  const third = gate.begin();
  expect(gate.current(second)).toBe(false);
  expect(gate.current(third)).toBe(true);
  gate.invalidate();
  expect(gate.current(third)).toBe(false);
});
for (const overrides of [
  { confirmedCertificate: false },
  { certificate: null },
  { url: 'https://peer.home.arpa/path' },
  { url: 'https://name:password@peer.home.arpa' },
  { url: 'https://peer.home.arpa?code=secret' },
  { url: 'https://peer.home.arpa#trust' },
  { url: 'file:///private' },
  { url: 'http://peer.home.arpa', allowInsecureLan: true },
  { code: 'bad' },
  { password: '' },
  { totpCode: '123' },
  { certificate: { ...certificate, sha256: 'wrong' } },
] satisfies Partial<PairingDraft>[])
  test(`unreviewed or malformed pairing details refuse before request: ${JSON.stringify(Object.keys(overrides))}`, () => {
    expect(() => pairingRequest(draft(overrides))).toThrow();
  });
test('legacy HTTP requires its own explicit warning and cannot include certificate fields', () => {
  expect(() => pairingRequest(draft({ url: 'http://peer.home.arpa', certificateMode: 'system', allowInsecureLan: false }))).toThrow('unencrypted');
  expect(pairingRequest(draft({ url: 'http://peer.home.arpa', certificateMode: 'system', allowInsecureLan: true }))).toEqual({
    url: 'http://peer.home.arpa',
    code: 'A'.repeat(24),
    name: 'Peer',
    password: 'unit-password',
    totpCode: '123456',
    allowInsecureLan: true,
  });
});

test('deferred invitation and paired result cannot repopulate a changed authority or unmounted view', async () => {
  for (const boundary of ['account', 'host', 'role', 'unmount']) {
    const gate = certificateReadGate();
    const scope = requestScope(gate);
    const committed: string[] = [];
    let release!: (value: string) => void;
    const pending = scope.accept(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
      (value) => {
        committed.push(value);
      },
    );
    gate.invalidate();
    release('old-invitation-or-pair');
    await pending;
    scope.commit(() => committed.push('old-success-or-reset'));
    expect(committed).toEqual([]);
    const next = requestScope(gate);
    next.commit(() => committed.push(boundary));
    expect(committed).toEqual([boundary]);
  }
});
test('late rejection and old finally cannot overwrite a new authority request state', async () => {
  const gate = certificateReadGate();
  const old = requestScope(gate);
  const committed: string[] = [];
  let reject!: (error: Error) => void;
  const pending = old.accept(
    new Promise<never>((_resolve, fail) => {
      reject = fail;
    }),
    () => {
      committed.push('old-response');
    },
  );
  gate.invalidate();
  const next = requestScope(gate);
  next.commit(() => committed.push('new-pending'));
  reject(Error('old-request-failure'));
  try {
    await pending;
  } catch {
    old.commit(() => committed.push('old-error'));
  } finally {
    old.commit(() => committed.push('old-busy-false'));
  }
  expect(committed).toEqual(['new-pending']);
});
test('matching authority accepts its response and current completion once', async () => {
  const scope = requestScope(certificateReadGate());
  const values: string[] = [];
  await scope.accept(Promise.resolve('new-invitation'), (value) => {
    values.push(value);
  });
  scope.commit(() => values.push('complete'));
  expect(values).toEqual(['new-invitation', 'complete']);
});

test('same numeric account id cannot retain an old request across username or session replacement', async () => {
  const original = { sessionIdentity: {}, userId: 1, username: 'original-account', operator: true, hostId: 'host', role: 'admin' };
  for (const next of [
    { ...original, username: 'restored-account' },
    { ...original, sessionIdentity: {} },
  ]) {
    const gate = authorityRequestGate();
    gate.bind(original);
    const scope = requestScope(gate);
    const committed: string[] = [];
    let resolve!: (value: string) => void;
    const pending = scope.accept(
      new Promise<string>((complete) => {
        resolve = complete;
      }),
      (value) => {
        committed.push(value);
      },
    );
    gate.bind(next);
    resolve('old-account-invitation');
    await pending;
    expect(next.userId).toBe(original.userId);
    expect(committed).toEqual([]);
    const current = requestScope(gate);
    gate.bind({ ...next });
    expect(current.current()).toBe(true);
  }
});
