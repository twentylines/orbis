import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { errorMonitor } from 'node:events';
import { Duplex, type WritableOptions } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type Dockerode from 'dockerode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupDockerExec, BackupDatabaseLines } from './backup-docker-exec';
import { backupDatabaseSandbox } from './backup-database.service';
import { BackupRequirementError } from './backup-files';

let directory: string;
const transports = new Set<ExecTransport>();
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-exec-streams-')));
  await fs.chmod(directory, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stream of transports) stream.destroy();
  transports.clear();
  await fs.rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class ExecTransport extends Duplex {
  readonly input: Buffer[] = [];
  stdinEnded = false;
  onInput?: (chunk: Buffer, done: (error?: Error | null) => void) => void;
  onInputEnd?: () => void;
  constructor(options: WritableOptions = {}) {
    super({ allowHalfOpen: true, writableHighWaterMark: 1024, ...options });
    transports.add(this);
  }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.input.push(Buffer.from(chunk));
    if (this.onInput) this.onInput(chunk, done);
    else done();
  }
  override _final(done: (error?: Error | null) => void) {
    this.stdinEnded = true;
    done();
    this.onInputEnd?.();
  }
  send(chunks: Buffer[], end = true) {
    for (const chunk of chunks) this.push(chunk);
    if (end) this.push(null);
  }
}
function frame(channel: number, payload = Buffer.alloc(0), declared = payload.length) {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(declared, 4);
  return Buffer.concat([header, payload]);
}
function fixture(transport = new ExecTransport()) {
  const started = deferred();
  const operation = {
    start: vi.fn(async () => {
      started.resolve();
      return transport;
    }),
    inspect: vi.fn(async () => ({ Running: false, ExitCode: 0 })),
  };
  const container = { exec: vi.fn(async () => operation) };
  return { transport, operation, container, started: started.promise };
}
function execute(test: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof backupDockerExec>[0]> = {}) {
  return backupDockerExec({
    container: test.container as unknown as Dockerode.Container,
    command: ['fixture-command'],
    signal: new AbortController().signal,
    maxOutputBytes: 1024 * 1024,
    stdout: async () => undefined,
    ...overrides,
  });
}
async function sendAfterStart(test: ReturnType<typeof fixture>, chunks: Buffer[], end = true) {
  await test.started;
  await nextTurn();
  test.transport.send(chunks, end);
}

it('reassembles fragmented multiplex headers/payloads and separates stdout from stderr', async () => {
  const test = fixture();
  const output: Buffer[] = [];
  const bytes = Buffer.concat([frame(1, Buffer.from('first')), frame(2, Buffer.from('notice')), frame(1), frame(1, Buffer.from('😀last'))]);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 3) chunks.push(bytes.subarray(offset, offset + 3));
  const running = execute(test, {
    stdout: async (chunk) => {
      output.push(Buffer.from(chunk));
    },
  });
  await sendAfterStart(test, chunks);
  expect(await running).toBe(Buffer.byteLength('first😀last'));
  expect(Buffer.concat(output).toString()).toBe('first😀last');
  expect(test.container.exec).toHaveBeenCalledWith(
    expect.objectContaining({ Cmd: ['fixture-command'], AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: false }),
  );
  expect(test.transport.destroyed).toBe(true);
});

it('awaits the stdout consumer before delivering subsequent frames', async () => {
  const test = fixture();
  const reached = deferred();
  const resume = deferred();
  let calls = 0;
  const running = execute(test, {
    stdout: async () => {
      if (++calls === 1) {
        reached.resolve();
        await resume.promise;
      }
    },
  });
  await sendAfterStart(test, [Buffer.concat([frame(1, Buffer.from('one')), frame(1, Buffer.from('two'))])]);
  await reached.promise;
  expect(calls).toBe(1);
  resume.resolve();
  expect(await running).toBe(6);
  expect(calls).toBe(2);
});

