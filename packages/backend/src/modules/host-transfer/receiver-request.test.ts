import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReceiverRequestService } from './receiver-request.service';
import { HostTransferService } from './host-transfer.service';
import { TransferCapacity } from './transfer-capacity';
import { transferLimits } from './transfer-transport';

const sourceCredentials = { password: 'example source account password', totpCode: '123456' };
const destinationCredentials = { password: 'example destination password' };
const sourceAddress = '192.168.20.10';
const destinationAddress = '192.168.20.11';
const target = Object.freeze({
  origin: 'https://source.example.test',
  hostname: 'source.example.test',
  address: sourceAddress,
  family: 4,
  port: '443',
});
const bytes = Buffer.alloc(96, 7);
let source: ReceiverRequestService;
let destination: ReceiverRequestService;
let sourceCapacity: TransferCapacity;
let destinationCapacity: TransferCapacity;
let backups: { startTransferExport: ReturnType<typeof vi.fn> };
let auth: { verifySensitiveAction: ReturnType<typeof vi.fn> };
let imports: {
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  receive: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};
let transport: { resolve: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
let grant: {
  requestId: string;
  backupId: string;
  ready: Promise<{ bytes: number }>;
  progress: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};
const extras: HostTransferService[] = [];
const peerInput = () => ({ version: 1, nonce: randomUUID(), destinationFingerprint: 'a'.repeat(64) });
const peerBody = (value: ReturnType<ReceiverRequestService['peerRequest']>) => ({
  version: 1,
  requestId: value.id,
  nonce: value.nonce,
  token: value.token,
  destinationFingerprint: value.destinationFingerprint,
});
async function settle() {
  for (let count = 0; count < 8; count++) await Promise.resolve();
}
function instance(capacity: TransferCapacity) {
  return new ReceiverRequestService(
    ...([backups, imports, auth, transport, capacity] as unknown as ConstructorParameters<typeof ReceiverRequestService>),
  );
}
beforeEach(() => {
  sourceCapacity = new TransferCapacity();
  destinationCapacity = new TransferCapacity();
  auth = { verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }) };
  grant = {
    requestId: '',
    backupId: randomUUID(),
    ready: Promise.resolve({ bytes: bytes.length }),
    progress: vi.fn().mockReturnValue({ stage: 'encrypting', completedBytes: 10, totalBytes: 100 }),
    open: vi.fn().mockImplementation(async () => ({ stream: Readable.from([bytes]), bytes: bytes.length })),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  backups = {
    startTransferExport: vi.fn().mockImplementation(async (_owner, _credentials, _key, id) => {
      grant.requestId = id;
      return grant;
    }),
  };
  imports = {
    create: vi.fn().mockImplementation(async () => ({ id: randomUUID() })),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    cancel: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    receive: vi.fn().mockImplementation(async (_id, _owner, stream: Readable, count: string) => {
      const received: Buffer[] = [];
      for await (const chunk of stream) received.push(Buffer.from(chunk));
      expect(Buffer.concat(received)).toEqual(bytes);
      expect(count).toBe(String(bytes.length));
      return { status: 'uploaded' };
    }),
  };
  transport = { resolve: vi.fn().mockResolvedValue(target), json: vi.fn(), download: vi.fn() };
  source = instance(sourceCapacity);
  destination = instance(destinationCapacity);
  transport.json.mockImplementation(async (_target, endpoint, body) => {
    if (endpoint === 'request') return source.peerRequest(body, destinationAddress);
    if (endpoint === 'request-status') return source.peerStatus(body, destinationAddress);
    if (endpoint === 'request-cancel') return source.peerCancel(body, destinationAddress);
    throw new Error('Unexpected endpoint');
  });
  transport.download.mockImplementation(async (_target, body, _size, _signal, endpoint) => {
    expect(endpoint).toBe('request-file');
    return (await source.peerFile(body, destinationAddress)).stream;
  });
});
afterEach(async () => {
  await Promise.allSettled([source.onModuleDestroy(), destination.onModuleDestroy(), ...extras.splice(0).map((value) => value.onModuleDestroy())]);
  vi.useRealTimers();
});

