import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';
import { appMigrationIdPattern } from '../apps/app-migrations';
import type { AppMigrationDefinition } from './app-migration-plan';

const invalid = () => new Error('The app migration image could not be verified.');
const digest = /^sha256:[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export type AppMigrationImage = Readonly<{
  migrationId: string;
  sourceSha256: string;
  definitionSha256: string;
  reference: string;
  imageId: string;
  platform: string;
}>;

function reference(value: string) {
  if (typeof value !== 'string' || value.length > 1024 || /^(?:sha256:)?[a-f0-9]{64}$/.test(value)) throw invalid();
  const parts = value.split('@');
  if (parts.length > 2 || (parts.length === 2 && !digest.test(parts[1] ?? ''))) throw invalid();
  const tagged = parts[0] ?? '';
  const tagOffset = tagged.lastIndexOf(':');
  const hasTag = tagOffset > tagged.lastIndexOf('/');
  const repository = hasTag ? tagged.slice(0, tagOffset) : tagged;
  if (hasTag && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tagged.slice(tagOffset + 1))) throw invalid();
  const components = repository.split('/');
  let registry = 'docker.io';
  const first = components[0] ?? '';
  if (components.length > 1 && (first === 'localhost' || /[.:]/.test(first))) {
    registry = components.shift() ?? '';
    if (!/^(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?$/.test(registry)) throw invalid();
    const port = registry.split(':')[1];
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw invalid();
  }
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (!components.length || components.some((part) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(part))) throw invalid();
  if (registry === 'docker.io' && components.length === 1) components.unshift('library');
  const canonical = `${registry}/${components.join('/')}`;
  return {
    repository: canonical,
    pinned: parts[1],
    selected: parts[1] ? `${canonical}@${parts[1]}` : `${canonical}:${hasTag ? tagged.slice(tagOffset + 1) : 'latest'}`,
  };
}

/** Raw modem requests carry cancellation at the transport level; older Dockerode image wrappers discard it. */
async function request(docker: Pick<Dockerode, 'modem'>, options: Record<string, unknown> & { path: string }, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      settled = true;
      reject(invalid());
    };
    signal.addEventListener('abort', abort, { once: true });
    const finish = (error: unknown, value: unknown) => {
      signal.removeEventListener('abort', abort);
      if (settled) {
        if (record(value) && typeof value.destroy === 'function') Reflect.apply(value.destroy, value, []);
        return;
      }
      settled = true;
      if (error || signal.aborted) reject(invalid());
      else resolve(value);
    };
    try {
      docker.modem.dial({ ...options, abortSignal: signal }, finish);
    } catch {
      finish(invalid(), undefined);
    }
  });
}

