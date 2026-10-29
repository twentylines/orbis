import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { BackupImportsService } from '../system-backups/backup-imports.service';
import { SystemBackupsService } from '../system-backups/system-backups.service';
import { TransferTransport, transferLimits, type TransferTarget } from './transfer-transport';
import { sourceCertificate, type SourceCertificateInput } from './transfer-certificates';

type Credentials = { password: string; totpCode?: string };
type OfferStatus = 'awaiting-claim' | 'awaiting-approval' | 'approved' | 'sending' | 'complete' | 'failed' | 'cancelled' | 'expired';
type Offer = {
  id: string;
  ownerId: number;
  backupId: string;
  codeHash: string;
  sourceFingerprint: string;
  destinationFingerprint?: string;
  claimId?: string;
  tokenHash?: string;
  status: OfferStatus;
  expiresAt: number;
  bytes: number;
  completedBytes: number;
  stream: Readable;
  output?: Readable;
  timer?: ReturnType<typeof setTimeout>;
};
type TransferJob = {
  id: string;
  ownerId: number;
  importId: string;
  sourceOrigin: string;
  sourceFingerprint: string;
  destinationFingerprint: string;
  claimId: string;
  claimToken: string;
  target: TransferTarget;
  totalBytes: number;
  completedBytes: number;
  expiresAt: number;
  status: 'awaiting-source-approval' | 'checking-approval' | 'receiving' | 'complete' | 'failed' | 'cancelled' | 'expired';
  message: string;
  abort?: AbortController;
  done?: Promise<void>;
};
const secret = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validSecret = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (left: string, right: string) => timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const terminal = new Set(['complete', 'failed', 'cancelled', 'expired']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Provide the transfer details.');
  return value as Record<string, unknown>;
}

@Injectable()
export class HostTransferService implements OnModuleDestroy {
  private readonly offers = new Map<string, Offer>();
  private readonly jobs = new Map<string, TransferJob>();
  private creatingOffers = 0;
  private creatingImports = 0;
  private closing = false;

  constructor(
    private readonly backups: SystemBackupsService,
    private readonly imports: BackupImportsService,
    private readonly auth: AuthService,
    private readonly transport: TransferTransport,
  ) {}