it('requests a new source backup, binds fresh approval to the source operator, and streams only encrypted bytes into the owned import', async () => {
  const requested = await destination.create(2, target.origin, destinationCredentials, true);
  expect(imports.create).toHaveBeenCalledWith(2, destinationCredentials);
  const incoming = source.list(1).incoming[0];
  if (!incoming) throw new Error('Expected incoming request');
  expect(backups.startTransferExport).not.toHaveBeenCalled();
  await source.approve(incoming.id, 1, sourceCredentials, requested.destinationFingerprint, 'source-account-password');
  expect(backups.startTransferExport).toHaveBeenCalledWith(1, sourceCredentials, sourceCredentials.password, incoming.id, expect.any(Number));
  await settle();
  destination.start(requested.id, 2, requested.sourceFingerprint, true);
  await vi.waitFor(() => expect(destination.list(2).outgoing[0]?.status).toBe('complete'));
  expect(imports.receive).toHaveBeenCalledWith(requested.importId, 2, expect.any(Readable), String(bytes.length));
  expect(source.list(1).incoming[0]?.status).toBe('complete');
  expect(source.list(3).incoming).toEqual([]);
  expect(destination.list(3).outgoing).toEqual([]);
  const publicState = JSON.stringify([source.list(1), destination.list(2), transport.json.mock.calls.map((call) => call[2])]);
  expect(publicState).not.toContain(sourceCredentials.password);
  expect(publicState).not.toContain(destinationCredentials.password);
  expect(destination.list(2).outgoing[0]?.requiresReview).toBe(true);
});
it('requires explicit local request and fingerprint consent and rejects unrelated source/owner selectors', async () => {
  await expect(destination.create(2, target.origin, destinationCredentials, false)).rejects.toThrow('Confirm');
  expect(transport.resolve).not.toHaveBeenCalled();
  const requested = await destination.create(2, target.origin, destinationCredentials, true);
  expect(() => destination.start(requested.id, 3, requested.sourceFingerprint, true)).toThrow('unavailable');
  expect(() => destination.start(requested.id, 2, '0'.repeat(64), true)).toThrow('fingerprint');
  expect(() => destination.start(requested.id, 2, requested.sourceFingerprint, false)).toThrow('fingerprint');
  for (const extra of [{ callbackUrl: 'https://other.example' }, { password: sourceCredentials.password }, { ownerId: 1 }])
    expect(() => source.peerRequest({ ...peerInput(), ...extra }, '192.168.20.99')).toThrow();
  expect(() => source.peerRequest(peerInput(), '203.0.113.10')).toThrow();
});
it('binds every peer operation to nonce, capability, destination fingerprint and the validated private peer IP', () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  const body = peerBody(value);
  for (const mutation of [
    { token: 'b'.repeat(64) },
    { nonce: randomUUID() },
    { requestId: randomUUID() },
    { destinationFingerprint: 'b'.repeat(64) },
    { ownerId: 1 },
  ])
    expect(() => source.peerStatus({ ...body, ...mutation }, destinationAddress)).toThrow();
  expect(() => source.peerStatus(body, '192.168.20.12')).toThrow();
  expect(source.peerStatus(body, destinationAddress).status).toBe('awaiting-approval');
  expect(JSON.stringify(source.list(1))).not.toContain(value.token);
});
it('reserves approval before awaiting export auth and prevents a second operator from approving or cancelling it', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  let approve!: (value: typeof grant) => void;
  backups.startTransferExport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  );
  const pending = source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password');
  await expect(source.approve(value.id, 3, sourceCredentials, value.destinationFingerprint, 'source-account-password')).rejects.toThrow();
  grant.requestId = value.id;
  approve(grant);
  await pending;
  await settle();
  expect(backups.startTransferExport).toHaveBeenCalledTimes(1);
  await expect(source.cancelIncoming(value.id, 3)).rejects.toThrow();
  expect(source.list(3).incoming).toEqual([]);
});
it('failed authentication releases only the approval reservation, while explicit rejection never starts an export', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  backups.startTransferExport.mockRejectedValueOnce(new Error('Denied'));
  await expect(source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password')).rejects.toThrow('Denied');
  expect(source.list(1).incoming[0]?.status).toBe('awaiting-approval');
  await source.reject(value.id, 3, sourceCredentials);
  expect(auth.verifySensitiveAction).toHaveBeenCalledWith(3, sourceCredentials.password, sourceCredentials.totpCode);
  expect(source.list(1).incoming).toEqual([]);
  expect(source.list(3).incoming[0]?.status).toBe('rejected');
  await expect(source.peerFile(peerBody(value), destinationAddress)).rejects.toThrow();
});
it('a cancellation while fresh authentication is pending cancels the returned grant and cannot resurrect approval', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  let approve!: (value: typeof grant) => void;
  backups.startTransferExport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  );
  const pending = source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password');
  await source.peerCancel(peerBody(value), destinationAddress);
  grant.requestId = value.id;
  approve(grant);
  await expect(pending).rejects.toThrow('unavailable');
  expect(grant.cancel).toHaveBeenCalledTimes(1);
  expect(source.peerStatus(peerBody(value), destinationAddress).status).toBe('cancelled');
});
it('does not weaken the archive-key policy and keeps explicit separate-passphrase encryption distinct', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  await expect(source.approve(value.id, 1, { password: 'short' }, value.destinationFingerprint, 'source-account-password')).rejects.toThrow(
    '12 and 1024',
  );
  expect(backups.startTransferExport).not.toHaveBeenCalled();
  await expect(
    source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password', 'unused phrase'),
  ).rejects.toThrow('one');
  await source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'separate-passphrase', 'example separate backup phrase');
  expect(backups.startTransferExport.mock.calls[0]?.[2]).toBe('example separate backup phrase');
  expect(source.list(1).incoming[0]?.encryption).toBe('separate-passphrase');
});
it('expired, failed and restarted requests cannot open stale grants or be approved again', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  const originalNow = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(originalNow + transferLimits.pendingMs + 1);
  expect(source.peerStatus(peerBody(value), destinationAddress).status).toBe('expired');
  await expect(source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password')).rejects.toThrow();
  vi.restoreAllMocks();
  const fresh = instance(new TransferCapacity());
  expect(() => fresh.peerStatus(peerBody(value), destinationAddress)).toThrow();
  await fresh.onModuleDestroy();
});
it('source export failure is terminal and never permits a file claim', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  grant.ready = Promise.reject(new Error('Export aborted'));
  void grant.ready.catch(() => undefined);
  await source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password');
  await settle();
  expect(source.list(1).incoming[0]?.status).toBe('failed');
  await expect(source.peerFile(peerBody(value), destinationAddress)).rejects.toThrow();
  expect(grant.open).not.toHaveBeenCalled();
});
it('a file claim is one-use and a disconnected source stream closes its underlying archive', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  await source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password');
  await settle();
  const input = new PassThrough();
  grant.open.mockResolvedValueOnce({ stream: input, bytes: bytes.length });
  const claimed = await source.peerFile(peerBody(value), destinationAddress);
  await expect(source.peerFile(peerBody(value), destinationAddress)).rejects.toThrow();
  claimed.stream.destroy();
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  expect(input.destroyed).toBe(true);
  expect(source.list(1).incoming[0]?.status).toBe('failed');
});
it('shares source capacity with legacy offers and counts asynchronous reservations before a fifth admission', async () => {
  for (let count = 0; count < 3; count++) source.peerRequest(peerInput(), `192.168.20.${30 + count}`);
  let open!: (value: { stream: Readable; bytes: number }) => void;
  const legacyBackups = {
    download: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          open = resolve;
        }),
    ),
  };
  const legacy = new HostTransferService(
    ...([legacyBackups, imports, auth, transport, sourceCapacity] as unknown as ConstructorParameters<typeof HostTransferService>),
  );
  extras.push(legacy);
  const pending = legacy.offer(1, randomUUID(), sourceCredentials, true);
  expect(() => source.peerRequest(peerInput(), '192.168.20.99')).toThrow('existing source transfer');
  open({ stream: Readable.from([bytes]), bytes: bytes.length });
  await pending;
  expect(legacy.list(1).offers).toHaveLength(1);
  expect(source.list(1).incoming).toHaveLength(3);
});
it('bounds each private peer to one pending request and refuses malformed or oversized peer bodies', () => {
  source.peerRequest(peerInput(), destinationAddress);
  expect(() => source.peerRequest(peerInput(), destinationAddress)).toThrow('existing request');
  expect(() => source.peerRequest({ version: 1, nonce: 'a'.repeat(2048), destinationFingerprint: 'b'.repeat(64) }, '192.168.20.99')).toThrow();
  expect(() => source.peerRequest({ ...peerInput(), version: 2 }, '192.168.20.99')).toThrow();
});
it('shares the active receive lease with a legacy code transfer and releases it after cancellation', async () => {
  const requested = await destination.create(2, target.origin, destinationCredentials, true);
  const legacyTransport = {
    resolve: vi.fn().mockResolvedValue(target),
    json: vi.fn().mockImplementation(async (_target, endpoint) =>
      endpoint === 'claim'
        ? {
            claimId: randomUUID(),
            claimToken: 'b'.repeat(64),
            sourceFingerprint: 'c'.repeat(64),
            bytes: bytes.length,
            expiresAt: Date.now() + transferLimits.pendingMs,
          }
        : { status: 'awaiting-approval', sourceFingerprint: 'c'.repeat(64), bytes: bytes.length },
    ),
    download: vi.fn(),
  };
  const legacy = new HostTransferService(
    ...([backups, imports, auth, legacyTransport, destinationCapacity] as unknown as ConstructorParameters<typeof HostTransferService>),
  );
  extras.push(legacy);
  const codeJob = await legacy.createImport(2, target.origin, 'd'.repeat(64), destinationCredentials);
  destination.start(requested.id, 2, requested.sourceFingerprint, true);
  expect(() => legacy.start(codeJob.id, 2, codeJob.sourceFingerprint)).toThrow('current transfer');
  await destination.cancelOutgoing(requested.id, 2);
  expect(() => legacy.start(codeJob.id, 2, codeJob.sourceFingerprint)).not.toThrow();
  await settle();
  expect(legacy.list(2).jobs[0]?.status).toBe('awaiting-source-approval');
});
it('cancellation during a pending archive open never returns a stream or rewrites the terminal cancellation', async () => {
  const value = source.peerRequest(peerInput(), destinationAddress);
  await source.approve(value.id, 1, sourceCredentials, value.destinationFingerprint, 'source-account-password');
  await settle();
  let finish!: (opened: { stream: Readable; bytes: number }) => void;
  grant.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = source.peerFile(peerBody(value), destinationAddress);
  await source.peerCancel(peerBody(value), destinationAddress);
  const input = new PassThrough();
  finish({ stream: input, bytes: bytes.length });
  await expect(pending).rejects.toThrow('unavailable');
  expect(input.destroyed).toBe(true);
  expect(source.peerStatus(peerBody(value), destinationAddress).status).toBe('cancelled');
});