it('pipes a real source with backpressure and half-closes stdin before reading the final response', async () => {
  const source = path.join(directory, 'source.dump');
  const content = Buffer.alloc(512 * 1024, 41);
  await fs.writeFile(source, content, { mode: 0o600 });
  const test = fixture();
  const firstWrite = deferred();
  let unblock!: () => void;
  let writes = 0;
  test.transport.onInput = (_chunk, done) => {
    if (++writes === 1) {
      unblock = () => done();
      firstWrite.resolve();
    } else done();
  };
  test.transport.onInputEnd = () => {
    test.transport.send([frame(1, Buffer.from('complete'))]);
  };
  const running = execute(test, { source });
  await firstWrite.promise;
  await nextTurn();
  expect(writes).toBe(1);
  expect(test.transport.stdinEnded).toBe(false);
  unblock();
  expect(await running).toBe(8);
  expect(test.transport.stdinEnded).toBe(true);
  expect(test.transport.writableFinished).toBe(true);
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  expect(digest(Buffer.concat(test.transport.input)) === digest(content)).toBe(true);
  expect(test.container.exec).toHaveBeenCalledWith(expect.objectContaining({ AttachStdin: true }));
  expect(test.operation.start).toHaveBeenCalledWith(expect.objectContaining({ hijack: true, stdin: true }));
});

it.each([
  ['stdout', 1, 33, 32],
  ['stderr', 2, 65537, 1024],
] as const)('rejects an oversized %s declaration before reading payload', async (_name, channel, declared, maximum) => {
  const test = fixture();
  const stdout = vi.fn(async () => undefined);
  const running = execute(test, { maxOutputBytes: maximum, stdout, signal: AbortSignal.timeout(500) });
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await sendAfterStart(test, [frame(channel, Buffer.alloc(0), declared)], false);
  await rejected;
  expect(stdout).not.toHaveBeenCalled();
  expect(test.operation.inspect).not.toHaveBeenCalled();
  expect(test.transport.destroyed).toBe(true);
});

it('enforces the remaining stdout quota across multiple frames', async () => {
  const test = fixture();
  const stdout = vi.fn(async () => undefined);
  const running = execute(test, { maxOutputBytes: 3, stdout });
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await sendAfterStart(test, [Buffer.concat([frame(1, Buffer.from('ab')), frame(1, Buffer.alloc(0), 2)])]);
  await rejected;
  expect(stdout).toHaveBeenCalledTimes(1);
});

it('accepts the exact stderr limit without exposing its contents to stdout', async () => {
  const test = fixture();
  const output: Buffer[] = [];
  const running = execute(test, {
    maxOutputBytes: 1,
    stdout: async (chunk) => {
      output.push(Buffer.from(chunk));
    },
  });
  await sendAfterStart(test, [frame(2, Buffer.alloc(64 * 1024, 120)), frame(1, Buffer.from('x'))]);
  expect(await running).toBe(1);
  expect(Buffer.concat(output).toString()).toBe('x');
});

it('rejects cumulative stderr overflow before accepting its next payload', async () => {
  const test = fixture();
  const running = execute(test);
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await sendAfterStart(test, [frame(2, Buffer.alloc(64 * 1024)), frame(2, Buffer.alloc(0), 1)]);
  await rejected;
});

it.each(['short-header', 'short-payload', 'invalid-channel', 'reserved-header-byte'] as const)('rejects invalid framing: %s', async (kind) => {
  const test = fixture();
  let bytes = frame(1, Buffer.from('abc'));
  if (kind === 'short-header') bytes = bytes.subarray(0, 7);
  if (kind === 'short-payload') bytes = frame(1, Buffer.from('abc'), 4);
  if (kind === 'invalid-channel') bytes[0] = 3;
  if (kind === 'reserved-header-byte') bytes[2] = 1;
  const running = execute(test);
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await sendAfterStart(test, [bytes]);
  await rejected;
  expect(test.transport.destroyed).toBe(true);
});

