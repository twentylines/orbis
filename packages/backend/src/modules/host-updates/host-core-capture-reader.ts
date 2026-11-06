import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import type { CorePayloadExpectation } from '../system-backups/time-machine-core-payload';
import { canonicalPublicationJson } from './host-controller-publication';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import {
  coreCaptureLimits,
  decodeCoreCaptureStatus,
  validateCoreCaptureBinding,
  type CoreCaptureBinding,
  type CoreCaptureStatus,
} from './host-core-capture-contract';

type Ready = Extract<CoreCaptureStatus, { state: 'resumed-awaiting-publication' }>;
declare const checkpointDownload: unique symbol;
export type CoreCheckpointDownload = { readonly [checkpointDownload]: true };
type Stat = Awaited<ReturnType<FileHandle['stat']>>;
const fail = () => new Error('The captured checkpoint could not be transferred.');
const inode = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino;
const directorySeal = (a: Stat, b: Stat) => inode(a, b) && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;

async function staging(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 || ![0, process.getuid?.()].includes(stat.uid)) throw fail();
  }
  const before = await fs.lstat(directory);
  if (before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o700) throw fail();
  return before;
}

function headers(reply: IncomingMessage, type: string, limit: number, exactBytes?: number) {
  const length = reply.headers['content-length'];
  if (
    reply.statusCode !== 200 ||
    reply.headers['content-type'] !== type ||
    reply.headers['cache-control'] !== 'no-store' ||
    reply.headers['transfer-encoding'] !== undefined ||
    reply.headers['content-encoding'] !== undefined ||
    typeof length !== 'string' ||
    !/^[1-9][0-9]*$/.test(length) ||
    !Number.isSafeInteger(Number(length)) ||
    Number(length) > limit ||
    (exactBytes !== undefined && Number(length) !== exactBytes)
  )
    throw fail();
  return Number(length);
}

/** Internal root-socket reader. A decoded web response cannot mint a download capability. */
export class HostCoreCaptureReader {
  private readonly downloads = new WeakMap<CoreCheckpointDownload, { socketIdentity: string; status: Ready }>();

  constructor(private readonly socket: string) {}

  private async identity() {
    return controllerCaptureSocketIdentity(this.socket);
  }

  private async verifiedIdentity() {
    try {
      return await this.identity();
    } catch {
      throw fail();
    }
  }