function retainedLegacy(capacity: TransferCapacity) {
  const legacyTransport = {
    resolve: vi.fn().mockResolvedValue(target),
    json: vi.fn().mockImplementation(async () => ({
      claimId: randomUUID(),
      claimToken: 'b'.repeat(64),
      sourceFingerprint: 'c'.repeat(64),
      bytes: bytes.length,
      expiresAt: Date.now() + transferLimits.pendingMs,
    })),
  };
  const legacyBackups = { download: vi.fn().mockImplementation(async () => ({ stream: Readable.from([bytes]), bytes: bytes.length })) };
  const legacy = new HostTransferService(
    ...([legacyBackups, imports, auth, legacyTransport, capacity] as unknown as ConstructorParameters<typeof HostTransferService>),
  );
  extras.push(legacy);
  return legacy;
}
it('new source requests reclaim aged dormant legacy source retention without a legacy API call', async () => {
  const legacy = retainedLegacy(sourceCapacity);
  for (let index = 0; index < 16; index++) {
    const offer = await legacy.offer(1, randomUUID(), sourceCredentials, true);
    legacy.cancelOffer(offer.id, 1);
  }
  expect(() => source.peerRequest(peerInput(), destinationAddress)).toThrow('existing source transfer');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2 * transferLimits.transferMs);
  expect(() => source.peerRequest(peerInput(), destinationAddress)).not.toThrow();
});
it('legacy offers reclaim aged dormant new source retention without a new API call', async () => {
  const legacy = retainedLegacy(sourceCapacity);
  for (let index = 0; index < 16; index++) {
    const request = source.peerRequest(peerInput(), destinationAddress);
    await source.peerCancel(peerBody(request), destinationAddress);
  }
  await expect(legacy.offer(1, randomUUID(), sourceCredentials, true)).rejects.toThrow('existing source transfer');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2 * transferLimits.transferMs);
  await expect(legacy.offer(1, randomUUID(), sourceCredentials, true)).resolves.toHaveProperty('id');
});
it('new destination requests reclaim aged dormant legacy imports without a legacy API call', async () => {
  const legacy = retainedLegacy(destinationCapacity);
  for (let index = 0; index < 16; index++) {
    const job = await legacy.createImport(2, target.origin, 'd'.repeat(64), destinationCredentials);
    await legacy.cancelImport(job.id, 2);
  }
  await expect(destination.create(2, target.origin, destinationCredentials, true)).rejects.toThrow('existing transfers');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2 * transferLimits.transferMs);
  await expect(destination.create(2, target.origin, destinationCredentials, true)).resolves.toHaveProperty('id');
});
it('legacy imports reclaim aged dormant new destination retention without a new API call', async () => {
  const legacy = retainedLegacy(destinationCapacity);
  for (let index = 0; index < 16; index++) {
    const job = await destination.create(2, target.origin, destinationCredentials, true);
    await destination.cancelOutgoing(job.id, 2);
  }
  await expect(legacy.createImport(2, target.origin, 'd'.repeat(64), destinationCredentials)).rejects.toThrow('existing transfers');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 2 * transferLimits.transferMs);
  await expect(legacy.createImport(2, target.origin, 'd'.repeat(64), destinationCredentials)).resolves.toHaveProperty('id');
});
