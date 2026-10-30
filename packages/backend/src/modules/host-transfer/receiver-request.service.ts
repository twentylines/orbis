import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { BackupImportsService } from '../system-backups/backup-imports.service';
import { SystemBackupsService, type TransferArchiveGrant } from '../system-backups/system-backups.service';
import { sourceCertificate, type SourceCertificateInput } from './transfer-certificates';
import { TransferCapacity } from './transfer-capacity';
import { TransferTransport, transferLimits, privateTransferAddress, type TransferTarget } from './transfer-transport';
import {
  requestFields,
  requestId,
  requestSecret,
  requestTerminal,
  type IncomingRequestStatus,
  type OutgoingRequestStatus,
  type RequestEncryption,
} from './receiver-request.types';

type Credentials = { password: string; totpCode?: string };
type ExportProgress = { stage: string; completedBytes: number; totalBytes: number | null };
type Incoming = {
  id: string;
  nonce: string;
  peerAddress: string;
  tokenHash: string;
  sourceFingerprint: string;
  destinationFingerprint: string;
  ownerId?: number;
  reservedBy?: number;
  status: IncomingRequestStatus;
  createdAt: number;
  expiresAt: number;
  encryption?: RequestEncryption;
  grant?: TransferArchiveGrant;
  bytes: number | null;
  completedBytes: number;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
  output?: Readable;
};
type Outgoing = {
  id: string;
  ownerId: number;
  importId: string;
  requestId: string;
  nonce: string;
  token: string;
  target: TransferTarget;
  sourceFingerprint: string;
  destinationFingerprint: string;
  status: OutgoingRequestStatus;
  message: string;
  expiresAt: number;
  completedBytes: number;
  totalBytes: number | null;
  encryption?: RequestEncryption;
  exportProgress?: ExportProgress;
  release: () => void;
  abort?: AbortController;
  done?: Promise<void>;
};
const secret = () => randomBytes(32).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const missing = () => new NotFoundException('This restore request is unavailable or expired. Start a new request.');
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validBytes = (value: unknown): value is number => validCount(value) && value >= 52 && value <= transferLimits.bytes;

@Injectable()
export class ReceiverRequestService implements OnModuleDestroy {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();
  private closing = false;

  private readonly unregisterRetention: () => void;

  constructor(
    private readonly backups: SystemBackupsService,
    private readonly imports: BackupImportsService,
    private readonly auth: AuthService,
    private readonly transport: TransferTransport,
    private readonly capacity: TransferCapacity,
  ) {
    this.unregisterRetention = this.capacity.registerRetentionCleanup(() => this.clean());
  }