  private publicOffer(offer: Offer) {
    return {
      id: offer.id,
      backupId: offer.backupId,
      sourceFingerprint: offer.sourceFingerprint,
      destinationFingerprint: offer.destinationFingerprint,
      status: offer.status,
      expiresAt: offer.expiresAt,
      bytes: offer.bytes,
      completedBytes: offer.completedBytes,
    };
  }
  private publicJob(job: TransferJob) {
    return {
      id: job.id,
      importId: job.importId,
      sourceOrigin: job.sourceOrigin,
      sourceFingerprint: job.sourceFingerprint,
      destinationFingerprint: job.destinationFingerprint,
      status: job.status,
      expiresAt: job.expiresAt,
      completedBytes: job.completedBytes,
      totalBytes: job.totalBytes,
      message: job.message,
      requiresReview: true,
    };
  }
  private clearCertificate(job: TransferJob) {
    if (!job.target.certificate) return;
    const target = { ...job.target };
    delete target.certificate;
    job.target = Object.freeze(target);
  }
  private clean() {
    const now = Date.now();
    for (const [id, offer] of this.offers) {
      if (now > offer.expiresAt && !terminal.has(offer.status)) {
        offer.status = 'expired';
        offer.output?.destroy();
        offer.stream.destroy();
      }
      if (now > offer.expiresAt + transferLimits.pendingMs) {
        clearTimeout(offer.timer);
        this.offers.delete(id);
      }
    }
    for (const [id, job] of this.jobs) {
      if (now > job.expiresAt && !job.done && !terminal.has(job.status)) {
        job.status = 'expired';
        job.claimToken = '';
        this.clearCertificate(job);
        job.message = 'This transfer expired. Create a new transfer on the source server.';
      }
      if (now > job.expiresAt + transferLimits.transferMs && !job.done) this.jobs.delete(id);
    }
  }
  private ownedOffer(id: string, ownerId: number) {
    this.clean();
    const offer = this.offers.get(id);
    if (!offer || offer.ownerId !== ownerId) throw new NotFoundException('Transfer offer not found.');
    return offer;
  }
  private ownedJob(id: string, ownerId: number) {
    this.clean();
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Transfer not found.');
    return job;
  }
  private deadline(offer: Offer, milliseconds: number) {
    clearTimeout(offer.timer);
    offer.expiresAt = Date.now() + milliseconds;
    offer.timer = setTimeout(() => {
      if (terminal.has(offer.status)) return;
      offer.status = 'expired';
      offer.output?.destroy();
      offer.stream.destroy();
    }, milliseconds);
    offer.timer.unref();
  }
  list(ownerId: number) {
    this.clean();
    return {
      offers: [...this.offers.values()].filter((offer) => offer.ownerId === ownerId).map((offer) => this.publicOffer(offer)),
      jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId).map((job) => this.publicJob(job)),
    };
  }
  async offer(ownerId: number, backupId: unknown, credentials: Credentials, confirmed: unknown) {
    if (confirmed !== true || typeof backupId !== 'string' || !uuid.test(backupId))
      throw new BadRequestException('Explicitly approve sharing this completed encrypted full backup.');
    this.clean();
    const active = [...this.offers.values()].filter((offer) => !terminal.has(offer.status)).length;
    if (this.closing || active + this.creatingOffers >= transferLimits.offers || this.offers.size + this.creatingOffers >= transferLimits.jobs)
      throw new ConflictException('Cancel or finish an existing transfer offer before creating another.');
    this.creatingOffers++;
    let opened: Awaited<ReturnType<SystemBackupsService['download']>> | undefined;
    try {
      opened = await this.backups.download(backupId, ownerId, credentials);
      if (this.closing || opened.bytes < 52 || opened.bytes > transferLimits.bytes)
        throw new ConflictException('This encrypted backup cannot be transferred.');
      const code = secret();
      const offer: Offer = {
        id: randomUUID(),
        ownerId,
        backupId,
        codeHash: digest(code),
        sourceFingerprint: secret(),
        status: 'awaiting-claim',
        expiresAt: 0,
        bytes: opened.bytes,
        completedBytes: 0,
        stream: opened.stream,
      };
      opened.stream.on('error', () => {
        if (!terminal.has(offer.status)) offer.status = 'failed';
        offer.output?.destroy();
      });
      this.deadline(offer, transferLimits.pendingMs);
      this.offers.set(offer.id, offer);
      opened = undefined;
      return { ...this.publicOffer(offer), code };
    } finally {
      opened?.stream.destroy();
      this.creatingOffers--;
    }
  }
  claim(body: unknown) {
    const value = object(body);
    if (
      !validSecret(value.code) ||
      !validSecret(value.destinationFingerprint) ||
      Object.keys(value).some((key) => !['code', 'destinationFingerprint'].includes(key))
    )
      throw new BadRequestException('Provide the one-use transfer code and destination fingerprint.');
    this.clean();
    const hash = digest(value.code);
    const offer = [...this.offers.values()].find((entry) => entry.status === 'awaiting-claim' && equal(entry.codeHash, hash));
    if (!offer || this.closing) throw new NotFoundException('The transfer code is invalid, used or expired.');
    const token = secret();
    offer.status = 'awaiting-approval';
    offer.codeHash = digest(secret());
    offer.destinationFingerprint = value.destinationFingerprint;
    offer.claimId = randomUUID();
    offer.tokenHash = digest(token);
    return { claimId: offer.claimId, claimToken: token, sourceFingerprint: offer.sourceFingerprint, bytes: offer.bytes, expiresAt: offer.expiresAt };
  }
  private claimed(body: unknown) {
    const value = object(body);
    if (
      typeof value.claimId !== 'string' ||
      !uuid.test(value.claimId) ||
      !validSecret(value.claimToken) ||
      Object.keys(value).some((key) => !['claimId', 'claimToken'].includes(key))
    )
      throw new NotFoundException('Transfer claim not found.');
    this.clean();
    const hash = digest(value.claimToken);
    const offer = [...this.offers.values()].find((entry) => entry.claimId === value.claimId && entry.tokenHash && equal(entry.tokenHash, hash));
    if (!offer || terminal.has(offer.status) || this.closing) throw new NotFoundException('Transfer claim not found or expired.');
    return offer;
  }
  peerStatus(body: unknown) {
    const offer = this.claimed(body);
    return { status: offer.status, sourceFingerprint: offer.sourceFingerprint, bytes: offer.bytes, expiresAt: offer.expiresAt };
  }
  async approve(id: string, ownerId: number, credentials: Credentials, destinationFingerprint: unknown) {
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const offer = this.ownedOffer(id, ownerId);
    if (offer.status !== 'awaiting-approval' || !validSecret(destinationFingerprint) || offer.destinationFingerprint !== destinationFingerprint)
      throw new ConflictException('Compare and explicitly approve the fingerprint shown on the destination server.');
    offer.status = 'approved';
    this.deadline(offer, transferLimits.pendingMs);
    return this.publicOffer(offer);
  }
  file(body: unknown) {
    const offer = this.claimed(body);
    if (offer.status !== 'approved') throw new ConflictException('The source operator must approve this destination before sending the backup.');
    offer.status = 'sending';
    this.deadline(offer, transferLimits.transferMs);
    const output = Readable.from(
      (async function* () {
        try {
          for await (const chunk of offer.stream) {
            if (offer.status !== 'sending') throw new Error('Transfer cancelled');
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (offer.completedBytes + bytes.length > offer.bytes) throw new Error('Backup stream exceeded its declared size');
            offer.completedBytes += bytes.length;
            yield bytes;
          }
          if (offer.completedBytes !== offer.bytes) throw new Error('Backup stream ended early');
          if (offer.status === 'sending') offer.status = 'complete';
        } finally {
          if (offer.status === 'sending') offer.status = 'failed';
          clearTimeout(offer.timer);
          offer.stream.destroy();
        }
      })(),
      { objectMode: false },
    );
    output.on('error', () => undefined);
    output.on('close', () => {
      if (offer.status === 'sending') offer.status = 'failed';
      clearTimeout(offer.timer);
      offer.stream.destroy();
    });
    offer.output = output;
    return { stream: output, bytes: offer.bytes };
  }
  cancelOffer(id: string, ownerId: number) {
    const offer = this.ownedOffer(id, ownerId);
    if (!terminal.has(offer.status)) offer.status = 'cancelled';
    clearTimeout(offer.timer);
    offer.output?.destroy();
    offer.stream.destroy();
    return this.publicOffer(offer);
  }
  async createImport(ownerId: number, origin: unknown, code: unknown, credentials: Credentials, certificateInput: SourceCertificateInput = {}) {
    if (!validSecret(code)) throw new BadRequestException('Enter the 64-character transfer code from the source server.');
    const certificate = sourceCertificate(certificateInput);
    this.clean();
    if (this.closing || this.jobs.size + this.creatingImports >= transferLimits.jobs)
      throw new ConflictException('Finish existing transfers before creating another.');
    this.creatingImports++;
    let importId: string | undefined;
    try {
      const target = await this.transport.resolve(origin, certificate);
      const imported = await this.imports.create(ownerId, credentials);
      importId = imported.id;
      const destinationFingerprint = secret();
      const response = object(await this.transport.json(target, 'claim', { code, destinationFingerprint }, AbortSignal.timeout(12_000)));
      if (
        this.closing ||
        typeof response.claimId !== 'string' ||
        !uuid.test(response.claimId) ||
        !validSecret(response.claimToken) ||
        !validSecret(response.sourceFingerprint) ||
        !Number.isSafeInteger(response.bytes) ||
        Number(response.bytes) < 52 ||
        Number(response.bytes) > transferLimits.bytes ||
        !Number.isSafeInteger(response.expiresAt) ||
        Number(response.expiresAt) <= Date.now() ||
        Number(response.expiresAt) > Date.now() + transferLimits.pendingMs + 5000
      )
        throw new BadRequestException('The source returned an invalid or expired transfer claim.');
      const job: TransferJob = {
        id: randomUUID(),
        ownerId,
        importId,
        sourceOrigin: target.origin,
        target,
        destinationFingerprint,
        sourceFingerprint: response.sourceFingerprint,
        claimId: response.claimId,
        claimToken: response.claimToken,
        totalBytes: Number(response.bytes),
        completedBytes: 0,
        expiresAt: Number(response.expiresAt),
        status: 'awaiting-source-approval',
        message: 'Compare both fingerprints and approve this destination on the source server.',
      };
      this.jobs.set(job.id, job);
      return this.publicJob(job);
    } catch (error) {
      if (importId) await this.imports.remove(importId, ownerId);
      throw error;
    } finally {
      this.creatingImports--;
    }
  }
  start(id: string, ownerId: number, sourceFingerprint: unknown) {
    const job = this.ownedJob(id, ownerId);
    if (job.status !== 'awaiting-source-approval' || job.done || this.closing) throw new ConflictException('This transfer cannot be started again.');
    if (!validSecret(sourceFingerprint) || sourceFingerprint !== job.sourceFingerprint)
      throw new BadRequestException('Compare and confirm the fingerprint shown on the source server.');
    if ([...this.jobs.values()].some((entry) => entry.done)) throw new ConflictException('Wait for the current transfer to finish.');
    job.status = 'checking-approval';
    job.message = 'Checking source approval.';
    const abort = new AbortController();
    job.abort = abort;
    job.done = this.receive(job, abort.signal).finally(() => {
      job.done = undefined;
      job.abort = undefined;
    });
    return this.publicJob(job);
  }
  private async receive(job: TransferJob, signal: AbortSignal) {
    const timer = setTimeout(() => job.abort?.abort(), transferLimits.transferMs);
    timer.unref();
    let stream: Readable | undefined;
    try {
      const credentials = { claimId: job.claimId, claimToken: job.claimToken };
      const status = object(await this.transport.json(job.target, 'status', credentials, signal));
      signal.throwIfAborted();
      if (status.sourceFingerprint !== job.sourceFingerprint || status.bytes !== job.totalBytes) throw new Error('Source identity changed');
      if (status.status === 'awaiting-approval') {
        job.status = 'awaiting-source-approval';
        job.message = 'Approve the destination fingerprint on the source server before starting.';
        return;
      }
      if (status.status !== 'approved') throw new Error('Transfer is not approved');
      stream = await this.transport.download(job.target, credentials, job.totalBytes, signal);
      signal.throwIfAborted();
      job.status = 'receiving';
      job.expiresAt = Date.now() + transferLimits.transferMs;
      job.message = 'Receiving the encrypted backup. The source server remains unchanged.';
      const source = stream;
      const metered = Readable.from(
        (async function* () {
          for await (const chunk of source) {
            signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (job.completedBytes + bytes.length > job.totalBytes) throw new Error('Transfer byte limit exceeded');
            job.completedBytes += bytes.length;
            yield bytes;
          }
        })(),
        { objectMode: false },
      );
      const cancelled = () => {
        source.destroy();
        metered.destroy();
      };
      signal.addEventListener('abort', cancelled, { once: true });
      try {
        const result = await this.imports.receive(job.importId, job.ownerId, metered, String(job.totalBytes));
        signal.throwIfAborted();
        if (result.status !== 'uploaded' || job.completedBytes !== job.totalBytes) throw new Error('Encrypted backup receive failed');
        job.status = 'complete';
        job.message = 'Encrypted backup received. Enter its passphrase, review the restore plan and explicitly confirm restore on this server.';
      } finally {
        signal.removeEventListener('abort', cancelled);
        metered.destroy();
      }
    } catch {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.message = signal.aborted
        ? 'Transfer cancelled. No server data has been restored.'
        : 'Transfer failed. Check source approval, expiry, private HTTPS address and available storage. No server data has been restored.';
    } finally {
      clearTimeout(timer);
      stream?.destroy();
      if (terminal.has(job.status)) job.claimToken = '';
      if (terminal.has(job.status)) this.clearCertificate(job);
    }
  }
  async cancelImport(id: string, ownerId: number) {
    const job = this.ownedJob(id, ownerId);
    if (job.status === 'complete') return this.publicJob(job);
    job.abort?.abort();
    await job.done;
    await this.imports.cancel(job.importId, ownerId);
    job.status = 'cancelled';
    job.claimToken = '';
    this.clearCertificate(job);
    job.message = 'Transfer cancelled. No server data has been restored.';
    return this.publicJob(job);
  }
  async onModuleDestroy() {
    this.closing = true;
    for (const offer of this.offers.values()) {
      clearTimeout(offer.timer);
      offer.status = 'cancelled';
      offer.output?.destroy();
      offer.stream.destroy();
    }
    for (const job of this.jobs.values()) job.abort?.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
    this.offers.clear();
    this.jobs.clear();
  }
}
