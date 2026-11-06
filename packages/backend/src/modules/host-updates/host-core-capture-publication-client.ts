import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import type { CoreCatalogPublication } from '../system-backups/time-machine-core-catalog-worker';
import { validateCorePayloadExpectation, type CorePayloadExpectation } from '../system-backups/time-machine-core-payload';
import { controllerCaptureSocketIdentity } from './host-controller-config';
import { canonicalPublicationJson } from './host-controller-publication';
import { validateCoreCaptureBinding, type CoreCaptureBinding } from './host-core-capture-contract';
import { coreCaptureHostRequest } from './host-core-capture-start-client';

const capability = {
  schema: 'orbis.core-capture-sentinel-reader.v1',
  version: 1,
  operations: ['sentinel-publication', 'sentinel-file'],
  pointVersion: 3,
  lifecycleAuthority: false,
};
const limits: Record<string, number> = {
  'point.json': 32768,
  'metadata.orbis': 524340,
  'capture-draft.orbis': 524340,
  'core.orbis': 68719476736,
  'wallpaper.orbis': 33554484,
  'icons.orbis': 25165876,
};
const required = ['point.json', 'metadata.orbis', 'capture-draft.orbis', 'core.orbis'];
const hashes = [
  'pointSha256',
  'pointReservationSha256',
  'metadataSha256',
  'cipherSha256',
  'manifestSha256',
  'imageInventorySha256',
  'captureReceiptSha256',
  'sourceSha256',
  'checkpointSha256',
];
const fail = () => new Error('The published capture could not be transferred.');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const equal = (a: unknown, b: unknown) => canonicalPublicationJson(a) === canonicalPublicationJson(b);
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const safeInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
type Base = CoreCaptureBinding & { version: 1 };
type Verified = Base & {
  publisher: 'sentinel.v1';
  state: 'verified';
  receiptSha256: string;
  publicationSha256: string;
  preparationSha256: string;
  terminalSha256: string;
  pointReservationSha256: string;
  publication: CoreCatalogPublication;
  expectation: CorePayloadExpectation;
};
export type HostCoreCapturePublicationStatus =
  | (Base & { publisher: 'controller-restart.v1'; state: 'controller-publication' })
  | (Base & { publisher: 'sentinel.v1'; state: 'awaiting-publication' | 'recovery-required' })
  | Verified;