  private incomingView(value: Incoming) {
    let exportProgress: ExportProgress | undefined;
    if (value.status === 'exporting') {
      try {
        exportProgress = value.grant?.progress();
      } catch {
        value.status = 'failed';
        void value.grant?.cancel().catch(() => undefined);
      }
    }
    return {
      version: 1 as const,
      id: value.id,
      nonce: value.nonce,
      sourceFingerprint: value.sourceFingerprint,
      destinationFingerprint: value.destinationFingerprint,
      status: value.status,
      expiresAt: value.expiresAt,
      totalBytes: value.bytes,
      completedBytes: value.completedBytes,
      ...(value.encryption ? { encryption: value.encryption } : {}),
      ...(exportProgress ? { exportProgress } : {}),
    };
  }
  private outgoingView(value: Outgoing) {
    return {
      version: 1 as const,
      id: value.id,
      importId: value.importId,
      sourceOrigin: value.target.origin,
      sourceFingerprint: value.sourceFingerprint,
      destinationFingerprint: value.destinationFingerprint,
      status: value.status,
      expiresAt: value.expiresAt,
      totalBytes: value.totalBytes,
      completedBytes: value.completedBytes,
      message: value.message,
      canStart: value.status === 'awaiting-source-approval' && !value.done,
      requiresReview: true as const,
      ...(value.encryption ? { encryption: value.encryption } : {}),
      ...(value.exportProgress ? { exportProgress: value.exportProgress } : {}),
    };
  }
  private expire(value: Incoming) {
    if (requestTerminal.has(value.status)) return;
    value.status = 'expired';
    value.output?.destroy();
    void value.grant?.cancel().catch(() => undefined);
  }
  private deadline(value: Incoming, expiresAt: number) {
    clearTimeout(value.timer);
    value.expiresAt = expiresAt;
    value.timer = setTimeout(() => this.expire(value), Math.max(1, expiresAt - Date.now()));
    value.timer.unref();
  }
  private clean() {
    const now = Date.now();
    for (const [id, value] of this.incoming) {
      if (now >= value.expiresAt) this.expire(value);
      if (now > value.expiresAt + transferLimits.transferMs) {
        clearTimeout(value.timer);
        value.release();
        this.incoming.delete(id);
      }
    }
    for (const [id, value] of this.outgoing) {
      if (now >= value.expiresAt && !requestTerminal.has(value.status)) {
        value.status = 'expired';
        value.message = 'This restore request expired. No server data has been restored.';
        value.abort?.abort();
        if (!value.done) this.scrub(value);
      }
      if (now > value.expiresAt + transferLimits.transferMs && !value.done) {
        value.release();
        this.outgoing.delete(id);
      }
    }
  }
  list(ownerId: number) {
    this.clean();
    return {
      version: 1 as const,
      incoming: [...this.incoming.values()]
        .filter((value) => value.ownerId === ownerId || value.ownerId === undefined)
        .map((value) => this.incomingView(value)),
      outgoing: [...this.outgoing.values()].filter((value) => value.ownerId === ownerId).map((value) => this.outgoingView(value)),
    };
  }
  private ownedOutgoing(id: string, ownerId: number) {
    this.clean();
    const value = this.outgoing.get(id);
    if (!value || value.ownerId !== ownerId) throw missing();
    return value;
  }
  private peer(body: unknown, address: string) {
    this.clean();
    const input = requestFields(body, ['version', 'requestId', 'nonce', 'token', 'destinationFingerprint']);
    if (
      input.version !== 1 ||
      !requestId(input.requestId) ||
      !requestId(input.nonce) ||
      !requestSecret(input.token) ||
      !requestSecret(input.destinationFingerprint)
    )
      throw missing();
    const value = this.incoming.get(input.requestId);
    if (
      !value ||
      value.peerAddress !== address ||
      value.nonce !== input.nonce ||
      !equal(value.tokenHash, hash(input.token)) ||
      !equal(value.destinationFingerprint, input.destinationFingerprint)
    )
      throw missing();
    return value;
  }
  peerRequest(body: unknown, address: string) {
    this.clean();
    const input = requestFields(body, ['version', 'nonce', 'destinationFingerprint']);
    if (
      this.closing ||
      !privateTransferAddress(address) ||
      input.version !== 1 ||
      !requestId(input.nonce) ||
      !requestSecret(input.destinationFingerprint)
    )
      throw new BadRequestException('Provide a valid private restore request.');
    if ([...this.incoming.values()].some((value) => value.nonce === input.nonce))
      throw new ConflictException('This restore request was already submitted.');
    if ([...this.incoming.values()].some((value) => value.peerAddress === address && !requestTerminal.has(value.status)))
      throw new ConflictException('Finish or cancel the existing request from this private peer.');
    let reserved: Incoming | undefined;
    const release = this.capacity.reserveSource(() => !reserved || !requestTerminal.has(reserved.status));
    const token = secret();
    const value: Incoming = {
      id: randomUUID(),
      nonce: input.nonce,
      peerAddress: address,
      tokenHash: hash(token),
      destinationFingerprint: input.destinationFingerprint,
      sourceFingerprint: secret(),
      status: 'awaiting-approval',
      createdAt: Date.now(),
      expiresAt: Date.now() + transferLimits.pendingMs,
      bytes: null,
      completedBytes: 0,
      release,
    };
    reserved = value;
    this.incoming.set(value.id, value);
    this.deadline(value, value.expiresAt);
    return { ...this.incomingView(value), token };
  }
  peerStatus(body: unknown, address: string) {
    return this.incomingView(this.peer(body, address));
  }

