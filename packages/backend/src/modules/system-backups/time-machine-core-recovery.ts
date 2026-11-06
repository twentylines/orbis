import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  acquireBackupMaintenance,
  coreCaptureRecoveryRequired,
  holdCoreCaptureRecovery,
  initializeCoreCaptureRecovery,
  settleCoreCaptureRecovery,
} from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import {
  type CoreCaptureCompletionDetails,
  type VerifiedCoreCompletion,
  HostCoreCaptureCompletionClient,
} from '../host-updates/host-core-capture-completion-client';
import type { CoreCaptureBinding } from '../host-updates/host-core-capture-contract';
import { HostCoreCaptureReader } from '../host-updates/host-core-capture-reader';
import { HostCoreCapturePublicationClient } from '../host-updates/host-core-capture-publication-client';
import type { QueueFactory } from '../queue/queue.factory';
import { privateBackupDirectory } from './backup-files';
import type { RetainedImageDocker } from './backup-image-retention';
import { saveCoreCapture } from './time-machine-core-save';
import { readCoreCaptureSourceHold, writeCoreCaptureContinuation } from './time-machine-core-source-hold';
import { CoreCaptureStartup } from './time-machine-core-startup';
import { TimeMachineStore } from './time-machine-store';
import { readCoreCapturePublisher, readCoreCaptureTransfer, rememberCoreCaptureTransfer } from './time-machine-core-publisher';

type StartupOptions = ConstructorParameters<typeof CoreCaptureStartup>[0];
type Queue = Pick<QueueFactory, 'resumeCoreCaptureConsumers' | 'verifyCoreCaptureConsumers'>;
type Options = {
  dataDirectory: string;
  socket: string;
  docker: RetainedImageDocker;
  queue: Queue;
  startup: Pick<StartupOptions, 'initializeRecovery' | 'initializeServices' | 'preparePresentation' | 'activateTimers'>;
  signal: AbortSignal;
  onProgress?: (stage: 'saving' | 'starting', completed: number, total: number | null) => void;
  onCleanupFailure?: () => void;
};

const fail = () => new Error('The saved capture needs recovery before Orbis can continue.');
const digest = (value: unknown) => createHash('sha256').update(canonicalPublicationJson(value)).digest('hex');

/** One startup attempt. Failure leaves the durable hold and all recovery evidence intact. */
export class CoreCaptureRecovery {
  private continuation?: Promise<void>;

  constructor(private readonly options: Options) {}

  continue(): Promise<void> {
    this.continuation ??= Promise.resolve().then(() => this.continueOnce());
    return this.continuation;
  }

