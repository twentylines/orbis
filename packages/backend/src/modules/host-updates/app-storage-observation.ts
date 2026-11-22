import { createHash, randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { type } from 'arktype';
import { controllerCaptureSocketIdentity } from './host-controller-config';

const schemaName = 'orbis.app-storage-observation.v1';
const invalid = () => new Error('The app storage binding could not be verified.');
const urnPattern = /^([a-z0-9][a-z0-9_.-]{0,127}):([a-z0-9][a-z0-9_.-]{0,127})$/;
const canonicalPath = (value: string) =>
  value.startsWith('/') && value !== '/' && path.posix.normalize(value) === value && Buffer.byteLength(value) <= 4096 && !/[\0\r\n\\]/.test(value);
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const decimal = type('string').narrow((value) => /^(?:0|[1-9][0-9]{0,19})$/.test(value));
const absolute = type('string').narrow(canonicalPath);
const objectId = type({ device: decimal, inode: decimal }).onUndeclaredKey('reject');
const schema = type({
  schema: "'orbis.app-storage-observation.v1'",
  appUrn: type('string').narrow((value) => urnPattern.test(value)),
  nonce: hash,
  controller: type({
    id: hash,
    imageId: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
    startedAt: 'string > 0 & string <= 128',
    definitionSha256: hash,
  }).onUndeclaredKey('reject'),
  daemonSha256: hash,
  dockerSocket: objectId,
  hostBasePath: absolute,
  hostPath: absolute,
  containerPath: absolute,
  directory: objectId
    .merge({ uid: '0 <= number.integer <= 4294967295', gid: '0 <= number.integer <= 4294967295', mode: '0 <= number.integer <= 4095' })
    .onUndeclaredKey('reject'),
  mountTablesSha256: hash,
  controllerNamespace: type('string').narrow((value) => /^(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/.test(value)),
  bindingSha256: hash,
}).onUndeclaredKey('reject');
export type AppStorageObservation = typeof schema.infer;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) immutable(item);
  }
  return value;
}

/** Decoding metadata alone never constructs a live storage witness. */
export function decodeAppStorageObservation(raw: unknown, expected: { appUrn: string; nonce: string }): Readonly<AppStorageObservation> {
  const value = schema(raw);
  if (value instanceof type.errors || value.appUrn !== expected.appUrn || value.nonce !== expected.nonce) throw invalid();
  const match = urnPattern.exec(expected.appUrn);
  if (!match || value.hostPath !== `${value.hostBasePath}/${match[2]}/${match[1]}` || value.containerPath !== `/app-data/${match[2]}/${match[1]}`)
    throw invalid();
  const { bindingSha256, ...metadata } = value;
  if (
    bindingSha256 !==
    createHash('sha256')
      .update(schemaName + '\n' + canonical(metadata))
      .digest('hex')
  )
    throw invalid();
  return immutable(structuredClone(value));
}

const directoryIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
class DirectoryPin {
  readonly handles: { name: string; handle: FileHandle; identity: string }[] = [];
  static async open(directory: string) {
    const pin = new DirectoryPin();
    try {
      if (!canonicalPath(directory) || directory.split('/').length > 128) throw invalid();
      let name = '/';
      for (const part of ['/', ...directory.split('/').filter(Boolean)]) {
        if (part !== '/') name = path.posix.join(name, part);
        const parent = pin.handles.at(-1);
        const selected = process.platform === 'linux' && parent ? `/proc/self/fd/${parent.handle.fd}/${part}` : name;
        const handle = await fs.open(selected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat({ bigint: true });
          if (!stat.isDirectory()) throw invalid();
          pin.handles.push({ name, handle, identity: directoryIdentity(stat) });
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      await pin.verify();
      return pin;
    } catch {
      await pin.close();
      throw invalid();
    }
  }
  async verify() {
    if (!this.handles.length) throw invalid();
    for (const item of this.handles) {
      const named = await fs.lstat(item.name, { bigint: true });
      if (
        !named.isDirectory() ||
        directoryIdentity(named) !== item.identity ||
        directoryIdentity(await item.handle.stat({ bigint: true })) !== item.identity
      )
        throw invalid();
    }
  }
  async metadata() {
    await this.verify();
    const last = this.handles.at(-1);
    if (!last) throw invalid();
    const stat = await last.handle.stat({ bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode & 0o7777n) };
  }
  async close() {
    const closed = await Promise.allSettled(this.handles.splice(0).map(({ handle }) => handle.close()));
    if (closed.some((item) => item.status === 'rejected')) throw invalid();
  }
}

async function observe(socketPath: string, appUrn: string, signal?: AbortSignal) {
  const socketIdentity = await controllerCaptureSocketIdentity(socketPath);
  const nonce = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ appUrn, nonce });
  const cancellation = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  const result = await new Promise<unknown>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: '/v1/app-storage/observe',
        method: 'POST',
        signal: cancellation,
        agent: false,
        headers: { Host: 'orbis', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
      },
      (response) => {
        const parts: Buffer[] = [];
        let bytes = 0;
        const length = response.headers['content-length'];
        if (
          response.statusCode !== 200 ||
          response.headers['content-type'] !== 'application/json' ||
          typeof length !== 'string' ||
          !/^[1-9][0-9]{0,4}$/.test(length) ||
          Number(length) > 16384
        ) {
          response.destroy();
          request.destroy();
          reject(invalid());
          return;
        }
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > Number(length) || bytes > 16384) {
            response.destroy();
            request.destroy();
            reject(invalid());
          } else parts.push(chunk);
        });
        response.once('error', () => reject(invalid()));
        response.once('aborted', () => reject(invalid()));
        response.once('end', () => {
          try {
            if (bytes !== Number(length)) throw invalid();
            resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))));
          } catch {
            reject(invalid());
          }
        });
      },
    );
    request.once('error', () => reject(invalid()));
    request.end(payload);
  });
  if (socketIdentity !== (await controllerCaptureSocketIdentity(socketPath))) throw invalid();
  return { value: decodeAppStorageObservation(result, { appUrn, nonce }), socketIdentity };
}