  async approve(id: string, ownerId: number, credentials: Credentials, destinationFingerprint: unknown, encryption: unknown, passphrase?: unknown) {
    this.clean();
    const value = this.incoming.get(id);
    if (!value || value.status !== 'awaiting-approval' || value.ownerId !== undefined || value.reservedBy !== undefined || this.closing)
      throw missing();
    if (!requestSecret(destinationFingerprint) || !equal(destinationFingerprint, value.destinationFingerprint))
      throw new BadRequestException('Compare and confirm the fingerprint displayed on the destination.');
    if (encryption !== 'source-account-password' && encryption !== 'separate-passphrase')
      throw new BadRequestException('Choose how to encrypt this new backup.');
    if (encryption === 'source-account-password' && passphrase !== undefined) throw new BadRequestException('Choose one backup encryption method.');
    const archiveKey = encryption === 'source-account-password' ? credentials.password : passphrase;
    if (typeof archiveKey !== 'string' || archiveKey.trim().length < 12 || archiveKey.length > 1024)
      throw new BadRequestException('The backup password must be between 12 and 1024 characters. Choose a separate backup passphrase if needed.');
    value.status = 'approving';
    value.reservedBy = ownerId;
    try {
      const expiresAt = Date.now() + transferLimits.transferMs;
      const grant = await this.backups.startTransferExport(ownerId, credentials, archiveKey, value.id, expiresAt);
      if (
        this.closing ||
        value.status !== 'approving' ||
        value.reservedBy !== ownerId ||
        Date.now() >= value.expiresAt ||
        grant.requestId !== value.id
      ) {
        await grant.cancel();
        throw missing();
      }
      value.ownerId = ownerId;
      value.reservedBy = undefined;
      value.encryption = encryption;
      value.grant = grant;
      value.status = 'exporting';
      this.deadline(value, expiresAt);
      this.followExport(value, grant);
      return this.incomingView(value);
    } catch (error) {
      if (value.status === 'approving' && value.reservedBy === ownerId) {
        value.status = 'awaiting-approval';
        value.reservedBy = undefined;
      }
      throw error;
    }
  }
  private followExport(value: Incoming, grant: TransferArchiveGrant) {
    void grant.ready
      .then(async (summary) => {
        if (value.status !== 'exporting' || this.closing || Date.now() >= value.expiresAt || !validBytes(summary.bytes)) {
          if (!requestTerminal.has(value.status)) value.status = 'failed';
          await grant.cancel();
          return;
        }
        value.bytes = summary.bytes;
        value.status = 'ready';
      })
      .catch(() => {
        if (!requestTerminal.has(value.status)) value.status = 'failed';
      });
  }
  async reject(id: string, ownerId: number, credentials: Credentials) {
    this.clean();
    const value = this.incoming.get(id);
    if (!value || value.status !== 'awaiting-approval' || value.ownerId !== undefined || value.reservedBy !== undefined) throw missing();
    value.status = 'approving';
    value.reservedBy = ownerId;
    try {
      await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
      if (value.status !== 'approving' || value.reservedBy !== ownerId || this.closing) throw missing();
      value.ownerId = ownerId;
      value.reservedBy = undefined;
      value.status = 'rejected';
      clearTimeout(value.timer);
      return this.incomingView(value);
    } catch (error) {
      if (value.status === 'approving' && value.reservedBy === ownerId) {
        value.status = 'awaiting-approval';
        value.reservedBy = undefined;
      }
      throw error;
    }
  }
  private async cancelSource(value: Incoming) {
    if (requestTerminal.has(value.status)) return this.incomingView(value);
    value.status = 'cancelled';
    clearTimeout(value.timer);
    value.output?.destroy();
    await value.grant?.cancel();
    return this.incomingView(value);
  }
  async cancelIncoming(id: string, ownerId: number) {
    this.clean();
    const value = this.incoming.get(id);
    if (!value || value.ownerId !== ownerId) throw missing();
    return this.cancelSource(value);
  }
  async peerCancel(body: unknown, address: string) {
    return this.cancelSource(this.peer(body, address));
  }