  private async continueOnce() {
    const options = this.options;
    if (!coreCaptureRecoveryRequired() || installationMode().phase !== 'normal') throw fail();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(6 * 60 * 60_000)]);
    signal.throwIfAborted();
    const preStartupRead = async <T>(read: () => Promise<T>): Promise<T> => {
      const delays = [1000, 2000, 4000, 8000];
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          return await read();
        } catch (error) {
          const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
          const delay = delays[attempt];
          if (typeof code !== 'string' || !['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) || delay === undefined)
            throw error;
          await setTimeout(delay, undefined, { signal });
        }
      }
    };
    const release = await acquireBackupMaintenance(signal);
    let completed = false;
    let staging: { directory: string; device: number; inode: number } | undefined;
    try {
      const hold = await readCoreCaptureSourceHold(options.dataDirectory);
      if (hold.schema !== 'orbis.core-capture-source-hold.v2' || !hold.pointReservationSha256) throw fail();
      const binding: CoreCaptureBinding = { id: hold.id, sourceSha256: hold.sourceSha256, sourceHoldSha256: digest(hold) };
      const store = new TimeMachineStore(options.dataDirectory);
      let point = await store.load(hold.id);
      if (
        point.version !== 3 ||
        !['capturing', 'sealed'].includes(point.status) ||
        digest({ version: point.version, id: point.id, ownerId: point.ownerId, createdAt: point.createdAt, envelope: point.envelope }) !==
          hold.pointReservationSha256
      )
        throw fail();
      const draft = await store.readCoreDraft(point, signal);
      const publisher = await readCoreCapturePublisher(options.dataDirectory, hold);
      const publications = new HostCoreCapturePublicationClient(options.socket);
      const publicationSupported = publisher || point.status === 'capturing' ? await preStartupRead(() => publications.negotiate(signal)) : false;
      if (publisher && !publicationSupported) throw fail();
      const reader = new HostCoreCaptureReader(options.socket);
      const root = new HostCoreCaptureCompletionClient(options.socket);
      if (point.status === 'capturing') {
        let status = await preStartupRead(() => reader.status(binding, signal));
        while (status.state === 'running' || status.state === 'reserved' || status.state === 'launch-unsettled') {
          await setTimeout(1000, undefined, { signal });
          status = await preStartupRead(() => reader.status(binding, signal));
        }
        if (status.state !== 'resumed-awaiting-publication') throw fail();
        const parent = path.join(options.dataDirectory, 'backups', 'time-machine', 'core-capture', point.id);
        await privateBackupDirectory(parent);
        const publication = publicationSupported ? await preStartupRead(() => publications.status(binding, signal)) : undefined;
        if (publisher === 'sentinel.v1') {
          let ready = publication;
          if (!ready || ready.publisher !== 'sentinel.v1') throw fail();
          while (ready.state === 'awaiting-publication') {
            options.onProgress?.('saving', 0, null);
            await setTimeout(2000, undefined, { signal });
            ready = await preStartupRead(() => publications.status(binding, signal));
            if (ready.publisher !== 'sentinel.v1') throw fail();
          }
          if (
            ready.state !== 'verified' ||
            ready.pointReservationSha256 !== hold.pointReservationSha256 ||
            ready.preparationSha256 !== hold.preparationSha256
          )
            throw fail();
          staging = await readCoreCaptureTransfer(options.dataDirectory, hold, hold, ready);
          if (!staging) {
            const total = Object.values(ready.publication.files).reduce((sum, file) => sum + file.bytes, 0);
            const space = await fs.statfs(parent);
            if (space.bavail * space.bsize < total + 256 * 1024 * 1024) throw fail();
            const directory = path.join(parent, `sentinel-transfer-${randomUUID()}`);
            await fs.mkdir(directory, { mode: 0o700 });
            const identity = await fs.lstat(directory);
            staging = { directory, device: identity.dev, inode: identity.ino };
            const token = await preStartupRead(() => publications.prepare(binding, signal));
            const downloaded = await publications.download(token, directory, signal, (done, total) => options.onProgress?.('saving', done, total));
            if (
              downloaded.pointReservationSha256 !== hold.pointReservationSha256 ||
              canonicalPublicationJson(downloaded.publication) !== canonicalPublicationJson(ready.publication) ||
              canonicalPublicationJson(downloaded.expectation) !== canonicalPublicationJson(ready.expectation)
            )
              throw fail();
            await rememberCoreCaptureTransfer(options.dataDirectory, hold, hold, ready, directory, signal);
          }
          await store.adoptPublishedCorePoint(point, staging.directory, ready.publication, signal);
        } else {
          if (publication && publication.publisher !== 'controller-restart.v1') throw fail();
          const directory = await fs.mkdtemp(path.join(parent, 'transfer-'));
          const identity = await fs.lstat(directory);
          staging = { directory, device: identity.dev, inode: identity.ino };
          const checkpointDirectory = path.join(directory, 'checkpoint');
          const imageDirectory = path.join(directory, 'images');
          await fs.mkdir(checkpointDirectory, { mode: 0o700 });
          await fs.mkdir(imageDirectory, { mode: 0o700 });
          options.onProgress?.('saving', 0, status.ready.artifact.checkpoint.bytes);
          const download = await preStartupRead(() => reader.prepare(binding, signal));
          await saveCoreCapture({
            reader,
            download,
            checkpointDirectory,
            imageDirectory,
            docker: options.docker,
            store,
            point,
            metadata: draft,
            signal,
            onCheckpointProgress: (done, total) => options.onProgress?.('saving', done, total),
          });
        }
        point = await store.load(point.id);
        if (point.version !== 3 || point.status !== 'sealed') throw fail();
      }
      signal.throwIfAborted();
      const unchanged = await readCoreCaptureSourceHold(options.dataDirectory);
      if (digest(unchanged) !== binding.sourceHoldSha256) throw fail();
      const preparation = await preStartupRead(() => root.prepare(binding, signal));
      let approval: CoreCaptureCompletionDetails | undefined;
      let queues: Awaited<ReturnType<Queue['verifyCoreCaptureConsumers']>> | undefined;
      const startup = new CoreCaptureStartup({
        ...options.startup,
        startConsumers: async () => options.queue.resumeCoreCaptureConsumers(),
        verifyConsumers: async () => {
          queues = await options.queue.verifyCoreCaptureConsumers(signal);
          return queues;
        },
      });
      await initializeCoreCaptureRecovery(preparation, async (details) => {
        if (details.pointReservationSha256 !== hold.pointReservationSha256) throw fail();
        approval = details;
        options.onProgress?.('starting', 0, null);
        await startup.prepare();
        await startup.activate();
      });
      if (!approval || !queues) throw fail();
      const ready = approval as CoreCaptureCompletionDetails;
      const consumerProof = queues as Awaited<ReturnType<Queue['verifyCoreCaptureConsumers']>>;
      let settled: VerifiedCoreCompletion;
      let continuationSha256: string | undefined;
      if (ready.state === 'complete') {
        continuationSha256 = ready.continuationSha256;
        settled = await root.prepare(binding, signal);
      } else {
        const continuation = await writeCoreCaptureContinuation(options.dataDirectory, ready, consumerProof, signal);
        continuationSha256 = continuation.continuationSha256;
        try {
          settled = await root.finish(binding, ready.completionSha256, continuation.continuationSha256, signal);
        } catch {
          // Only observe a possibly committed request; never restart capture or repeat an external mutation.
          signal.throwIfAborted();
          settled = await root.prepare(binding, signal);
        }
      }
      await consumerProof.recheck();
      if (!continuationSha256) throw fail();
      await settleCoreCaptureRecovery(settled, continuationSha256, signal);
      completed = true;
    } catch (error) {
      holdCoreCaptureRecovery();
      throw error;
    } finally {
      release();
      if (completed && staging) {
        const owned = staging;
        await fs
          .lstat(owned.directory)
          .then(async (current) => {
            if (
              !current.isDirectory() ||
              current.isSymbolicLink() ||
              current.dev !== owned.device ||
              current.ino !== owned.inode ||
              current.uid !== process.getuid?.() ||
              (current.mode & 0o7777) !== 0o700
            )
              throw fail();
            await fs.rm(owned.directory, { recursive: true });
          })
          .catch(() => options.onCleanupFailure?.());
      }
    }
  }
}