it('rejects nonzero command exit after an otherwise complete stream', async () => {
  const test = fixture();
  test.operation.inspect.mockResolvedValue({ Running: false, ExitCode: 9 });
  const running = execute(test);
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await sendAfterStart(test, [frame(1, Buffer.from('x'))]);
  await rejected;
});

it('waits for Docker to publish a terminal exec status after stream EOF', async () => {
  const test = fixture();
  test.operation.inspect.mockResolvedValueOnce({ Running: true, ExitCode: 0 }).mockResolvedValueOnce({ Running: true, ExitCode: 0 });
  const running = execute(test);
  await sendAfterStart(test, []);
  expect(await running).toBe(0);
  expect(test.operation.inspect).toHaveBeenCalledTimes(3);
});

it('honours an already-aborted signal before creating an exec', async () => {
  const test = fixture();
  await expect(execute(test, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(test.container.exec).not.toHaveBeenCalled();
});

it('destroys the duplex when cancelled while awaiting output', async () => {
  const test = fixture();
  const controller = new AbortController();
  const running = execute(test, { signal: controller.signal });
  const rejected = expect(running).rejects.toThrow();
  await test.started;
  await nextTurn();
  controller.abort();
  await rejected;
  expect(test.transport.destroyed).toBe(true);
});

it('handles transport errors when abort arrives during asynchronous source opening', async () => {
  const source = path.join(directory, 'opening.dump');
  await fs.writeFile(source, 'disposable source', { mode: 0o600 });
  const opening = deferred();
  const resume = deferred();
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === source) {
      opening.resolve();
      await resume.promise;
    }
    return actualOpen(...args);
  });
  const test = fixture();
  const controller = new AbortController();
  let otherwiseUnhandled = false;
  test.transport.on(errorMonitor, () => {
    if (!test.transport.listenerCount('error')) {
      otherwiseUnhandled = true;
      test.transport.once('error', () => undefined);
    }
  });
  const running = execute(test, { source, signal: controller.signal });
  const rejected = expect(running).rejects.toThrow();
  try {
    await opening.promise;
    controller.abort();
    await nextTurn();
  } finally {
    resume.resolve();
  }
  await rejected;
  expect(otherwiseUnhandled).toBe(false);
  expect(test.transport.destroyed).toBe(true);
});