  private response(id: string, operation: 'status' | 'checkpoint', body: object, signal: AbortSignal) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const request = http.request(
        {
          socketPath: this.socket,
          method: 'POST',
          path: `/v1/core-captures/${id}/${operation}`,
          signal,
          agent: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
        },
        resolve,
      );
      request.setTimeout(30_000, () => request.destroy(fail()));
      request.on('error', reject);
      request.end(payload);
    });
  }

  async status(input: CoreCaptureBinding, cancellation: AbortSignal): Promise<CoreCaptureStatus> {
    const binding = validateCoreCaptureBinding(input);
    cancellation.throwIfAborted();
    const identity = await this.identity();
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(30_000)]);
    const reply = await this.response(
      binding.id,
      'status',
      { sourceSha256: binding.sourceSha256, sourceHoldSha256: binding.sourceHoldSha256 },
      signal,
    );
    try {
      const expected = headers(reply, 'application/json', coreCaptureLimits.metadataBytes);
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const raw of reply) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > expected) throw fail();
        parts.push(chunk);
      }
      if (!reply.complete || bytes !== expected || (await this.verifiedIdentity()) !== identity) throw fail();
      signal.throwIfAborted();
      return decodeCoreCaptureStatus(JSON.parse(Buffer.concat(parts).toString('utf8')), binding);
    } finally {
      reply.destroy();
    }
  }

  async prepare(binding: CoreCaptureBinding, signal: AbortSignal): Promise<CoreCheckpointDownload> {
    const identity = await this.identity();
    const status = await this.status(binding, signal);
    if (status.state !== 'resumed-awaiting-publication' || (await this.verifiedIdentity()) !== identity) throw fail();
    const token = Object.freeze({}) as CoreCheckpointDownload;
    this.downloads.set(token, { socketIdentity: identity, status });
    return token;
  }

  async download(
    token: CoreCheckpointDownload,
    directory: string,
    cancellation: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<{ checkpointFile: string; expectation: CorePayloadExpectation }> {
    const prepared = this.downloads.get(token);
    if (!prepared) throw fail();
    this.downloads.delete(token);
    const { status, socketIdentity } = prepared;
    const expected = status.ready.artifact.checkpoint;
    const before = await staging(directory);
    if ((await this.identity()) !== socketIdentity) throw fail();
    const final = path.join(directory, 'checkpoint.tar');
    const temporary = path.join(directory, `.checkpoint-${randomUUID()}.partial`);
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(30 * 60_000)]);
    let output: FileHandle | undefined;
    let owned: Stat | undefined;
    let reply: IncomingMessage | undefined;
    try {
      signal.throwIfAborted();
      output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = await output.stat();
      reply = await this.response(
        status.id,
        'checkpoint',
        {
          sourceSha256: status.sourceSha256,
          sourceHoldSha256: status.sourceHoldSha256,
          captureReceiptSha256: status.ready.captureReceiptSha256,
          checkpointArtifactSha256: status.ready.checkpointArtifactSha256,
        },
        signal,
      );
      headers(reply, 'application/octet-stream', coreCaptureLimits.checkpointBytes, expected.bytes);
      const digest = createHash('sha256');
      let received = 0;
      onProgress?.(0, expected.bytes);
      for await (const raw of reply) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        if (received + chunk.length > expected.bytes) throw fail();
        digest.update(chunk);
        for (let offset = 0; offset < chunk.length; ) {
          const end = Math.min(offset + coreCaptureLimits.chunkBytes, chunk.length);
          const result = await output.write(chunk, offset, end - offset);
          if (!result.bytesWritten) throw fail();
          offset += result.bytesWritten;
        }
        received += chunk.length;
        onProgress?.(received, expected.bytes);
      }
      if (!reply.complete || received !== expected.bytes || digest.digest('hex') !== expected.sha256) throw fail();
      await output.sync();
      const written = await output.stat();
      if (
        !inode(owned, written) ||
        !written.isFile() ||
        written.nlink !== 1 ||
        written.size !== expected.bytes ||
        written.uid !== process.getuid?.() ||
        (written.mode & 0o7777) !== 0o600 ||
        !inode(written, await fs.lstat(temporary)) ||
        !directorySeal(before, await staging(directory))
      )
        throw fail();
      const current = await this.status({ id: status.id, sourceSha256: status.sourceSha256, sourceHoldSha256: status.sourceHoldSha256 }, signal);
      if (canonicalPublicationJson(current) !== canonicalPublicationJson(status) || (await this.identity()) !== socketIdentity) throw fail();
      signal.throwIfAborted();
      await output.close();
      output = undefined;
      await fs.link(temporary, final);
      const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      if (!directorySeal(before, await staging(directory)) || !inode(written, await fs.lstat(final))) throw fail();
      const artifact = status.ready.artifact;
      return {
        checkpointFile: final,
        expectation: {
          pointId: status.id,
          sourceSha256: status.sourceSha256,
          checkpointSha256: artifact.checkpointSha256,
          captureReceiptSha256: status.ready.captureReceiptSha256,
          resourceCount: artifact.resourceCount,
          images: structuredClone(artifact.roleImageIds),
          compatibility: structuredClone(artifact.compatibility),
          checkpoint: { ...expected },
        },
      };
    } finally {
      reply?.destroy();
      await output?.close();
      if (owned) {
        const current = await fs.lstat(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (current && inode(owned, current)) await fs.unlink(temporary);
      }
    }
  }
}
