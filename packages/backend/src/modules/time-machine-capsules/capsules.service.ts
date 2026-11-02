import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { capsuleJobSchema, type CapsuleJob } from '@runtipi/common/schemas/time-machine-capsule';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { TimeMachineService } from '../system-backups/time-machine.service';
import { BackupDatabaseService } from '../system-backups/backup-database.service';
import { privateBackupDirectory } from '../system-backups/backup-files';
import { acquireBackupDisk } from '@/common/backup-disk';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { capsuleLimits, exportCapsule, importCapsule, type CapsuleSource } from './capsule';
import { verifyCapsuleContents } from './verify';

type Credentials = { password: string; totpCode?: string };
type Stored = CapsuleJob & { ownerId: number; pointId?: string };
const storedSchema = capsuleJobSchema.merge({ ownerId: 'number.integer > 0', 'pointId?': 'string' }).onUndeclaredKey('reject');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => new ConflictException('The capture archive could not be prepared or verified. Existing server data was preserved.');
@Injectable()
export class CapsulesService {
  private jobs = new Map<string, Stored>();
  private loaded?: Promise<void>;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private closing = false;
  private reserved: string | null = null;
  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly machine: TimeMachineService,
    private readonly database: BackupDatabaseService,
  ) {}
  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'capsules');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Capture archive not found.');
    return path.join(this.root(), id);
  }
  private public(job: Stored): CapsuleJob {
    const { ownerId: _owner, pointId: _point, ...value } = job;
    return capsuleJobSchema.assert(value);
  }
  private async initialize() {
    this.loaded ??= this.load();
    return this.loaded;
  }
  private async load() {
    await privateBackupDirectory(this.root());
    for (const id of await fs.readdir(this.root())) {
      if (!uuid.test(id)) throw fail();
      await privateBackupDirectory(this.directory(id));
      const handle = await fs.open(path.join(this.directory(id), 'job.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let job: Stored;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4096) throw fail();
        job = storedSchema.assert(JSON.parse(await handle.readFile('utf8'))) as Stored;
      } finally {
        await handle.close();
      }
      if (job.id !== id) throw fail();
      if (['running', 'verifying'].includes(job.status)) {
        job.status = 'failed';
        await this.save(job);
      }
      for (const name of await fs.readdir(this.directory(id))) {
        const temporary = /^\.(?:capsule-[a-f0-9-]{36}\.partial|segment-[a-f0-9-]{36}\.orbis)$/.test(name);
        const incomplete = name === 'capsule.orbis-tm' && (job.kind === 'export' ? job.status !== 'ready' : !job.bytes);
        if (!temporary && !incomplete) continue;
        const filename = path.join(this.directory(id), name);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
          throw fail();
        await fs.unlink(filename);
      }
      if (job.kind === 'import')
        for (const name of await fs.readdir(this.directory(id))) {
          if (!/^capsule-[A-Za-z0-9]{6}$/.test(name)) continue;
          const staging = path.join(this.directory(id), name);
          const stat = await fs.lstat(staging);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.mode & 0o077 ||
            (process.getuid && stat.uid !== process.getuid()) ||
            (await fs.realpath(staging)) !== staging
          )
            throw fail();
          await fs.rm(staging, { recursive: true });
        }
      this.jobs.set(id, job);
      if (this.jobs.size > 16) throw fail();
    }
  }
  private async save(job: Stored) {
    const dir = this.directory(job.id);
    await privateBackupDirectory(dir);
    const temp = path.join(dir, `.job-${randomUUID()}`);
    const file = await fs.open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(storedSchema.assert(job)));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(temp, path.join(dir, 'job.json'));
      const parent = await fs.open(dir, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  private async verifyAccount(request: Request, ownerId: number, credentials: Credentials) {
    const before = await this.auth.operatorActionContext(request);
    if (before.userId !== ownerId) throw fail();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const after = await this.auth.operatorActionContext(request);
    if (before.userId !== after.userId || before.sessionBinding !== after.sessionBinding || before.securityBinding !== after.securityBinding)
      throw fail();
  }
  private async owned(id: string, ownerId: number) {
    await this.initialize();
    this.directory(id);
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Capture archive not found.');
    return job;
  }
  async list(ownerId: number) {
    await this.initialize();
    return { jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId).map((job) => this.public(job)) };
  }
  private async create(ownerId: number, kind: Stored['kind']) {
    await this.initialize();
    if (this.closing || this.active || this.reserved || this.jobs.size >= 16) throw fail();
    const job: Stored = {
      id: randomUUID(),
      capsuleId: null,
      ownerId,
      kind,
      status: kind === 'export' ? 'running' : 'awaiting-upload',
      createdAt: Date.now(),
      completedBytes: 0,
      totalBytes: null,
      bytes: 0,
      sha256: null,
      restoreSupported: false,
    };
    this.reserved = job.id;
    try {
      await this.save(job);
      this.jobs.set(job.id, job);
    } finally {
      if (kind === 'import' || !this.jobs.has(job.id)) this.reserved = null;
    }
    return job;
  }
  async startExport(ownerId: number, request: Request, credentials: Credentials, pointId: string, passphrase: string) {
    if (!uuid.test(pointId) || typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024)
      throw new BadRequestException('Choose a capture and an archive passphrase of 12 to 1024 characters.');
    await this.verifyAccount(request, ownerId, credentials);
    const job = await this.create(ownerId, 'export');
    job.pointId = pointId;
    return {
      job: this.public(job),
      start: () =>
        this.run(job, async (signal) =>
          this.machine.withPortablePoint(pointId, ownerId, request, credentials, signal, async (value) => {
            if (value.point.version !== 2 || !value.point.archiveSha256 || !value.point.runtimeCipherSha256 || !value.point.metadataSha256)
              throw fail();
            const dir = path.join(this.config.get('directories').dataDir, 'backups', 'time-machine', 'points', pointId);
            const metadataStat = await fs.lstat(path.join(dir, 'metadata.orbis'));
            const entries: CapsuleSource[] = [
              { name: 'backup.orbis', bytes: value.point.archiveBytes, sha256: value.point.archiveSha256, source: value.source },
              {
                name: 'runtime.orbis',
                bytes: value.point.runtimeBytes,
                sha256: value.point.runtimeCipherSha256,
                file: path.join(dir, 'runtime.orbis'),
              },
              { name: 'metadata.orbis', bytes: metadataStat.size, sha256: value.point.metadataSha256, file: path.join(dir, 'metadata.orbis') },
            ];
            const preview = value.metadata.preview;
            if (preview.available && preview.wallpaperAsset.available)
              entries.push({
                name: 'wallpaper.orbis',
                bytes: preview.wallpaperAsset.bytes + 52,
                sha256: preview.wallpaperAsset.cipherSha256,
                file: path.join(dir, 'wallpaper.orbis'),
              });
            if (preview.available && preview.appIcons)
              entries.push({
                name: 'icons.orbis',
                bytes: preview.appIcons.bytes + 52,
                sha256: preview.appIcons.cipherSha256,
                file: path.join(dir, 'icons.orbis'),
              });
            if (
              [...this.jobs.values()].reduce((sum, item) => sum + item.bytes, 0) +
                entries.reduce((sum, item) => sum + item.bytes, 0) +
                8 * 1024 ** 2 >
              capsuleLimits.bytes + 8 * 1024 ** 2
            )
              throw fail();
            const result = await exportCapsule({
              destination: path.join(this.directory(job.id), 'capsule.orbis-tm'),
              pointId,
              createdAt: value.point.createdAt,
              pointKey: value.pointKey,
              entries,
              passphrase,
              signal: value.signal,
              progress: (done, total) => {
                job.completedBytes = done;
                job.totalBytes = total;
              },
            });
            job.bytes = result.bytes;
            job.capsuleId = result.capsuleId;
            job.sha256 = result.sha256;
            job.status = 'ready';
          }),
        ),
    };
  }
  private run(job: Stored, work: (signal: AbortSignal) => Promise<unknown>) {
    if (this.active || this.closing || this.reserved !== job.id) return;
    this.reserved = null;
    const abort = new AbortController();
    const active = { id: job.id, abort, done: Promise.resolve() };
    this.active = active;
    active.done = (async () => {
      let release: (() => void) | undefined;
      let disk: (() => void) | undefined;
      try {
        release = enterBackupMutation() ?? undefined;
        if (!release) throw fail();
        disk = acquireBackupDisk();
        await work(AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60_000)]));
        await this.save(job);
      } catch {
        job.status = abort.signal.aborted ? 'cancelled' : 'failed';
        if (job.kind === 'export') await fs.rm(path.join(this.directory(job.id), 'capsule.orbis-tm'), { force: true });
        await this.save(job).catch(() => undefined);
      } finally {
        disk?.();
        release?.();
        if (this.active === active) this.active = undefined;
      }
    })();
  }
  async createImport(ownerId: number, request: Request, credentials: Credentials) {
    await this.verifyAccount(request, ownerId, credentials);
    return this.public(await this.create(ownerId, 'import'));
  }
  async upload(id: string, ownerId: number, input: Readable, length: unknown, signal: AbortSignal) {
    const job = await this.owned(id, ownerId);
    if (
      job.kind !== 'import' ||
      job.status !== 'awaiting-upload' ||
      this.active ||
      this.reserved ||
      this.closing ||
      typeof length !== 'string' ||
      !/^\d{1,12}$/.test(length)
    )
      throw fail();
    const total = Number(length);
    if (!Number.isSafeInteger(total) || total < 64 || total > capsuleLimits.bytes + 8 * 1024 ** 2) throw fail();
    if ([...this.jobs.values()].reduce((sum, item) => sum + item.bytes, 0) + total > capsuleLimits.bytes + 8 * 1024 ** 2) throw fail();
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(60 * 60_000)]);
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = { id, abort, done };
    this.active = active;
    const cancelled = () => input.destroy(new Error('Capture upload cancelled.'));
    combined.addEventListener('abort', cancelled, { once: true });
    let release: (() => void) | undefined;
    let disk: (() => void) | undefined;
    const destination = path.join(this.directory(id), 'capsule.orbis-tm');
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      release = enterBackupMutation() ?? undefined;
      if (!release) throw fail();
      disk = acquireBackupDisk();
      combined.throwIfAborted();
      const space = await fs.statfs(this.directory(id), { bigint: true });
      if (space.bavail * space.bsize < BigInt(total + capsuleLimits.reserveBytes)) throw fail();
      file = await fs.open(destination, 'wx', 0o600);
      job.status = 'running';
      await this.save(job);
      job.totalBytes = total;
      const digest = createHash('sha256');
      for await (const raw of input) {
        combined.throwIfAborted();
        const data = Buffer.from(raw);
        if (job.completedBytes + data.length > total) throw fail();
        let offset = 0;
        while (offset < data.length) {
          const written = await file.write(data, offset, data.length - offset);
          if (!written.bytesWritten) throw fail();
          offset += written.bytesWritten;
        }
        digest.update(data);
        job.completedBytes += data.length;
      }
      if (job.completedBytes !== total) throw fail();
      await file.sync();
      job.bytes = total;
      job.sha256 = digest.digest('hex');
      job.status = 'uploaded';
      await this.save(job);
      return this.public(job);
    } catch (error) {
      job.status = combined.aborted ? 'cancelled' : 'failed';
      await fs.rm(destination, { force: true });
      await this.save(job).catch(() => undefined);
      throw error;
    } finally {
      await file?.close();
      combined.removeEventListener('abort', cancelled);
      disk?.();
      release?.();
      if (this.active === active) this.active = undefined;
      finish();
    }
  }
  async review(id: string, ownerId: number, request: Request, credentials: Credentials, passphrase: string) {
    const job = await this.owned(id, ownerId);
    await this.verifyAccount(request, ownerId, credentials);
    if (
      job.kind !== 'import' ||
      !['uploaded', 'failed'].includes(job.status) ||
      !job.bytes ||
      this.active ||
      this.reserved ||
      typeof passphrase !== 'string' ||
      passphrase.trim().length < 12 ||
      passphrase.length > 1024
    )
      throw fail();
    this.reserved = job.id;
    job.status = 'verifying';
    job.completedBytes = 0;
    job.totalBytes = null;
    try {
      await this.save(job);
    } catch (error) {
      this.reserved = null;
      throw error;
    }
    return {
      job: this.public(job),
      start: () =>
        this.run(job, async (signal) => {
          const verified = await importCapsule({
            source: path.join(this.directory(id), 'capsule.orbis-tm'),
            stagingParent: this.directory(id),
            passphrase,
            expectedSha256: job.sha256 ?? undefined,
            signal,
            verify: (manifest, directory, signal) =>
              verifyCapsuleContents({
                manifest,
                directory,
                signal,
                database: this.database,
                target: {
                  orbisVersion: process.env.ORBIS_VERSION ?? 'development',
                  runtipiVersion: this.config.get('version'),
                  architecture: this.config.get('architecture'),
                },
              }),
          });
          await verified.dispose();
          job.capsuleId = verified.capsuleId;
          job.status = 'verified';
        }),
    };
  }
  async download(id: string, ownerId: number, request: Request, credentials: Credentials) {
    const job = await this.owned(id, ownerId);
    await this.verifyAccount(request, ownerId, credentials);
    if (job.kind !== 'export' || job.status !== 'ready' || !job.sha256) throw fail();
    const file = await fs.open(path.join(this.directory(id), 'capsule.orbis-tm'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let transferred = false;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== job.bytes || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw fail();
      const hash = createHash('sha256');
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
      const after = await file.stat();
      if (
        hash.digest('hex') !== job.sha256 ||
        ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].some((key) => Reflect.get(stat, key) !== Reflect.get(after, key))
      )
        throw fail();
      const stream = file.createReadStream({ start: 0, autoClose: true });
      transferred = true;
      return { stream, bytes: job.bytes };
    } finally {
      if (!transferred) await file.close();
    }
  }
  async remove(id: string, ownerId: number, request: Request, credentials: Credentials) {
    await this.owned(id, ownerId);
    await this.verifyAccount(request, ownerId, credentials);
    if (this.reserved === id) this.reserved = null;
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
    await fs.rm(this.directory(id), { recursive: true });
    this.jobs.delete(id);
    return { removed: true };
  }
  async onModuleDestroy() {
    this.closing = true;
    this.active?.abort.abort();
    await this.active?.done;
  }
}