  async peerFile(body: unknown, address: string) {
    const value = this.peer(body, address);
    if (value.status !== 'ready' || !value.grant || value.bytes === null || Date.now() >= value.expiresAt) throw missing();
    value.status = 'sending';
    const opened = await value.grant.open().catch((error: unknown) => {
      if (!requestTerminal.has(value.status)) value.status = 'failed';
      throw error;
    });
    if (value.status !== 'sending' || Date.now() >= value.expiresAt || opened.bytes !== value.bytes || !validBytes(opened.bytes)) {
      opened.stream.destroy();
      if (!requestTerminal.has(value.status)) value.status = 'failed';
      throw missing();
    }
    const input = opened.stream;
    const output = Readable.from(
      (async function* () {
        try {
          for await (const chunk of input) {
            if (value.status !== 'sending' || Date.now() >= value.expiresAt) throw missing();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (value.completedBytes + bytes.length > opened.bytes) throw missing();
            value.completedBytes += bytes.length;
            yield bytes;
          }
          if (value.completedBytes !== opened.bytes) throw missing();
          value.status = 'complete';
          clearTimeout(value.timer);
        } finally {
          input.destroy();
          if (value.status === 'sending') value.status = 'failed';
        }
      })(),
      { objectMode: false },
    );
    value.output = output;
    output.on('error', () => input.destroy());
    output.once('close', () => {
      input.destroy();
      if (value.status === 'sending') value.status = 'failed';
    });
    return { stream: output, bytes: opened.bytes };
  }