async function engineSocket(docker: Pick<Dockerode, 'modem'>) {
  const modem = docker.modem as unknown as { host?: unknown; agent?: unknown; getSocketPath?: () => Promise<string> };
  if (modem.host || modem.agent || typeof modem.getSocketPath !== 'function') throw invalid();
  const selected = await modem.getSocketPath();
  if (!canonicalPath(selected)) throw invalid();
  const parent = path.dirname(selected);
  const actualParent = await fs.realpath(parent);
  if (actualParent !== parent && !(parent === '/var/run' && actualParent === '/run')) throw invalid();
  const info = await fs.lstat(selected, { bigint: true });
  if (!info.isSocket() || info.uid !== 0n || info.nlink !== 1n || info.mode & 0o007n) throw invalid();
  return {
    path: selected,
    device: String(info.dev),
    inode: String(info.ino),
    identity: [info.dev, info.ino, info.uid, info.gid, info.mode, info.ctimeNs].join(':'),
  };
}
const stable = ({ nonce: _nonce, bindingSha256: _binding, ...value }: Readonly<AppStorageObservation>) => canonical(value);

/** Live private transport + physical directory witness. This is not Sentinel recovery authority. */
export class AppStorageWitness {
  #closed = false;
  #busy = false;
  private constructor(
    private readonly options: { socketPath: string; appUrn: string; localDirectory: string; docker: Dockerode; signal?: AbortSignal },
    private readonly pin: DirectoryPin,
    private readonly initial: Awaited<ReturnType<typeof observe>>,
    private readonly engine: Awaited<ReturnType<typeof engineSocket>>,
  ) {}

  static async open(options: { socketPath: string; appUrn: string; localDirectory: string; docker: Dockerode; signal?: AbortSignal }) {
    let pin: DirectoryPin | undefined;
    try {
      if (!urnPattern.test(options.appUrn)) throw invalid();
      pin = await DirectoryPin.open(options.localDirectory);
      const engine = await engineSocket(options.docker);
      const initial = await observe(options.socketPath, options.appUrn, options.signal);
      const witness = new AppStorageWitness(Object.freeze({ ...options }), pin, initial, engine);
      await witness.#verify();
      Object.freeze(witness);
      return witness;
    } catch {
      await pin?.close();
      throw invalid();
    }
  }

  async #verify() {
    if (this.#closed) throw invalid();
    this.options.signal?.throwIfAborted();
    await this.pin.verify();
    const engine = await engineSocket(this.options.docker);
    if (canonical(engine) !== canonical(this.engine)) throw invalid();
    const current = await observe(this.options.socketPath, this.options.appUrn, this.options.signal);
    if (
      current.socketIdentity !== this.initial.socketIdentity ||
      stable(current.value) !== stable(this.initial.value) ||
      canonical(current.value.dockerSocket) !== canonical({ device: engine.device, inode: engine.inode }) ||
      canonical(current.value.directory) !== canonical(await this.pin.metadata())
    )
      throw invalid();
    await this.pin.verify();
  }

  async use<T>(effect: (docker: Dockerode, observation: Readonly<AppStorageObservation>) => Promise<T>): Promise<T> {
    if (this.#busy || this.#closed) throw invalid();
    this.#busy = true;
    try {
      await this.#verify();
      const result = await effect(this.options.docker, this.initial.value);
      await this.#verify();
      return result;
    } catch {
      throw invalid();
    } finally {
      this.#busy = false;
    }
  }

  async close() {
    if (this.#busy) throw invalid();
    if (this.#closed) return;
    this.#closed = true;
    await this.pin.close();
  }
}