it('closes transport when the source cannot be opened', async () => {
  const test = fixture();
  await expect(execute(test, { source: path.join(directory, 'missing.dump') })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(test.transport.destroyed).toBe(true);
  expect(test.operation.inspect).not.toHaveBeenCalled();
});

it('propagates a real source read error and closes the transport', async () => {
  const source = path.join(directory, 'directory-not-a-file');
  await fs.mkdir(source);
  const test = fixture();
  await expect(execute(test, { source, signal: AbortSignal.timeout(500) })).rejects.toBeInstanceOf(BackupRequirementError);
  expect(test.transport.destroyed).toBe(true);
});

it('refuses symlink sources rather than following them', async () => {
  const source = path.join(directory, 'actual.dump');
  await fs.writeFile(source, 'fixture', { mode: 0o600 });
  const linked = path.join(directory, 'linked.dump');
  await fs.symlink(source, linked);
  const test = fixture();
  await expect(execute(test, { source: linked })).rejects.toMatchObject({ code: 'ELOOP' });
  expect(test.transport.input).toHaveLength(0);
  expect(test.transport.destroyed).toBe(true);
});

it('rejects apparent success when command stdout ends before all stdin is consumed', async () => {
  const source = path.join(directory, 'unfinished.dump');
  await fs.writeFile(source, Buffer.alloc(512 * 1024), { mode: 0o600 });
  const test = fixture();
  const firstWrite = deferred();
  test.transport.onInput = (_chunk, _done) => {
    firstWrite.resolve();
  };
  const running = execute(test, { source });
  const rejected = expect(running).rejects.toBeInstanceOf(BackupRequirementError);
  await firstWrite.promise;
  test.transport.push(null);
  await rejected;
  expect(test.transport.stdinEnded).toBe(false);
});

it('propagates consumer failures and destroys the stream', async () => {
  const test = fixture();
  const problem = new Error('Disposable output consumer failure');
  const running = execute(test, {
    stdout: async () => {
      throw problem;
    },
  });
  const rejected = expect(running).rejects.toBe(problem);
  await sendAfterStart(test, [frame(1, Buffer.from('x'))]);
  await rejected;
  expect(test.transport.destroyed).toBe(true);
});

const lineLimits = { rowBytes: 128, totalBytes: 512, rows: 3 };
it('parses UTF-8 JSON lines across every byte boundary into a private real file', async () => {
  const output = path.join(directory, 'normalized.ndjson');
  const lines = new BackupDatabaseLines(lineLimits, async (value) => {
    await fs.appendFile(output, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  });
  const bytes = Buffer.from('{"text":"界😀"}\n{"id":2}\n');
  for (const byte of bytes) await lines.write(Buffer.from([byte]));
  lines.finish();
  expect(
    (await fs.readFile(output, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((value) => JSON.parse(value)),
  ).toEqual([{ text: '界😀' }, { id: 2 }]);
  expect((await fs.stat(output)).mode & 0o077).toBe(0);
});

it('accepts zero rows and exact line/total/row-count boundaries', async () => {
  const empty = new BackupDatabaseLines(lineLimits, async () => undefined);
  await empty.write(Buffer.alloc(0));
  empty.finish();
  const accepted: unknown[] = [];
  const row = Buffer.from('{"x":"😀"}\n');
  const lines = new BackupDatabaseLines({ rowBytes: row.length - 1, totalBytes: row.length * 2, rows: 2 }, async (value) => {
    accepted.push(value);
  });
  await lines.write(Buffer.concat([row, row]));
  lines.finish();
  expect(accepted).toHaveLength(2);
});

it.each(['row-bytes', 'total-bytes', 'row-count'] as const)('bounds JSON line input: %s', async (kind) => {
  const row = Buffer.from('{"x":"😀"}\n');
  const limits = { rowBytes: row.length - 1, totalBytes: row.length * 2, rows: 2 };
  if (kind === 'row-bytes') limits.rowBytes--;
  if (kind === 'total-bytes') limits.totalBytes--;
  if (kind === 'row-count') limits.rows--;
  const lines = new BackupDatabaseLines(limits, async () => undefined);
  await expect(lines.write(Buffer.concat([row, row]))).rejects.toBeInstanceOf(BackupRequirementError);
});

it.each([
  ['blank row', Buffer.from('\n')],
  ['malformed JSON', Buffer.from('{broken}\n')],
  ['invalid UTF-8', Buffer.from([0x22, 0xc0, 0xaf, 0x22, 0x0a])],
  ['truncated UTF-8', Buffer.from([0x22, 0xe2, 0x82, 0x22, 0x0a])],
] as const)('rejects invalid JSON lines: %s', async (_name, bytes) => {
  const accept = vi.fn(async () => undefined);
  const lines = new BackupDatabaseLines(lineLimits, accept);
  await expect(lines.write(bytes)).rejects.toBeInstanceOf(BackupRequirementError);
  expect(accept).not.toHaveBeenCalled();
});

it('rejects a final JSON record without a line feed', async () => {
  const accepted = vi.fn(async () => undefined);
  const lines = new BackupDatabaseLines(lineLimits, accepted);
  await lines.write(Buffer.from('{"id":1}\n{"id":2}'));
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(() => lines.finish()).toThrow(BackupRequirementError);
});

it('backpressures JSON-row acceptance and propagates its rejection', async () => {
  const reached = deferred();
  const resume = deferred();
  const problem = new Error('Disposable row consumer failure');
  let calls = 0;
  const lines = new BackupDatabaseLines(lineLimits, async () => {
    calls++;
    reached.resolve();
    await resume.promise;
    throw problem;
  });
  const writing = lines.write(Buffer.from('{"id":1}\n{"id":2}\n'));
  const rejected = expect(writing).rejects.toBe(problem);
  await reached.promise;
  expect(calls).toBe(1);
  resume.resolve();
  await rejected;
  expect(calls).toBe(1);
});

const image = `sha256:${'a'.repeat(64)}`;
const sandbox = (volumes: string[] = []) => backupDatabaseSandbox(image, 'orbis-database-review-fixture', 'fixture-nonce', volumes);
it('keeps sandbox resources isolated and shadows every declared PostgreSQL image volume with bounded tmpfs', () => {
  const declared = ['/var/lib/postgresql', '/var/lib/postgresql/data'];
  const options = sandbox(declared);
  const host = options.HostConfig;
  if (!host) throw new Error('Missing sandbox host configuration');
  expect(options.Image).toBe(image);
  expect(options.User).toBe('postgres');
  expect(options.NetworkDisabled).toBe(true);
  expect(options.Env?.some((value) => /PASSWORD|TOKEN|SECRET/.test(value))).toBe(false);
  expect(options.Healthcheck?.Test).toEqual(['NONE']);
  expect(host.NetworkMode).toBe('none');
  expect(host.ReadonlyRootfs).toBe(true);
  expect(host.Privileged).toBe(false);
  expect(host.CapDrop).toContain('ALL');
  expect(host.CapAdd?.length ?? 0).toBe(0);
  expect(host.SecurityOpt).toContain('no-new-privileges:true');
  expect(host.Binds).toEqual([]);
  expect(host.VolumesFrom?.length ?? 0).toBe(0);
  expect(host.Devices?.length ?? 0).toBe(0);
  expect(host.DeviceRequests?.length ?? 0).toBe(0);
  expect(Object.keys(host.PortBindings ?? {})).toHaveLength(0);
  expect(host.PublishAllPorts ?? false).toBe(false);
  expect(host.LogConfig?.Type).toBe('none');
  expect(host.Memory).toBeGreaterThan(0);
  expect(host.MemorySwap).toBe(host.Memory);
  expect(host.NanoCpus).toBeGreaterThan(0);
  expect(host.PidsLimit).toBeGreaterThan(0);
  expect(host.IpcMode).toBe('private');
  expect(host.RestartPolicy?.Name).toBe('no');
  for (const name of ['/sandbox', '/tmp', ...declared]) {
    const mount = host.Tmpfs?.[name] ?? '';
    expect(mount).toMatch(/(?:^|,)size=\d+[mk](?:,|$)/);
    expect(mount).toContain('noexec');
    expect(mount).toContain('nosuid');
    expect(mount).toContain('nodev');
  }
  expect(Object.keys(host.Tmpfs ?? {}).sort()).toEqual(['/sandbox', '/tmp', ...declared].sort());
});

it.each(['/var/run/docker.sock', '/etc', '/var/lib/postgresql/../outside', 'var/lib/postgresql/data', '/var/lib/postgresql/data/../../etc'])(
  'rejects unsupported image volume destinations',
  (volume) => {
    expect(() => sandbox([volume])).toThrow(BackupRequirementError);
  },
);
it('rejects excessive image volumes and mutable/noncanonical image references', () => {
  expect(() => sandbox(Array.from({ length: 9 }, (_value, index) => `/var/lib/postgresql/v${index}`))).toThrow(BackupRequirementError);
  for (const reference of ['postgres:latest', 'sha256:short', `sha256:${'A'.repeat(64)}`]) {
    expect(() => backupDatabaseSandbox(reference, 'fixture', 'fixture', [])).toThrow(BackupRequirementError);
  }
});