async function consumePull(value: unknown, signal: AbortSignal) {
  if (!record(value) || typeof value.destroy !== 'function' || typeof Reflect.get(value, Symbol.asyncIterator) !== 'function') throw invalid();
  const stream = value as unknown as Readable;
  const abort = () => stream.destroy(invalid());
  signal.addEventListener('abort', abort, { once: true });
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let events = 0;
  const consume = (line: Buffer) => {
    if (!line.length) return;
    if (++events > 32768) throw invalid();
    const item: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
    if (!record(item) || item.error !== undefined || item.errorDetail !== undefined) throw invalid();
  };
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw invalid();
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += input.length;
      if (bytes > 16 * 1024 * 1024) throw invalid();
      pending = Buffer.concat([pending, input]);
      let end = pending.indexOf(10);
      while (end >= 0) {
        if (end > 256 * 1024) throw invalid();
        consume(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
        end = pending.indexOf(10);
      }
      if (pending.length > 256 * 1024) throw invalid();
    }
    consume(pending);
    signal.throwIfAborted();
    if (!events) throw invalid();
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

/** Preparation only: no container create/start, app stop, storage grant or ledger write. */
export async function prepareAppMigrationImage(
  docker: Pick<Dockerode, 'modem'>,
  definition: AppMigrationDefinition,
  context: { architecture: 'amd64' | 'arm64'; signal?: AbortSignal; auth?: Dockerode.AuthConfig },
): Promise<AppMigrationImage> {
  try {
    if (!['amd64', 'arm64'].includes(context.architecture)) throw invalid();
    const serialized = JSON.stringify(definition);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw invalid();
    // Snapshot before awaiting transport, so later caller mutations cannot change the binding.
    const snapshot: AppMigrationDefinition = JSON.parse(serialized);
    if (
      typeof snapshot.id !== 'string' ||
      !appMigrationIdPattern.test(snapshot.id) ||
      !/^[a-f0-9]{64}$/.test(snapshot.sourceSha256) ||
      !Array.isArray(snapshot.mounts)
    )
      throw invalid();
    const definitionSha256 = hash(serialized);
    const selected = reference(snapshot.image);
    const platform = snapshot.platform ?? `linux/${context.architecture}`;
    const [os, architecture, variant] = platform.split('/');
    if (
      !/^linux\/(?:amd64(?:\/v1)?|arm64(?:\/v8)?)$/.test(platform) ||
      os !== 'linux' ||
      architecture !== context.architecture ||
      (variant !== undefined && variant !== (architecture === 'arm64' ? 'v8' : 'v1'))
    )
      throw invalid();
    const deadline = AbortSignal.timeout(10 * 60 * 1000);
    const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
    const distribution = await request(
      docker,
      {
        path: `/distribution/${selected.selected}/json`,
        method: 'GET',
        options: {},
        authconfig: context.auth,
        statusCodes: { 200: true, 401: 'Unavailable', 404: 'Unavailable', 500: 'Unavailable' },
      },
      signal,
    );
    if (
      !record(distribution) ||
      !record(distribution.Descriptor) ||
      typeof distribution.Descriptor.digest !== 'string' ||
      !digest.test(distribution.Descriptor.digest)
    )
      throw invalid();
    const pinned = distribution.Descriptor.digest;
    if (selected.pinned !== undefined && selected.pinned !== pinned) throw invalid();
    if (
      !Array.isArray(distribution.Platforms) ||
      distribution.Platforms.length > 1024 ||
      !distribution.Platforms.some(
        (entry: unknown) =>
          record(entry) &&
          entry.os === os &&
          entry.architecture === architecture &&
          (!variant || (entry.variant || (architecture === 'arm64' ? 'v8' : 'v1')) === variant),
      )
    )
      throw invalid();
    const immutable = `${selected.repository}@${pinned}`;
    const pulled = await request(
      docker,
      {
        path: '/images/create?',
        method: 'POST',
        options: { fromImage: immutable, platform },
        authconfig: context.auth,
        isStream: true,
        statusCodes: { 200: true, 404: 'Unavailable', 500: 'Unavailable' },
      },
      signal,
    );
    await consumePull(pulled, signal);
    const inspect = (image: string) =>
      request(
        docker,
        {
          path: `/images/${image}/json`,
          method: 'GET',
          options: {},
          statusCodes: { 200: true, 404: 'Unavailable', 500: 'Unavailable' },
        },
        signal,
      );
    const image = await inspect(immutable);
    if (!record(image) || typeof image.Id !== 'string' || !digest.test(image.Id)) throw invalid();
    const stable = await inspect(image.Id);
    for (const observation of [image, stable]) {
      if (
        !record(observation) ||
        observation.Id !== image.Id ||
        observation.Os !== os ||
        observation.Architecture !== architecture ||
        !record(observation.Config)
      )
        throw invalid();
      if (variant && (observation.Variant || (architecture === 'arm64' ? 'v8' : 'v1')) !== variant) throw invalid();
      if (
        !Array.isArray(observation.RepoDigests) ||
        observation.RepoDigests.length > 1024 ||
        !observation.RepoDigests.some((entry: unknown) => {
          if (typeof entry !== 'string') return false;
          try {
            const parsed = reference(entry);
            return parsed.repository === selected.repository && parsed.pinned === pinned;
          } catch {
            return false;
          }
        })
      )
        throw invalid();
      const volumes = observation.Config.Volumes;
      if (
        volumes !== undefined &&
        volumes !== null &&
        (!record(volumes) ||
          Object.keys(volumes).length > 64 ||
          Object.keys(volumes).some((destination) => !snapshot.mounts.some((mount) => mount.target === destination)))
      )
        throw invalid();
    }
    if (JSON.stringify(image.Config) !== JSON.stringify((stable as Record<string, unknown>).Config)) throw invalid();
    signal.throwIfAborted();
    return Object.freeze({
      migrationId: snapshot.id,
      sourceSha256: snapshot.sourceSha256,
      definitionSha256,
      reference: immutable,
      imageId: image.Id,
      platform,
    });
  } catch {
    throw invalid();
  }
}
