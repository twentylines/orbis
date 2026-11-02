import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupImportsService } from './backup-imports.service';
import { fullBackupFixture, fixturePassphrase } from './backup-import.fixture';
import { acquireBackupDisk } from '@/common/backup-disk';
import { BackupRestoreJournal } from './backup-restore-journal';
import { acquireRestoreLease } from './backup-restore-lease';
import { TimeMachineRestoreAuthorization } from './time-machine-restore-authorization';
import { readRetainedRestoreReceipt, type RetainedRestorePermit } from './time-machine-restore-admission';
import type { AuthService } from '../auth/auth.service';
import type { PasskeyService } from '../auth/passkey.service';
import type { Request } from 'express';

let root: string;
let service: BackupImportsService;
const credentials = { password: 'disposable-operator-password', totpCode: '123456' };
const auth = {
  verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }),
  operatorActionContext: vi.fn().mockResolvedValue({ userId: 1, sessionBinding: 'session', securityBinding: 'security' }),
};
const security = {
  read: vi.fn().mockResolvedValue({ version: 1, revision: 0, requireCaptureAuthentication: false, requireRestoreAuthentication: false }),
};
const logger = { warn: vi.fn() };
// Archive/service tests use a declared database boundary; real PostgreSQL review has separate runtime coverage.
const database = { review: vi.fn() };
let config: { get: (key: string) => unknown };
const construct = () =>
  new BackupImportsService(...([config, auth, logger, database, security] as unknown as ConstructorParameters<typeof BackupImportsService>));
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-import-service-')));
  await fs.mkdir(path.join(root, 'live'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'live', 'preserve'), 'live server fixture');
  config = { get: (key) => ({ directories: { dataDir: path.join(root, 'live') }, version: '4.10.1', architecture: 'arm64' })[key] };
  database.review.mockImplementation(async (_content: string, destination: string) => {
    await fs.mkdir(destination, { mode: 0o700 });
    const row = {
      id: 1,
      username: 'fixture@example.invalid',
      password: `$argon2id$v=19$m=8192,t=1,p=1$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_001,
      operator: true,
      totp_secret: null,
      totp_enabled: false,
      salt: null,
      locale: 'en',
      has_seen_welcome: true,
    };
    const bytes = Buffer.from(`${JSON.stringify({ table: 'user', row })}\n`);
    const review = {
      counts: { user: 1, app_store: 0, app: 0, link: 0 },
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await fs.writeFile(path.join(destination, 'records.ndjson'), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(destination, 'records.json'), JSON.stringify({ version: 1, ...review }), { mode: 0o600 });
    return review;
  });
  service = construct();
  auth.verifySensitiveAction.mockResolvedValue({ id: 1 });
});
afterEach(async () => {
  await service.onModuleDestroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const directory = (id: string) => path.join(root, 'live', 'backups', 'imports', id);
async function retainedFixture() {
  const fixture = await fullBackupFixture(root);
  const expected = {
    pointId: randomUUID(),
    bytes: (await fs.stat(fixture.encrypted)).size,
    archiveSha256: createHash('sha256')
      .update(await fs.readFile(fixture.encrypted))
      .digest('hex'),
    manifestSha256: createHash('sha256')
      .update(await fs.readFile(path.join(fixture.content, 'manifest.json')))
      .digest('hex'),
  };
  const open = async (_signal: AbortSignal, consume: (source: Readable, passphrase: string) => Promise<void>) => {
    const source = createReadStream(fixture.encrypted);
    try {
      await consume(source, fixturePassphrase);
    } finally {
      source.destroy();
    }
  };
  return { expected, open };
}
async function retainedSource() {
  vi.stubEnv('ORBIS_VERSION', 'v1.0.0');
  const fixture = await retainedFixture();
  const reviewed = await service.reviewRetained(1, fixture.expected, fixture.open, new AbortController().signal, () => undefined);
  const journal = await BackupRestoreJournal.create(path.join(root, 'live', 'backups', 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  const binding = {
    pointId: fixture.expected.pointId,
    reviewId: randomUUID(),
    archiveSha256: fixture.expected.archiveSha256,
    manifestSha256: fixture.expected.manifestSha256,
    machineId: 'a'.repeat(64),
  };
  const actor = { userId: 1, sessionBinding: 'b'.repeat(64), securityBinding: 'c'.repeat(64) };
  const context = vi.fn().mockResolvedValue(actor);
  const authorization = new TimeMachineRestoreAuthorization(
    { ...auth, operatorActionContext: context } as unknown as AuthService,
    {} as PasskeyService,
  );
  const request = {} as Request;
  const authorize = async () => {
    const grant = await authorization.password(request, binding, credentials);
    return authorization.admit(request, binding, grant.grantId, reviewed.id, journal);
  };
  const permit = await authorize();
  return { fixture, journal, binding, id: reviewed.id, permit, context, actor, authorize, signal: new AbortController().signal };
}

it('moves only a freshly authorized retained source into the existing journal without touching live data', async () => {
  const source = await retainedSource();
  const result = await service.claimRetainedSource(source.id, 1, source.binding, source.permit, source);
  expect(result.seal.manifest.sha256).toBe(source.binding.manifestSha256);
  expect(result.directory).toBe(path.join(source.journal.directory, 'source', 'payload'));
  const receipt = await readRetainedRestoreReceipt(source.journal);
  expect(receipt?.binding).toEqual(source.binding);
  expect(receipt?.authorizationSha256).toBe(
    createHash('sha256')
      .update(`orbis-time-machine-admission-actor-v1\n${source.actor.userId}\n${source.actor.sessionBinding}\n${source.actor.securityBinding}`)
      .digest('hex'),
  );
  expect(JSON.stringify(receipt)).not.toContain(credentials.password);
  expect(JSON.stringify(receipt)).not.toContain(source.actor.sessionBinding);
  await expect(service.claimRetainedSource(source.id, 1, source.binding, source.permit, source)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

it('cannot claim retained data using a receipt or reconstructed permit alone', async () => {
  const source = await retainedSource();
  const receipt = await readRetainedRestoreReceipt(source.journal);
  for (const forged of [receipt, JSON.parse(JSON.stringify(source.permit))])
    await expect(service.claimRetainedSource(source.id, 1, source.binding, forged as RetainedRestorePermit, source)).rejects.toThrow();
  expect((await service.retainedStatus(source.id, 1)).status).toBe('reviewed');
  await expect(fs.stat(path.join(source.journal.directory, 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects changed ciphertext before transfer and requires a new fresh authorization for a safe retry', async () => {
  const source = await retainedSource();
  const file = path.join(directory(source.id), 'backup.orbis');
  const original = await fs.readFile(file);
  await fs.appendFile(file, 'changed');
  await expect(service.claimRetainedSource(source.id, 1, source.binding, source.permit, source)).rejects.toThrow('ciphertext changed');
  await fs.writeFile(file, original);
  await expect(service.claimRetainedSource(source.id, 1, source.binding, source.permit, source)).rejects.toThrow();
  const fresh = await source.authorize();
  await expect(service.claimRetainedSource(source.id, 1, source.binding, fresh, source)).resolves.toMatchObject({
    seal: { manifest: { sha256: source.binding.manifestSha256 } },
  });
});

it('rechecks session authority after ciphertext verification under the existing restore lease', async () => {
  const source = await retainedSource();
  const file = path.join(directory(source.id), 'backup.orbis');
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) source.context.mockResolvedValue({ ...source.actor, sessionBinding: 'd'.repeat(64) });
    return handle;
  });
  await expect(service.claimRetainedSource(source.id, 1, source.binding, source.permit, source)).rejects.toThrow('Verify this exact restore');
  await expect(fs.stat(path.join(source.journal.directory, 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await service.retainedStatus(source.id, 1)).status).toBe('reviewed');
});

it('preserves journal-owned source and receipt on admission callback failure, with explicit reload recovery', async () => {
  const source = await retainedSource();
  await expect(
    service.claimRetainedSource(source.id, 1, source.binding, source.permit, {
      ...source,
      prepare: async () => {
        throw new Error('Declared preparation boundary failure');
      },
    }),
  ).rejects.toThrow('preserved in its restore journal');
  const payload = path.join(source.journal.directory, 'source', 'payload');
  expect(await fs.readFile(path.join(payload, 'content', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
  await service.onModuleDestroy();
  service = construct();
  expect((await service.list(1)).available).toBe(true);
  expect((await readRetainedRestoreReceipt(source.journal))?.restoreId).toBe(source.journal.state.id);
  await source.journal.discardStaging();
  expect(source.journal.state.phase).toBe('discarded');
  expect(await fs.readFile(path.join(payload, 'content', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

it('uses the existing file, database and source-seal review for a server-owned retained point without a second password', async () => {
  const fixture = await retainedFixture();
  let id = '';
  const result = await service.reviewRetained(1, fixture.expected, fixture.open, new AbortController().signal, (value) => {
    id = value;
  });
  expect(result.id).toBe(id);
  expect(result.review.manifestSha256).toBe(fixture.expected.manifestSha256);
  expect(result.review.databaseValidation).toBe('validated');
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect((await service.list(1)).jobs).toEqual([]);
  await expect(service.retainedStatus(id, 2)).rejects.toThrow('not found');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'content', 'database', 'job.json', 'review-seal.json']);
});

it('rejects a mismatched retained ciphertext hash before opening plaintext or reviewing the database', async () => {
  const fixture = await retainedFixture();
  let id = '';
  await expect(
    service.reviewRetained(1, { ...fixture.expected, archiveSha256: '0'.repeat(64) }, fixture.open, new AbortController().signal, (value) => {
      id = value;
    }),
  ).rejects.toThrow('checksum');
  expect(database.review).not.toHaveBeenCalled();
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
  expect((await service.retainedStatus(id, 1)).status).toBe('failed');
});

it('rejects a mismatched retained manifest after review and removes every plaintext result', async () => {
  const fixture = await retainedFixture();
  let id = '';
  await expect(
    service.reviewRetained(1, { ...fixture.expected, manifestSha256: '0'.repeat(64) }, fixture.open, new AbortController().signal, (value) => {
      id = value;
    }),
  ).rejects.toThrow('manifest identity');
  expect(database.review).toHaveBeenCalledTimes(1);
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
  expect((await service.retainedStatus(id, 1)).status).toBe('failed');
});

it('rejects an already-aborted retained review before allocating an import or touching its reader', async () => {
  const fixture = await retainedFixture();
  const abort = new AbortController();
  abort.abort();
  const open = vi.fn(fixture.open);
  const registered = vi.fn();
  await expect(service.reviewRetained(1, fixture.expected, open, abort.signal, registered)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(registered).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(root, 'live', 'backups', 'imports'))).toEqual([]);
});

async function finish(id: string) {
  await vi.waitFor(async () => expect(['uploading', 'reviewing']).not.toContain((await service.list(1)).jobs.find((job) => job.id === id)?.status), {
    timeout: 10_000,
  });
  return (await service.list(1)).jobs.find((job) => job.id === id);
}
async function upload() {
  const fixture = await fullBackupFixture(root);
  const job = await service.create(1, credentials);
  const uploaded = await service.receive(job.id, 1, createReadStream(fixture.encrypted), String((await fs.stat(fixture.encrypted)).size));
  expect(uploaded.status).toBe('uploaded');
  return { fixture, id: job.id };
}

it('uploads and authenticates a complete backup for review without replacing live settings or app data', async () => {
  const { id, fixture } = await upload();
  await service.review(id, 1, credentials, fixturePassphrase);
  const job = await finish(id);
  expect(job?.status).toBe('reviewed');
  expect(job?.review?.fileCount).toBe(fixture.manifest.files.length + 3);
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'content', 'database', 'job.json', 'review-seal.json']);
  expect(job?.review?.databaseValidation).toBe('validated');
  expect(job?.review?.databaseRecords).toBe(1);
  expect(database.review.mock.calls[0]?.[0]).toBe(path.join(directory(id), 'content'));
  const metadata = await fs.readFile(path.join(directory(id), 'job.json'), 'utf8');
  expect(metadata).not.toContain(fixturePassphrase);
  expect(metadata).not.toContain(credentials.password);
  expect(metadata).not.toContain('jwtSecret');
  expect((await service.list(2)).jobs).toEqual([]);
  await expect(service.review(id, 2, credentials, fixturePassphrase)).rejects.toThrow('not found');
});

it('keeps only the encrypted file after a wrong passphrase and supports an authenticated retry', async () => {
  const { id } = await upload();
  await service.review(id, 1, credentials, 'different-disposable-passphrase');
  expect((await finish(id))?.status).toBe('failed');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
  await service.review(id, 1, credentials, fixturePassphrase);
  expect((await finish(id))?.status).toBe('reviewed');
});

it('does not approve a file-only review when isolated database validation fails', async () => {
  const { id } = await upload();
  database.review.mockRejectedValueOnce(new Error('disposable private database error'));
  await service.review(id, 1, credentials, fixturePassphrase);
  const result = await finish(id);
  expect(result?.status).toBe('failed');
  expect(result?.review).toBeUndefined();
  expect(result?.message).not.toContain('disposable private database error');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

it('counts installed apps from validated records, including stopped apps without containers', async () => {
  const { id } = await upload();
  database.review.mockResolvedValueOnce({ counts: { user: 1, app_store: 1, app: 2, link: 0 }, bytes: 1, sha256: '0'.repeat(64) });
  await service.review(id, 1, credentials, fixturePassphrase);
  const result = await finish(id);
  expect(result?.status).toBe('reviewed');
  expect(result?.review?.appCount).toBe(2);
  expect(result?.review?.databaseRecords).toBe(4);
});

it('reports the database stage and forwards cancellation to its isolated reviewer', async () => {
  const { id } = await upload();
  database.review.mockImplementationOnce(async (_content, destination: string, signal: AbortSignal, progress: (bytes: number) => void) => {
    await fs.mkdir(destination, { mode: 0o700 });
    progress(123);
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  await service.review(id, 1, credentials, fixturePassphrase);
  await vi.waitFor(async () => expect((await service.list(1)).jobs[0]?.stage).toBe('database'));
  expect((await service.list(1)).jobs[0]?.status).toBe('reviewing');
  await service.cancel(id, 1);
  expect((await service.list(1)).jobs[0]?.status).toBe('cancelled');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
});

it.each(['wrong-header', 'truncated'] as const)('rejects a %s upload and removes partial files', async (failure) => {
  const job = await service.create(1, credentials);
  const bytes = failure === 'wrong-header' ? Buffer.alloc(100, 2) : Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(20)]);
  const result = await service.receive(job.id, 1, Readable.from([bytes]), '100');
  expect(result.status).toBe('failed');
  expect(await fs.readdir(directory(job.id))).toEqual(['job.json']);
});

it('reauthenticates creation and review before processing private files', async () => {
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Authentication failed'));
  await expect(service.create(1, credentials)).rejects.toThrow('Authentication failed');
  expect((await service.list(1)).jobs).toEqual([]);
  const { id } = await upload();
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Authentication failed'));
  await expect(service.review(id, 1, credentials, fixturePassphrase)).rejects.toThrow('Authentication failed');
  expect((await service.list(1)).jobs[0]?.status).toBe('uploaded');
});

it('reserves an operator upload without fresh credentials while retaining owner isolation', async () => {
  auth.verifySensitiveAction.mockClear();
  const job = await service.createUpload(1);
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  await expect(service.receive(job.id, 2, Readable.from([Buffer.alloc(52)]), '52')).rejects.toThrow('not found');
  await expect(service.reviewUpload(job.id, 2, '12345678')).rejects.toThrow('not found');
  expect((await service.list(1)).jobs[0]?.id).toBe(job.id);
  expect((await service.list(2)).jobs).toEqual([]);
});

it('cancels a streaming upload without leaving its file descriptor or partial payload', async () => {
  const job = await service.create(1, credentials);
  const stream = new PassThrough();
  const receiving = service.receive(job.id, 1, stream);
  stream.write(Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(100)]));
  await vi.waitFor(async () => expect((await service.list(1)).jobs[0]?.completedBytes).toBe(108));
  expect((await service.cancel(job.id, 1)).status).toBe('cancelled');
  await receiving;
  expect(stream.destroyed).toBe(true);
  expect(await fs.readdir(directory(job.id))).toEqual(['job.json']);
});

it('reserves workspace access against concurrent full exports and preflights decryption space', async () => {
  const { id } = await upload();
  const release = acquireBackupDisk();
  try {
    await expect(service.review(id, 1, credentials, fixturePassphrase)).rejects.toThrow('Another backup transfer');
  } finally {
    release();
  }
  const uploadedBytes = (await fs.stat(path.join(directory(id), 'backup.orbis'))).size;
  vi.spyOn(fs, 'statfs').mockResolvedValueOnce({ bavail: 256 * 1024 * 1024 + uploadedBytes - 53, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>);
  await service.review(id, 1, credentials, fixturePassphrase);
  const result = await finish(id);
  expect(result?.status).toBe('failed');
  expect(result?.message).toContain('not enough free storage to open');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
});

it('clears plaintext and invalidates old review state on process restart', async () => {
  const { id } = await upload();
  await service.review(id, 1, credentials, fixturePassphrase);
  await finish(id);
  await service.onModuleDestroy();
  service = construct();
  await service.onModuleInit();
  expect((await service.list(1)).jobs[0]?.status).toBe('uploaded');
  expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']);
});

it('expires plaintext on its timer even without a client making further requests', async () => {
  await service.onModuleDestroy();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  service = construct();
  await service.onModuleInit();
  const { id } = await upload();
  await service.review(id, 1, credentials, fixturePassphrase);
  await finish(id);
  const original = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(original + 16 * 60_000);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(async () => expect((await fs.readdir(directory(id))).sort()).toEqual(['backup.orbis', 'job.json']));
});

it('limits concurrent import creation without leaving excess directories', async () => {
  const result = await Promise.allSettled(Array.from({ length: 34 }, () => service.create(1, credentials)));
  expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(32);
  expect((await service.list(1)).jobs).toHaveLength(32);
  expect(await fs.readdir(path.join(root, 'live', 'backups', 'imports'))).toHaveLength(32);
});

it('ignores a disconnect notification for an unknown or foreign import safely', async () => {
  expect(() => service.abort('unknown', 1)).not.toThrow();
  const job = await service.create(1, credentials);
  expect(() => service.abort(job.id, 2)).not.toThrow();
  expect((await service.list(1)).jobs[0]?.status).toBe('awaiting-upload');
});

it.each(['cancel', 'remove'] as const)('reserves the import while %s cleanup is awaiting disk I/O', async (action) => {
  const { id } = await upload();
  await service.review(id, 1, credentials, fixturePassphrase);
  await finish(id);
  const actualRemove = fs.rm.bind(fs);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const selected = action === 'remove' ? directory(id) : path.join(directory(id), 'content');
  vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === selected) {
      entered();
      await waiting;
    }
    return actualRemove(file, options);
  });
  const cleanup = service[action](id, 1);
  await started;
  try {
    await expect(service.review(id, 1, credentials, fixturePassphrase)).rejects.toThrow('expiring');
    await service.list(1);
  } finally {
    release();
    await cleanup;
  }
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

async function reviewedSource() {
  vi.stubEnv('ORBIS_VERSION', 'v1.0.0');
  const { id } = await upload();
  await service.review(id, 1, credentials, fixturePassphrase);
  const job = await finish(id);
  expect(job?.status).toBe('reviewed');
  const store = path.join(root, 'live', 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state', 'app-data'],
  });
  const manifestSha256 = job?.review?.manifestSha256;
  if (!manifestSha256) throw new Error('Missing reviewed fixture manifest');
  return { id, store, journal, manifestSha256, signal: new AbortController().signal };
}

it('claims a reviewed owner-bound source using the same still-valid operator session', async () => {
  const source = await reviewedSource();
  const actor = { userId: 1, sessionBinding: 'session', securityBinding: 'security', revision: 0 };
  const before = auth.verifySensitiveAction.mock.calls.length;
  const result = await service.claimReviewedSourceForSession(source.id, 1, {} as never, undefined, actor, source);
  expect(result.seal.manifest.sha256).toBe(source.manifestSha256);
  expect(auth.verifySensitiveAction.mock.calls.length).toBe(before);
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

it('reverifies account access and moves an approved source out of import expiry into its active restore journal', async () => {
  const source = await reviewedSource();
  const before = auth.verifySensitiveAction.mock.calls.length;
  const result = await service.claimReviewedSource(source.id, 1, credentials, source);
  expect(auth.verifySensitiveAction.mock.calls.length).toBe(before + 1);
  expect(result.directory).toBe(path.join(source.journal.directory, 'source', 'payload'));
  expect(result.seal.manifest.sha256).toBe(source.manifestSha256);
  expect(result.source.file).toBe(path.join(result.directory, 'database', 'records.ndjson'));
  expect(result.resumeApps).toEqual([]);
  expect((await service.list(1)).jobs).toEqual([]);
  await expect(fs.lstat(directory(source.id))).rejects.toHaveProperty('code', 'ENOENT');
  expect(await fs.readFile(path.join(result.directory, 'content', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
  await service.onModuleDestroy();
  service = construct();
  await service.onModuleInit();
  expect((await service.list(1)).jobs).toEqual([]);
  expect(await fs.stat(result.source.file)).toMatchObject({ size: result.seal.normalized.bytes });
});

it.each(['foreign-owner', 'authentication', 'changed-manifest', 'expired', 'cancelled', 'changed-files', 'wrong-journal'] as const)(
  'preserves the encrypted import when preparation rejects %s',
  async (failure) => {
    const source = await reviewedSource();
    let owner = 1;
    if (failure === 'foreign-owner') owner = 2;
    if (failure === 'authentication') auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Authentication failed'));
    if (failure === 'changed-manifest') source.manifestSha256 = '0'.repeat(64);
    if (failure === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    if (failure === 'cancelled') source.signal = AbortSignal.abort();
    if (failure === 'changed-files') await fs.appendFile(path.join(directory(source.id), 'content', 'recovery.json'), ' ');
    if (failure === 'wrong-journal') source.journal = { directory: root, state: source.journal.state } as BackupRestoreJournal;
    await expect(service.claimReviewedSource(source.id, owner, credentials, source)).rejects.toThrow();
    expect((await fs.stat(path.join(directory(source.id), 'backup.orbis'))).size).toBeGreaterThan(52);
    expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
    await expect(fs.lstat(path.join(source.store, source.journal.state.id, 'source'))).rejects.toHaveProperty('code', 'ENOENT');
  },
);

it('reserves preparation against retention, upload, removal and ordinary import cancellation while pinning', async () => {
  const source = await reviewedSource();
  const actualRename = fs.rename.bind(fs);
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === directory(source.id)) {
      enter();
      await waiting;
    }
    return actualRename(from, to);
  });
  const preparing = service.claimReviewedSource(source.id, 1, credentials, source);
  await entered;
  try {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60_000);
    expect((await service.list(1)).jobs[0]?.status).toBe('preparing');
    await expect(service.remove(source.id, 1)).rejects.toThrow('active');
    await expect(service.cancel(source.id, 1)).rejects.toThrow('restore progress');
    await expect(service.review(source.id, 1, credentials, fixturePassphrase)).rejects.toThrow('current');
    expect(() => acquireBackupDisk()).toThrow('Another backup');
    await expect(acquireRestoreLease(source.store)).rejects.toThrow();
  } finally {
    release();
  }
  const result = await preparing;
  expect((await service.list(1)).jobs).toEqual([]);
  expect(await fs.stat(path.join(result.directory, 'backup.orbis'))).toMatchObject({ nlink: 1 });
});

it('preserves a pinned source for recovery and retires its import when directory synchronization fails after the move', async () => {
  const source = await reviewedSource();
  const reservation = path.join(source.journal.directory, 'source');
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await actualOpen(file, flags, mode);
    if (String(file) === reservation) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Disposable fsync failure'));
    return handle;
  });
  await expect(service.claimReviewedSource(source.id, 1, credentials, source)).rejects.toThrow('preserved in its restore journal');
  expect((await service.list(1)).available).toBe(false);
  expect((await service.list(1)).jobs).toEqual([]);
  const pinned = path.join(reservation, 'payload');
  expect((await fs.stat(path.join(pinned, 'backup.orbis'))).size).toBeGreaterThan(52);
  expect(await fs.readFile(path.join(pinned, 'content', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
  await expect(fs.lstat(directory(source.id))).rejects.toHaveProperty('code', 'ENOENT');
});

it('keeps both preparation leases until the pinned-source callback has finished', async () => {
  const source = await reviewedSource();
  let enter: () => void = () => undefined;
  let resume: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const preparing = service.claimReviewedSource(source.id, 1, credentials, {
    ...source,
    prepare: async (claimed, signal) => {
      expect(claimed.seal.manifest.sha256).toBe(source.manifestSha256);
      expect(await fs.readFile(path.join(claimed.directory, 'content', 'app-data', 'document'), 'utf8')).toBe('fixture app content');
      expect(signal.aborted).toBe(false);
      enter();
      await waiting;
      return { filesPrepared: true };
    },
  });
  await entered;
  try {
    expect(() => acquireBackupDisk()).toThrow('Another backup');
    await expect(acquireRestoreLease(source.store)).rejects.toThrow();
    expect((await source.journal.refresh()).phase).toBe('staging');
  } finally {
    resume();
  }
  expect((await preparing).preparation).toEqual({ filesPrepared: true });
  const disk = acquireBackupDisk();
  disk();
  const lease = await acquireRestoreLease(source.store);
  lease();
});

it('preserves claimed files and releases both leases when later preparation fails', async () => {
  const source = await reviewedSource();
  await expect(
    service.claimReviewedSource(source.id, 1, credentials, {
      ...source,
      prepare: async () => {
        throw new Error('Disposable preparation failure');
      },
    }),
  ).rejects.toThrow('preserved in its restore journal');
  expect((await service.list(1)).available).toBe(false);
  expect((await service.list(1)).jobs).toEqual([]);
  expect(await fs.readFile(path.join(source.journal.directory, 'source', 'payload', 'content', 'app-data', 'document'), 'utf8')).toBe(
    'fixture app content',
  );
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
  expect((await source.journal.refresh()).phase).toBe('staging');
  const disk = acquireBackupDisk();
  disk();
  const lease = await acquireRestoreLease(source.store);
  lease();
});

it('saved server archives enter the ordinary encrypted import and still require archive-key verification', async () => {
  const fixture = await fullBackupFixture(root);
  const bytes = await fs.readFile(fixture.encrypted);
  const source = Readable.from(bytes);
  const uploaded = await service.receiveServerExport(1, source, bytes.length);
  expect(uploaded.status).toBe('uploaded');
  expect(uploaded.review).toBeUndefined();
  expect(auth.verifySensitiveAction).not.toHaveBeenCalled();
  await service.review(uploaded.id, 1, credentials, 'incorrect archive key');
  expect((await finish(uploaded.id))?.status).toBe('failed');
  await service.review(uploaded.id, 1, credentials, fixturePassphrase);
  expect((await finish(uploaded.id))?.status).toBe('reviewed');
  expect(await fs.readFile(path.join(root, 'live', 'preserve'), 'utf8')).toBe('live server fixture');
});

it('reuses a pinned archive through fresh decryption and rejects a different reviewed manifest', async () => {
  const source = await reviewedSource();
  const pinned = await service.claimReviewedSource(source.id, 1, credentials, source);
  const file = path.join(pinned.directory, 'backup.orbis');
  const before = createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
  const copied = await service.reuseRestore(source.journal, 1, source.manifestSha256, new AbortController().signal);
  await service.reviewUpload(copied.id, 1, fixturePassphrase);
  expect((await finish(copied.id))?.status).toBe('reviewed');
  expect((await service.list(1)).jobs.find((job) => job.id === copied.id)?.review?.manifestSha256).toBe(source.manifestSha256);
  const different = await service.reuseRestore(source.journal, 1, '0'.repeat(64), new AbortController().signal);
  await service.reviewUpload(different.id, 1, fixturePassphrase);
  expect((await finish(different.id))?.status).toBe('failed');
  expect(
    createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex'),
  ).toBe(before);
});
