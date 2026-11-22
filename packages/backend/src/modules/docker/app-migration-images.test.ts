import { createHash } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { prepareAppMigrationImage } from './app-migration-images';
import { parseAppMigration } from './app-migration-plan';

const manifest = `sha256:${'a'.repeat(64)}`;
const local = `sha256:${'b'.repeat(64)}`;
const pinned = `docker.io/library/postgres@${manifest}`;
const plan = (image = 'postgres:16.1', platform?: string) => {
  const bytes = Buffer.from(
    stringify({
      services: {
        migration: {
          image,
          user: 'postgres',
          volumes: ['/fixture/app-data/db:/var/lib/postgresql/data'],
          command: ['true'],
          ...(platform ? { platform } : {}),
        },
      },
    }),
  );
  return parseAppMigration(
    { id: '001-upgrade', bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
    { appDataHostPath: '/fixture/app-data', environment: {} },
  );
};
const image = () => ({
  Id: local,
  Os: 'linux',
  Architecture: 'amd64',
  RepoDigests: [`postgres@${manifest}`],
  Config: { Volumes: { '/var/lib/postgresql/data': {} } },
});
type Options = Record<string, unknown>;
type Callback = (error: unknown, value?: unknown) => void;
function transport(effect?: (options: Options, value: unknown, count: number) => unknown) {
  const calls: Options[] = [];
  const dial = vi.fn((options: Options, callback: Callback) => {
    calls.push(options);
    const value =
      options.path === '/images/create?'
        ? Readable.from(['{"status":"Pulling"}\n{"status":"Digest verified"}\n'])
        : String(options.path).startsWith('/distribution/')
          ? { Descriptor: { digest: manifest }, Platforms: [{ os: 'linux', architecture: 'amd64' }] }
          : image();
    try {
      callback(null, effect ? effect(options, value, calls.length) : value);
    } catch (error) {
      callback(error);
    }
  });
  return { docker: { modem: { dial } } as unknown as Pick<Dockerode, 'modem'>, calls };
}

describe('migration image preparation', () => {
  it('resolves the tag once, pulls only its digest and checks the immutable local ID without creating a process', async () => {
    const { docker, calls } = transport();
    const definition = plan();
    const result = await prepareAppMigrationImage(docker, definition, { architecture: 'amd64' });
    expect(result).toEqual({
      migrationId: definition.id,
      sourceSha256: definition.sourceSha256,
      definitionSha256: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      reference: pinned,
      imageId: local,
      platform: 'linux/amd64',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls.map(({ path }) => path)).toEqual([
      '/distribution/docker.io/library/postgres:16.1/json',
      '/images/create?',
      `/images/${pinned}/json`,
      `/images/${local}/json`,
    ]);
    expect(calls[1]?.options).toEqual({ fromImage: pinned, platform: 'linux/amd64' });
    expect(calls.every(({ abortSignal }) => abortSignal instanceof AbortSignal)).toBe(true);
    expect(calls.every(({ path }) => !String(path).includes('containers'))).toBe(true);
  });

  it('preserves an explicit digest and registry port with no mutable tag pull', async () => {
    const input = `registry.example:5000/team/postgres:tag@${manifest}`;
    const { docker, calls } = transport((options, value) =>
      String(options.path).startsWith('/images/') && options.method === 'GET'
        ? { ...image(), RepoDigests: [`registry.example:5000/team/postgres@${manifest}`] }
        : value,
    );
    const result = await prepareAppMigrationImage(docker, plan(input), { architecture: 'amd64' });
    expect(result.reference).toBe(`registry.example:5000/team/postgres@${manifest}`);
    expect(calls[0]?.path).toBe(`/distribution/registry.example:5000/team/postgres@${manifest}/json`);
  });

  it('supports the native arm64 default variant while verifying both registry and local architecture', async () => {
    const { docker } = transport((options, value) =>
      String(options.path).startsWith('/distribution/')
        ? { Descriptor: { digest: manifest }, Platforms: [{ os: 'linux', architecture: 'arm64' }] }
        : options.method === 'GET'
          ? { ...image(), Architecture: 'arm64' }
          : value,
    );
    await expect(prepareAppMigrationImage(docker, plan('postgres', 'linux/arm64/v8'), { architecture: 'arm64' })).resolves.toMatchObject({
      platform: 'linux/arm64/v8',
    });
  });

  it.each([
    'other@sha256:bad',
    'repo:bad?query',
    'repo#fragment',
    'repo:tag:extra',
    'https://registry.example/repo',
    'registry.example:65536/repo',
    '../repo',
    `sha256:${'a'.repeat(64)}`,
  ])('refuses unsupported image reference %s before transport', async (input) => {
    const { docker, calls } = transport();
    await expect(prepareAppMigrationImage(docker, { ...plan(), image: input }, { architecture: 'amd64' })).rejects.toThrow('could not be verified');
    expect(calls).toHaveLength(0);
  });

  it.each(['linux/arm64', 'linux/amd64/v2', 'linux/amd64/v1/extra', 'windows/amd64'])(
    'refuses an unsupported or mismatched requested platform %s',
    async (platform) => {
      const { docker, calls } = transport();
      await expect(prepareAppMigrationImage(docker, { ...plan(), platform }, { architecture: 'amd64' })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    { Descriptor: { digest: 'mutable' }, Platforms: [] },
    { Descriptor: { digest: manifest }, Platforms: [{ os: 'linux', architecture: 'arm64' }] },
    { Descriptor: { digest: manifest } },
  ])('rejects an unqualified registry response before pulling %#', async (response) => {
    const { docker, calls } = transport((_options, value, count) => (count === 1 ? response : value));
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('refuses a registry digest different from the explicitly requested digest', async () => {
    const { docker, calls } = transport();
    await expect(prepareAppMigrationImage(docker, plan(`postgres@sha256:${'c'.repeat(64)}`), { architecture: 'amd64' })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it.each([
    { Id: 'mutable' },
    { Os: 'windows' },
    { Architecture: 'arm64' },
    { RepoDigests: [] },
    { RepoDigests: [`other@${manifest}`] },
    { Config: null },
    { Config: { Volumes: { '/uncovered': {} } } },
    { Config: { Volumes: { '/var/lib/postgresql': {} } } },
    { Config: { Volumes: { '/var/lib/postgresql/data/nested': {} } } },
  ])('refuses local image or hidden storage mismatch %#', async (change) => {
    const { docker } = transport((options, value) =>
      options.method === 'GET' && String(options.path).startsWith('/images/') ? { ...image(), ...change } : value,
    );
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow();
  });

  it('checks the immutable ID again instead of trusting a mutable reference inspection', async () => {
    const { docker } = transport((options, value) =>
      options.path === `/images/${local}/json` ? { ...image(), Id: `sha256:${'c'.repeat(64)}` } : value,
    );
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow();
  });

  it('detects changed image configuration between the reference and exact-ID observations', async () => {
    const { docker } = transport((options, value) =>
      options.path === `/images/${local}/json` ? { ...image(), Config: { Volumes: {}, User: 'root' } } : value,
    );
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow();
  });

  it.each([
    '',
    'not-json\n',
    '{"error":"synthetic-private-detail"}\n',
    '{"errorDetail":{}}\n',
    '{"status":"unterminated"',
    'x'.repeat(256 * 1024 + 1),
  ])('refuses invalid or failed pull output %# without reporting raw content', async (output) => {
    const { docker, calls } = transport((options, value) => (options.path === '/images/create?' ? Readable.from([output]) : value));
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow(
      /^The app migration image could not be verified\.$/,
    );
    expect(calls).toHaveLength(2);
  });

  it('handles fragmented UTF-8 JSON progress without confusing progress with image verification', async () => {
    const bytes = Buffer.from('{"status":"Pulling · layer"}\n{"status":"Done"}');
    const { docker, calls } = transport((options, value) =>
      options.path === '/images/create?' ? Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))) : value,
    );
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).resolves.toMatchObject({ imageId: local });
    expect(calls).toHaveLength(4);
  });

  it('cancels a pending transport even when the daemon never sends a callback', async () => {
    const abort = new AbortController();
    let reply: Callback | undefined;
    const docker = {
      modem: {
        dial: (_options: Options, callback: Callback) => {
          reply = callback;
        },
      },
    } as unknown as Pick<Dockerode, 'modem'>;
    const pending = prepareAppMigrationImage(docker, plan(), { architecture: 'amd64', signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow(/^The app migration image could not be verified\.$/);
    const late = Readable.from(['late']);
    reply?.(null, late);
    expect(late.destroyed).toBe(true);
  });

  it('cancels and destroys a stalled pull stream without creating a runner', async () => {
    const abort = new AbortController();
    const stream = new Readable({
      read() {
        abort.abort();
      },
    });
    const { docker, calls } = transport((options, value) => (options.path === '/images/create?' ? stream : value));
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64', signal: abort.signal })).rejects.toThrow();
    expect(stream.destroyed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('binds the original definition despite a caller modifying its mutable copy during a request', async () => {
    const definition = { ...plan() };
    const original = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    const { docker } = transport((_options, value, count) => {
      if (count === 1) definition.image = 'different:tag';
      return value;
    });
    expect((await prepareAppMigrationImage(docker, definition, { architecture: 'amd64' })).definitionSha256).toBe(original);
  });
});

describe('actual Engine HTTP transport with a synthetic server', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  });
  async function serve(handler: http.RequestListener) {
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic HTTP fixture unavailable');
    return new Dockerode({ host: '127.0.0.1', port: address.port, protocol: 'http', version: 'v1.44' });
  }

  it('sends versioned Engine requests through the installed Dockerode transport and consumes the real response stream', async () => {
    const requests: { method?: string; path: string; image?: string | null; platform?: string | null }[] = [];
    const docker = await serve((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture');
      requests.push({
        method: request.method,
        path: url.pathname,
        ...(request.method === 'POST' ? { image: url.searchParams.get('fromImage'), platform: url.searchParams.get('platform') } : {}),
      });
      response.setHeader('content-type', 'application/json');
      if (url.pathname.startsWith('/v1.44/distribution/'))
        response.end(JSON.stringify({ Descriptor: { digest: manifest }, Platforms: [{ os: 'linux', architecture: 'amd64' }] }));
      else if (url.pathname === '/v1.44/images/create') {
        response.write('{"status":"Pulling"}\n');
        response.end('{"status":"Complete"}\n');
      } else response.end(JSON.stringify(image()));
    });
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).resolves.toMatchObject({ imageId: local });
    expect(requests).toEqual([
      { method: 'GET', path: '/v1.44/distribution/docker.io/library/postgres:16.1/json' },
      { method: 'POST', path: '/v1.44/images/create', image: pinned, platform: 'linux/amd64' },
      { method: 'GET', path: `/v1.44/images/${pinned}/json` },
      { method: 'GET', path: `/v1.44/images/${local}/json` },
    ]);
  });

  it('cancels a real pending HTTP request and returns only the bounded error', async () => {
    const abort = new AbortController();
    let received: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    const docker = await serve(() => {
      received?.();
    });
    const result = prepareAppMigrationImage(docker, plan(), { architecture: 'amd64', signal: abort.signal });
    const checked = expect(result).rejects.toThrow(/^The app migration image could not be verified\.$/);
    await ready;
    abort.abort();
    await checked;
  });

  it('refuses a dropped streaming response before any image inspection', async () => {
    let requests = 0;
    const docker = await serve((request, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET')
        response.end(JSON.stringify({ Descriptor: { digest: manifest }, Platforms: [{ os: 'linux', architecture: 'amd64' }] }));
      else {
        response.write('{"status":"Pulling"}\n', () => response.destroy());
      }
    });
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow();
    expect(requests).toBe(2);
  });

  it('normalizes an actual unauthorized HTTP response without exposing daemon content', async () => {
    const docker = await serve((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'synthetic private transport detail' }));
    });
    await expect(prepareAppMigrationImage(docker, plan(), { architecture: 'amd64' })).rejects.toThrow(
      /^The app migration image could not be verified\.$/,
    );
  });
});