declare const tokenBrand: unique symbol;
export type PreparedCoreCapturePublication = { readonly [tokenBrand]: true };
function decode(raw: unknown, binding: CoreCaptureBinding): HostCoreCapturePublicationStatus {
  const base = ['version', 'id', 'publisher', 'sourceSha256', 'sourceHoldSha256', 'state'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  const v = raw as Record<string, unknown>;
  if (v.version !== 1 || v.id !== binding.id || v.sourceSha256 !== binding.sourceSha256 || v.sourceHoldSha256 !== binding.sourceHoldSha256)
    throw fail();
  if (
    (v.publisher === 'controller-restart.v1' && v.state === 'controller-publication') ||
    (v.publisher === 'sentinel.v1' && (v.state === 'awaiting-publication' || v.state === 'recovery-required'))
  ) {
    if (!exact(v, base)) throw fail();
    return v as HostCoreCapturePublicationStatus;
  }
  if (
    v.publisher !== 'sentinel.v1' ||
    v.state !== 'verified' ||
    !exact(v, [
      ...base,
      'receiptSha256',
      'publicationSha256',
      'preparationSha256',
      'terminalSha256',
      'pointReservationSha256',
      'publication',
      'expectation',
    ]) ||
    ['receiptSha256', 'publicationSha256', 'preparationSha256', 'terminalSha256', 'pointReservationSha256'].some((k) => !hash(v[k]))
  )
    throw fail();
  const expectation = validateCorePayloadExpectation(v.expectation);
  if (expectation.pointId !== binding.id || expectation.sourceSha256 !== binding.sourceSha256) throw fail();
  const p = v.publication;
  if (
    !exact(p, ['schema', 'core', 'keyId', 'files']) ||
    p.schema !== 'orbis.core-capture-catalog-publication.v1' ||
    !hash(p.keyId) ||
    !exact(p.core, [...hashes, 'schema', 'pointId', 'ownerId', 'createdAt', 'cipherBytes', 'checkpoint', 'resourceCount', 'imageCount'])
  )
    throw fail();
  const c = p.core;
  if (
    c.schema !== 'orbis.core-capture-publication.v1' ||
    hashes.some((k) => !hash(c[k])) ||
    c.pointId !== binding.id ||
    c.pointReservationSha256 !== v.pointReservationSha256 ||
    c.sourceSha256 !== expectation.sourceSha256 ||
    c.checkpointSha256 !== expectation.checkpointSha256 ||
    c.captureReceiptSha256 !== expectation.captureReceiptSha256 ||
    !equal(c.checkpoint, expectation.checkpoint) ||
    c.resourceCount !== expectation.resourceCount ||
    c.imageCount !== new Set(Object.values(expectation.images)).size ||
    !safeInt(c.ownerId) ||
    (c.ownerId as number) < 1 ||
    !safeInt(c.createdAt) ||
    (c.createdAt as number) < 1 ||
    !safeInt(c.cipherBytes) ||
    (c.cipherBytes as number) <= expectation.checkpoint.bytes + 52 ||
    (c.cipherBytes as number) > 68719476736
  )
    throw fail();
  if (!p.files || typeof p.files !== 'object' || Array.isArray(p.files)) throw fail();
  const files = p.files as Record<string, unknown>;
  if (required.some((name) => !Object.hasOwn(files, name)) || Object.keys(files).some((name) => !Object.hasOwn(limits, name))) throw fail();
  for (const [name, item] of Object.entries(files))
    if (
      !exact(item, ['bytes', 'sha256']) ||
      !safeInt(item.bytes) ||
      (item.bytes as number) < 1 ||
      (item.bytes as number) > (limits[name] ?? 0) ||
      !hash(item.sha256)
    )
      throw fail();
  if (
    (files['point.json'] as { sha256: string }).sha256 !== c.pointSha256 ||
    (files['metadata.orbis'] as { sha256: string }).sha256 !== c.metadataSha256 ||
    !equal(files['core.orbis'], { bytes: c.cipherBytes, sha256: c.cipherSha256 }) ||
    sha(canonicalPublicationJson(p)) !== v.publicationSha256
  )
    throw fail();
  return structuredClone(v) as Verified;
}
type Stat = Awaited<ReturnType<FileHandle['stat']>>;
const same = (a: Stat, b: Stat) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a: Stat, b: Stat) => same(a, b) && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function staging(directory: string) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || (await fs.realpath(directory)) !== directory) throw fail();
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const s = await fs.lstat(cursor);
    if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o022 || ![0, process.getuid?.()].includes(s.uid)) throw fail();
  }
  const s = await fs.lstat(directory);
  if (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700) throw fail();
  return s;
}
function checkHeaders(reply: IncomingMessage, bytes: number) {
  const counts = new Map<string, number>();
  for (let i = 0; i < reply.rawHeaders.length; i += 2) {
    const n = (reply.rawHeaders[i] ?? '').toLowerCase();
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  if (
    reply.statusCode !== 200 ||
    reply.headers['content-type'] !== 'application/octet-stream' ||
    reply.headers['cache-control'] !== 'no-store' ||
    reply.headers['content-length'] !== String(bytes) ||
    ['content-type', 'content-length', 'cache-control'].some((n) => counts.get(n) !== 1) ||
    ['transfer-encoding', 'content-encoding', 'trailer'].some((n) => counts.has(n))
  )
    throw fail();
}
export class HostCoreCapturePublicationClient {
  private readonly tokens = new WeakMap<PreparedCoreCapturePublication, { identity: string; status: Verified }>();
  constructor(private readonly socket: string) {}
  async negotiate(signal: AbortSignal): Promise<boolean> {
    const reply = await coreCaptureHostRequest(this.socket, '/v1/core-captures/sentinel-publication-capability', undefined, signal, undefined, true);
    if (reply.statusCode === 404) {
      if (!exact(reply.value, ['error']) || typeof reply.value.error !== 'string' || !reply.value.error.length || reply.value.error.length > 4096)
        throw fail();
      return false;
    }
    if (!equal(reply.value, capability)) throw fail();
    return true;
  }
  private async read(input: CoreCaptureBinding, signal: AbortSignal, identity?: string) {
    const binding = validateCoreCaptureBinding(input);
    const reply = await coreCaptureHostRequest(
      this.socket,
      `/v1/core-captures/${binding.id}/sentinel-publication`,
      { sourceSha256: binding.sourceSha256, sourceHoldSha256: binding.sourceHoldSha256 },
      signal,
      identity,
    );
    return { identity: reply.identity, status: decode(reply.value, binding) };
  }
  async status(binding: CoreCaptureBinding, signal: AbortSignal): Promise<HostCoreCapturePublicationStatus> {
    return (await this.read(binding, signal)).status;
  }
  async prepare(binding: CoreCaptureBinding, signal: AbortSignal): Promise<PreparedCoreCapturePublication> {
    const { identity, status } = await this.read(binding, signal);
    if (status.state !== 'verified') throw fail();
    const token = Object.freeze({}) as PreparedCoreCapturePublication;
    this.tokens.set(token, { identity, status });
    return token;
  }
  async download(
    token: PreparedCoreCapturePublication,
    directory: string,
    cancellation: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<{ directory: string; publication: CoreCatalogPublication; expectation: CorePayloadExpectation; pointReservationSha256: string }> {
    const prepared = this.tokens.get(token);
    this.tokens.delete(token);
    if (!prepared) throw fail();
    const { identity, status } = prepared;
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(4 * 60 * 60_000)]);
    signal.throwIfAborted();
    const before = await staging(directory);
    if ((await fs.readdir(directory)).length || (await controllerCaptureSocketIdentity(this.socket)) !== identity) throw fail();
    const entries = Object.entries(status.publication.files).sort(([a], [b]) => a.localeCompare(b));
    const total = entries.reduce((n, [, item]) => n + item.bytes, 0);
    let completed = 0;
    onProgress?.(0, total);
    const written: { temporary: string; final: string; stat: Stat }[] = [];
    for (const [name, item] of entries) {
      signal.throwIfAborted();
      const temporary = path.join(directory, `.publication-${randomUUID()}.partial`);
      const output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let reply: IncomingMessage | undefined;
      try {
        const owned = await output.stat();
        const payload = JSON.stringify({
          sourceSha256: status.sourceSha256,
          sourceHoldSha256: status.sourceHoldSha256,
          receiptSha256: status.receiptSha256,
          publicationSha256: status.publicationSha256,
          fileName: name,
        });
        reply = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = http.request(
            {
              socketPath: this.socket,
              method: 'POST',
              path: `/v1/core-captures/${status.id}/sentinel-file`,
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
        checkHeaders(reply, item.bytes);
        const digest = createHash('sha256');
        let received = 0;
        for await (const raw of reply) {
          signal.throwIfAborted();
          const chunk = Buffer.from(raw);
          received += chunk.length;
          if (received > item.bytes) throw fail();
          digest.update(chunk);
          for (let offset = 0; offset < chunk.length; ) {
            const result = await output.write(chunk, offset, Math.min(65536, chunk.length - offset));
            if (!result.bytesWritten) throw fail();
            offset += result.bytesWritten;
          }
          completed += chunk.length;
          onProgress?.(completed, total);
        }
        if (
          !reply.complete ||
          Object.keys(reply.trailers).length ||
          received !== item.bytes ||
          digest.digest('hex') !== item.sha256 ||
          (await controllerCaptureSocketIdentity(this.socket)) !== identity
        )
          throw fail();
        await output.sync();
        const stat = await output.stat();
        if (
          !same(owned, stat) ||
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== item.bytes ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600 ||
          !sameFile(stat, await fs.lstat(temporary)) ||
          !same(before, await staging(directory))
        )
          throw fail();
        written.push({ temporary, final: path.join(directory, name), stat });
      } finally {
        reply?.destroy();
        await output.close();
      }
    }
    const current = await this.read(
      { id: status.id, sourceSha256: status.sourceSha256, sourceHoldSha256: status.sourceHoldSha256 },
      signal,
      identity,
    );
    if (
      !equal(current.status, status) ||
      (await controllerCaptureSocketIdentity(this.socket)) !== identity ||
      !same(before, await staging(directory))
    )
      throw fail();
    for (const file of written) {
      signal.throwIfAborted();
      if (!sameFile(file.stat, await fs.lstat(file.temporary))) throw fail();
      await fs.link(file.temporary, file.final);
    }
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    for (const file of written) {
      if (!same(file.stat, await fs.lstat(file.final))) throw fail();
      await fs.unlink(file.temporary);
    }
    const sync = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await sync.sync();
    } finally {
      await sync.close();
    }
    if (!same(before, await staging(directory)) || (await controllerCaptureSocketIdentity(this.socket)) !== identity) throw fail();
    return { directory, publication: status.publication, expectation: status.expectation, pointReservationSha256: status.pointReservationSha256 };
  }
}
