import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoggerService } from '@/core/logger/logger.service';
import { TransferIngress } from '../host-transfer/transfer-ingress';
import { AuthGuard } from '../auth/auth.guard';
import { HostTransferController } from '../host-transfer/host-transfer.controller';
import { HostTransferService } from '../host-transfer/host-transfer.service';
import { transferLimits } from '../host-transfer/transfer-transport';
import { BackupImportsService } from './backup-imports.service';
import { SystemBackupsService } from './system-backups.service';
import { fixturePassphrase, fullBackupFixture } from './backup-import.fixture';

let root: string;
let backupId: string;
let source: HostTransferService;
let destination: HostTransferService;
let backups: SystemBackupsService;
let imports: BackupImportsService;
let app: INestApplication | undefined;
let original: Buffer;
const credentials = { password: 'disposable-transfer-account-password', totpCode: '123456' };
const auth = { verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }) };
const logger = { warn: vi.fn(), debug: vi.fn() };
const database = { review: vi.fn().mockResolvedValue({ counts: { user: 1, app_store: 0, app: 0, link: 0 }, bytes: 1, sha256: '0'.repeat(64) }) };
const target = Object.freeze({
  origin: 'https://source.example.test',
  hostname: 'source.example.test',
  address: '192.168.30.10',
  port: '443',
  family: 4,
});
const transport = { resolve: vi.fn(), json: vi.fn(), download: vi.fn() };
const configuration = (dataDir: string) => ({ get: (key: string) => ({ directories: { dataDir }, version: '4.10.1', architecture: 'arm64' })[key] });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeEach(async () => {
  vi.clearAllMocks();
  auth.verifySensitiveAction.mockResolvedValue({ id: 1 });
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-host-transfer-')));
  const fixture = await fullBackupFixture(root);
  original = await fs.readFile(fixture.encrypted);
  backupId = randomUUID();
  const directory = path.join(root, 'source-server', 'backups', 'full', backupId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.copyFile(fixture.encrypted, path.join(directory, 'backup.orbis'));
  await fs.chmod(path.join(directory, 'backup.orbis'), 0o600);
  await fs.writeFile(
    path.join(directory, 'job.json'),
    JSON.stringify({
      version: 1,
      id: backupId,
      ownerId: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'succeeded',
      stage: 'complete',
      completedBytes: original.length,
      totalBytes: original.length,
      message: 'Fixture export completed.',
      resumePending: [],
      restartRequired: false,
    }),
    { mode: 0o600 },
  );
  backups = new SystemBackupsService(
    ...([configuration(path.join(root, 'source-server')), auth, {}, {}, {}, {}, logger, {}] as unknown as ConstructorParameters<
      typeof SystemBackupsService
    >),
  );
  imports = new BackupImportsService(
    ...([configuration(path.join(root, 'destination-server')), auth, logger, database] as unknown as ConstructorParameters<
      typeof BackupImportsService
    >),
  );
  source = new HostTransferService(...([backups, imports, auth, transport] as unknown as ConstructorParameters<typeof HostTransferService>));
  destination = new HostTransferService(...([backups, imports, auth, transport] as unknown as ConstructorParameters<typeof HostTransferService>));
  transport.resolve.mockResolvedValue(target);
  transport.json.mockImplementation(async (_target, endpoint, body) => (endpoint === 'claim' ? source.claim(body) : source.peerStatus(body)));
  transport.download.mockImplementation(async (_target, body) => source.file(body).stream);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await destination?.onModuleDestroy();
  await source?.onModuleDestroy();
  await backups?.onModuleDestroy();
  await imports?.onModuleDestroy();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});
async function paired() {
  const offer = await source.offer(1, backupId, credentials, true);
  const job = await destination.createImport(1, target.origin, offer.code, credentials);
  return { offer, job };
}
async function waitForTerminal(id: string) {
  await vi.waitFor(() => {
    const job = destination.list(1).jobs.find((entry) => entry.id === id);
    expect(['complete', 'failed', 'cancelled']).toContain(job?.status);
  });
  const job = destination.list(1).jobs.find((entry) => entry.id === id);
  if (!job) throw new Error('Expected the transfer job to remain visible');
  return job;
}

it('streams the actual encrypted export into the existing import and requires a separate passphrase review', async () => {
  const { offer, job } = await paired();
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(2);
  expect(source.list(1).offers[0]?.destinationFingerprint).toBe(job.destinationFingerprint);
  await source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(3);
  destination.start(job.id, 1, offer.sourceFingerprint);
  const completed = await waitForTerminal(job.id);
  expect(completed).toMatchObject({ status: 'complete', completedBytes: original.length, totalBytes: original.length, requiresReview: true });
  const imported = (await imports.list(1)).jobs.find((entry) => entry.id === job.importId);
  expect(imported?.status).toBe('uploaded');
  expect(database.review).not.toHaveBeenCalled();
  const saved = await fs.readFile(path.join(root, 'destination-server', 'backups', 'imports', job.importId, 'backup.orbis'));
  expect(hash(saved)).toBe(hash(original));
  expect(hash(await fs.readFile(path.join(root, 'source-server', 'backups', 'full', backupId, 'backup.orbis')))).toBe(hash(original));
  expect(transport.download.mock.calls[0]?.[0]).toBe(target);
  for (const call of [...transport.json.mock.calls, ...transport.download.mock.calls])
    expect(JSON.stringify(call)).not.toContain(credentials.password);
  await imports.review(job.importId, 1, credentials, fixturePassphrase);
  await vi.waitFor(async () => expect((await imports.list(1)).jobs[0]?.status).toBe('reviewed'));
  expect(database.review).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(path.join(root, 'destination-server'))).toEqual(['backups']);
});