  async create(ownerId: number, origin: unknown, credentials: Credentials, confirmed: unknown, certificateInput: SourceCertificateInput = {}) {
    if (confirmed !== true) throw new BadRequestException('Confirm that you want to request a backup from this source.');
    this.clean();
    if (this.closing) throw missing();
    const release = this.capacity.reserveDestination();
    let importId: string | undefined;
    let saved = false;
    try {
      const target = await this.transport.resolve(origin, sourceCertificate(certificateInput));
      const imported = await this.imports.create(ownerId, credentials);
      importId = imported.id;
      const nonce = randomUUID();
      const destinationFingerprint = secret();
      const response = requestFields(
        await this.transport.json(target, 'request', { version: 1, nonce, destinationFingerprint }, AbortSignal.timeout(12_000)),
        ['version', 'id', 'nonce', 'sourceFingerprint', 'destinationFingerprint', 'status', 'expiresAt', 'totalBytes', 'completedBytes', 'token'],
      );
      if (
        this.closing ||
        response.version !== 1 ||
        !requestId(response.id) ||
        response.nonce !== nonce ||
        response.destinationFingerprint !== destinationFingerprint ||
        !requestSecret(response.sourceFingerprint) ||
        !requestSecret(response.token) ||
        response.status !== 'awaiting-approval' ||
        response.totalBytes !== null ||
        response.completedBytes !== 0 ||
        !Number.isSafeInteger(response.expiresAt) ||
        Number(response.expiresAt) <= Date.now() ||
        Number(response.expiresAt) > Date.now() + transferLimits.pendingMs + 5000
      )
        throw new BadRequestException('The source returned an invalid or expired restore request.');
      const value: Outgoing = {
        id: randomUUID(),
        ownerId,
        importId,
        requestId: response.id,
        nonce,
        token: response.token,
        target,
        sourceFingerprint: response.sourceFingerprint,
        destinationFingerprint,
        status: 'awaiting-source-approval',
        message: 'Compare the fingerprints and approve this request on the source server.',
        expiresAt: Number(response.expiresAt),
        completedBytes: 0,
        totalBytes: null,
        release,
      };
      this.outgoing.set(value.id, value);
      saved = true;
      return this.outgoingView(value);
    } catch (error) {
      if (importId) await this.imports.remove(importId, ownerId);
      throw error;
    } finally {
      if (!saved) release();
    }
  }
  private peerBody(value: Outgoing) {
    return { version: 1, requestId: value.requestId, nonce: value.nonce, token: value.token, destinationFingerprint: value.destinationFingerprint };
  }
  private scrub(value: Outgoing) {
    value.token = '';
    if (value.target.certificate) {
      const target = { ...value.target };
      delete target.certificate;
      value.target = Object.freeze(target);
    }
  }
  start(id: string, ownerId: number, sourceFingerprint: unknown, confirmed: unknown) {
    const value = this.ownedOutgoing(id, ownerId);
    if (this.closing || value.status !== 'awaiting-source-approval' || value.done) throw missing();
    if (confirmed !== true || !requestSecret(sourceFingerprint) || !equal(sourceFingerprint, value.sourceFingerprint))
      throw new BadRequestException('Compare and confirm the source fingerprint before receiving.');
    const release = this.capacity.reserveTransfer();
    value.status = 'checking-approval';
    value.message = 'Waiting for source approval.';
    value.abort = new AbortController();
    value.done = this.receive(value, value.abort.signal).finally(() => {
      release();
      value.done = undefined;
      value.abort = undefined;
    });
    return this.outgoingView(value);
  }
  private status(value: Outgoing, body: unknown) {
    const input = requestFields(
      body,
      [
        'version',
        'id',
        'nonce',
        'sourceFingerprint',
        'destinationFingerprint',
        'status',
        'expiresAt',
        'totalBytes',
        'completedBytes',
        'encryption',
        'exportProgress',
      ],
      2048,
    );
    if (
      input.version !== 1 ||
      input.id !== value.requestId ||
      input.nonce !== value.nonce ||
      input.sourceFingerprint !== value.sourceFingerprint ||
      input.destinationFingerprint !== value.destinationFingerprint ||
      typeof input.status !== 'string' ||
      !['awaiting-approval', 'approving', 'exporting', 'ready', 'sending', 'complete', 'rejected', 'cancelled', 'expired', 'failed'].includes(
        input.status,
      ) ||
      !Number.isSafeInteger(input.expiresAt) ||
      Number(input.expiresAt) > Date.now() + transferLimits.transferMs + 5000 ||
      !validCount(input.completedBytes) ||
      (input.totalBytes !== null && !validBytes(input.totalBytes)) ||
      (input.encryption !== undefined && input.encryption !== 'source-account-password' && input.encryption !== 'separate-passphrase')
    )
      throw new Error('Invalid source status');
    if (input.exportProgress !== undefined) {
      const progress = requestFields(input.exportProgress, ['stage', 'completedBytes', 'totalBytes']);
      if (
        typeof progress.stage !== 'string' ||
        progress.stage.length > 64 ||
        !validCount(progress.completedBytes) ||
        (progress.totalBytes !== null && !validCount(progress.totalBytes))
      )
        throw new Error('Invalid export progress');
      value.exportProgress = { stage: progress.stage, completedBytes: progress.completedBytes, totalBytes: progress.totalBytes as number | null };
    }
    return input;
  }
  private async receive(value: Outgoing, signal: AbortSignal) {
    const deadline = setTimeout(() => value.abort?.abort(), transferLimits.pendingMs + transferLimits.transferMs);
    deadline.unref();
    let stream: Readable | undefined;
    try {
      const credentials = this.peerBody(value);
      while (true) {
        signal.throwIfAborted();
        const state = this.status(value, await this.transport.json(value.target, 'request-status', credentials, signal));
        signal.throwIfAborted();
        if (Date.now() >= Number(state.expiresAt) || requestTerminal.has(String(state.status))) {
          value.status = state.status === 'rejected' ? 'rejected' : state.status === 'expired' ? 'expired' : 'failed';
          value.message =
            state.status === 'rejected'
              ? 'The source declined this restore request. No server data has been restored.'
              : 'The source cannot continue this restore request. No server data has been restored.';
          return;
        }
        value.expiresAt = Number(state.expiresAt);
        if (state.encryption) value.encryption = state.encryption as RequestEncryption;
        if (state.status === 'ready') {
          if (!validBytes(state.totalBytes) || !value.encryption) throw new Error('Invalid ready archive');
          value.totalBytes = state.totalBytes;
          break;
        }
        if (!['awaiting-approval', 'approving', 'exporting'].includes(String(state.status))) throw new Error('Source already claimed');
        value.status = state.status === 'exporting' ? 'source-exporting' : 'awaiting-source-approval';
        value.message = state.status === 'exporting' ? 'The source is creating an encrypted backup.' : 'Approve this request on the source server.';
        await delay(3000, undefined, { signal });
      }
      stream = await this.transport.download(value.target, credentials, value.totalBytes, signal, 'request-file');
      signal.throwIfAborted();
      value.status = 'receiving';
      value.message = 'Receiving the encrypted backup.';
      const input = stream;
      const metered = Readable.from(
        (async function* () {
          for await (const chunk of input) {
            signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (value.totalBytes === null || value.completedBytes + bytes.length > value.totalBytes) throw new Error('Transfer byte limit exceeded');
            value.completedBytes += bytes.length;
            yield bytes;
          }
        })(),
        { objectMode: false },
      );
      const cancelled = () => {
        input.destroy();
        metered.destroy();
      };
      signal.addEventListener('abort', cancelled, { once: true });
      try {
        const result = await this.imports.receive(value.importId, value.ownerId, metered, String(value.totalBytes));
        signal.throwIfAborted();
        if (result.status !== 'uploaded' || value.completedBytes !== value.totalBytes) throw new Error('Encrypted receive incomplete');
        value.status = 'complete';
        value.message = 'Backup received. Enter the original source account password or chosen backup passphrase to review it.';
      } finally {
        signal.removeEventListener('abort', cancelled);
        metered.destroy();
      }
    } catch {
      if (!requestTerminal.has(value.status)) {
        value.status = signal.aborted ? 'cancelled' : 'failed';
        value.message = signal.aborted
          ? 'Transfer cancelled. No server data has been restored.'
          : 'The restore request failed. Check approval, expiry, private HTTPS and storage. No server data has been restored.';
      }
    } finally {
      clearTimeout(deadline);
      stream?.destroy();
      this.scrub(value);
    }
  }
  async cancelOutgoing(id: string, ownerId: number) {
    const value = this.ownedOutgoing(id, ownerId);
    if (value.status === 'complete') return this.outgoingView(value);
    const body = this.peerBody(value);
    const target = value.target;
    value.status = 'cancelled';
    value.message = 'Transfer cancelled locally. No server data has been restored.';
    value.abort?.abort();
    await value.done;
    await this.imports.cancel(value.importId, ownerId);
    if (requestSecret(body.token)) {
      try {
        this.status(value, await this.transport.json(target, 'request-cancel', body, AbortSignal.timeout(12_000)));
      } catch {
        value.message = 'Transfer cancelled locally. Source cancellation could not be confirmed; its request will expire.';
      }
    }
    this.scrub(value);
    return this.outgoingView(value);
  }
  async onModuleDestroy() {
    this.unregisterRetention();
    this.closing = true;
    for (const value of this.incoming.values()) {
      clearTimeout(value.timer);
      value.output?.destroy();
      void value.grant?.cancel().catch(() => undefined);
      value.release();
    }
    for (const value of this.outgoing.values()) value.abort?.abort();
    await Promise.allSettled([...this.outgoing.values()].map((value) => value.done));
    for (const value of this.outgoing.values()) {
      this.scrub(value);
      value.release();
    }
    this.incoming.clear();
    this.outgoing.clear();
  }
}