it('consumes a code once and refuses sending before source approval or to a different claim', async () => {
  const { offer, job } = await paired();
  expect(() => source.claim({ code: offer.code, destinationFingerprint: 'b'.repeat(64) })).toThrow('invalid, used or expired');
  const claim = transport.json.mock.calls[0]?.[2];
  expect(claim).toMatchObject({ code: offer.code, destinationFingerprint: job.destinationFingerprint });
  const response = await transport.json.mock.results[0]?.value;
  expect(() => source.file({ claimId: response.claimId, claimToken: response.claimToken })).toThrow('must approve');
  await expect(source.approve(offer.id, 1, credentials, 'a'.repeat(64))).rejects.toThrow('fingerprint');
  await expect(source.approve(offer.id, 2, credentials, job.destinationFingerprint)).rejects.toThrow('not found');
  expect(() => destination.start(job.id, 2, offer.sourceFingerprint)).toThrow('not found');
  expect(() => destination.start(job.id, 1, 'a'.repeat(64))).toThrow('fingerprint');
  expect(() => source.peerStatus({ claimId: response.claimId, claimToken: 'f'.repeat(64) })).toThrow('not found');
});

it('keeps an unapproved destination waiting and permits exactly one approved send', async () => {
  const { offer, job } = await paired();
  destination.start(job.id, 1, offer.sourceFingerprint);
  await vi.waitFor(() => expect(destination.list(1).jobs[0]?.status).toBe('awaiting-source-approval'));
  expect(transport.download).not.toHaveBeenCalled();
  await source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  destination.start(job.id, 1, offer.sourceFingerprint);
  expect(() => destination.start(job.id, 1, offer.sourceFingerprint)).toThrow('cannot be started');
  await waitForTerminal(job.id);
  const claim = await transport.json.mock.results[0]?.value;
  expect(() => source.file({ claimId: claim.claimId, claimToken: claim.claimToken })).toThrow('not found');
  expect(JSON.stringify(source.list(1))).not.toContain(offer.code);
  expect(JSON.stringify(destination.list(1))).not.toContain(claim.claimToken);
});

it('fails closed when fresh authentication fails and when source approval expires during authentication', async () => {
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Fresh authentication rejected'));
  await expect(source.offer(1, backupId, credentials, true)).rejects.toThrow('Fresh authentication');
  expect(source.list(1).offers).toHaveLength(0);
  const { offer, job } = await paired();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + transferLimits.pendingMs + 1);
  await expect(source.approve(offer.id, 1, credentials, job.destinationFingerprint)).rejects.toThrow('fingerprint');
  expect(source.list(1).offers[0]?.status).toBe('expired');
  vi.restoreAllMocks();
});

it('cancels in-progress streaming and leaves no uploaded partial file or restore data', async () => {
  const { offer, job } = await paired();
  await source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  const stalled = new PassThrough();
  transport.download.mockResolvedValueOnce(stalled);
  destination.start(job.id, 1, offer.sourceFingerprint);
  await vi.waitFor(() => expect(destination.list(1).jobs[0]?.status).toBe('receiving'));
  stalled.write(original.subarray(0, 16));
  await vi.waitFor(() => expect(destination.list(1).jobs[0]?.completedBytes).toBe(16));
  await destination.cancelImport(job.id, 1);
  expect(destination.list(1).jobs[0]?.status).toBe('cancelled');
  expect(stalled.destroyed).toBe(true);
  expect(await fs.readdir(path.join(root, 'destination-server', 'backups', 'imports', job.importId))).toEqual(['job.json']);
  expect(database.review).not.toHaveBeenCalled();
});

it('rejects a changed source identity and declared-size overrun without restoring data', async () => {
  const { offer, job } = await paired();
  await source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  transport.json.mockResolvedValueOnce({ status: 'approved', sourceFingerprint: 'a'.repeat(64), bytes: original.length });
  destination.start(job.id, 1, offer.sourceFingerprint);
  expect((await waitForTerminal(job.id)).status).toBe('failed');
  expect(transport.download).not.toHaveBeenCalled();
  const next = await paired();
  await source.approve(next.offer.id, 1, credentials, next.job.destinationFingerprint);
  transport.download.mockResolvedValueOnce(Readable.from([original, Buffer.alloc(1)]));
  destination.start(next.job.id, 1, next.offer.sourceFingerprint);
  expect((await waitForTerminal(next.job.id)).status).toBe('failed');
  expect(await fs.readdir(path.join(root, 'destination-server', 'backups', 'imports', next.job.importId))).toEqual(['job.json']);
});

it('bounds live offers and releases their file streams on cancellation', async () => {
  const offers = await Promise.all(Array.from({ length: 4 }, () => source.offer(1, backupId, credentials, true)));
  await expect(source.offer(1, backupId, credentials, true)).rejects.toThrow('existing transfer offer');
  const first = offers[0];
  if (!first) throw new Error('Expected a bounded transfer offer');
  source.cancelOffer(first.id, 1);
  await expect(source.offer(1, backupId, credentials, true)).resolves.toMatchObject({ status: 'awaiting-claim' });
  expect(() => source.claim({ code: first.code, destinationFingerprint: 'b'.repeat(64) })).toThrow('invalid, used or expired');
});

it('deletes an empty destination import when remote claim validation fails', async () => {
  transport.json.mockResolvedValueOnce({ claimId: randomUUID(), claimToken: 'invalid' });
  await expect(destination.createImport(1, target.origin, 'b'.repeat(64), credentials)).rejects.toThrow('invalid or expired');
  expect((await imports.list(1)).jobs).toHaveLength(0);
});

it('does not revive a cancelled source offer when fresh authentication finishes later', async () => {
  const { offer, job } = await paired();
  let authenticate: (() => void) | undefined;
  auth.verifySensitiveAction.mockImplementationOnce(
    () =>
      new Promise<{ id: number }>((resolve) => {
        authenticate = () => resolve({ id: 1 });
      }),
  );
  const approving = source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  source.cancelOffer(offer.id, 1);
  if (!authenticate) throw new Error('Expected fresh authentication to be pending');
  authenticate();
  await expect(approving).rejects.toThrow('fingerprint');
  expect(source.list(1).offers[0]?.status).toBe('cancelled');
});

it('revokes an active source send and closes both pinned streams on client disconnect', async () => {
  const { offer, job } = await paired();
  await source.approve(offer.id, 1, credentials, job.destinationFingerprint);
  const claim = await transport.json.mock.results[0]?.value;
  const sending = source.file({ claimId: claim.claimId, claimToken: claim.claimToken });
  source.cancelOffer(offer.id, 1);
  expect(sending.stream.destroyed).toBe(true);
  expect(source.list(1).offers[0]?.status).toBe('cancelled');
  expect(() => source.file({ claimId: claim.claimId, claimToken: claim.claimToken })).toThrow('not found');
  expect(hash(await fs.readFile(path.join(root, 'source-server', 'backups', 'full', backupId, 'backup.orbis')))).toBe(hash(original));
});

it('requires operator sessions and same-origin browser mutations through the actual HTTP guard', async () => {
  const module = await Test.createTestingModule({
    controllers: [HostTransferController],
    providers: [
      AuthGuard,
      { provide: HostTransferService, useValue: source },
      { provide: LoggerService, useValue: logger },
      { provide: TransferIngress, useValue: { addresses: vi.fn().mockResolvedValue([]) } },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers['x-fixture-role'];
    if (typeof role === 'string') {
      req.user = { id: 1, operator: role !== 'viewer' } as Request['user'];
      req.authMethod = role === 'api-key' ? 'cli' : 'session';
    }
    next();
  });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const api = () => request(server);
  const base = '/api/system-backups/transfers';
  const origin = await app.getUrl();
  await api().get(base).expect(401);
  await api().get(base).set('x-fixture-role', 'viewer').expect(403);
  await api().get(base).set('x-fixture-role', 'api-key').expect(403);
  await api()
    .post(`${base}/offers`)
    .set('x-fixture-role', 'operator')
    .send({ ...credentials, backupId, confirmExport: true })
    .expect(403);
  await api()
    .post(`${base}/offers`)
    .set('Origin', origin)
    .set('x-fixture-role', 'operator')
    .send({ ...credentials, backupId, confirmExport: true, destination: 'https://unapproved.example.test' })
    .expect(400);
  await api()
    .post(`${base}/offers`)
    .set('Origin', origin)
    .set('x-fixture-role', 'operator')
    .send({ ...credentials, backupId, confirmExport: true })
    .expect(201);
  await api()
    .post(`${base}/peer/claim`)
    .send({ code: 'b'.repeat(64), destinationFingerprint: 'c'.repeat(64) })
    .expect(403);
});

it.each([
  { secure: false, ip: '192.168.30.11', socket: { remoteAddress: '192.168.30.11' } },
  { secure: true, ip: '192.168.30.11', socket: { remoteAddress: '8.8.8.8' } },
  { secure: true, ip: '8.8.8.8', socket: { remoteAddress: '192.168.30.11' } },
])('rejects insecure or public inbound peers before looking up a code', async (req) => {
  const claim = vi.spyOn(source, 'claim');
  const controller = new HostTransferController(source, { addresses: vi.fn().mockResolvedValue([]) } as unknown as TransferIngress);
  await expect(controller.claim({ headers: {}, rawHeaders: [], ...req } as unknown as Request, {})).rejects.toThrow('private LAN HTTPS');
  expect(claim).not.toHaveBeenCalled();
});
