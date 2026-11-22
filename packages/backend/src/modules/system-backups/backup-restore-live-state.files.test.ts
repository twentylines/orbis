import fs from 'node:fs';
import http from 'node:http';
import files from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import Dockerode from 'dockerode';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { installRequestDirectory } from '../app-lifecycle/install-request-receipt';
import { BackupRestoreJournal } from './backup-restore-journal';
import { dispatchRestoreMutation } from './backup-restore-live-state';
import { BackupRestoreDockerRuntime, snapshotRestoreContainer, type RestoreOperation, type RestoreRuntimeIdentity } from './backup-restore-runtime';

const id = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
const appUrn = createAppUrn('photos', 'store');
const noRestart = { Name: 'no', MaximumRetryCount: 0 };
const restart = { Name: 'unless-stopped', MaximumRetryCount: 0 } as const;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((directory) => files.rm(directory, { recursive: true, force: true })));
});

it.each([301, 302, 303, 307, 308])('refuses HTTP %s without constructing any redirected Engine request', async (status) => {
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock', host: undefined, protocol: 'http' });
  const agent = http.globalAgent as http.Agent & { addRequest: (request: http.ClientRequest, options: http.RequestOptions) => void };
  const mutations = ['start', { Name: 'no', MaximumRetryCount: 0 }] as const;
  for (const mutation of mutations) {
    let inGuard = false;
    const requests: Array<{ method: string; socketPath?: string; path: string }> = [];
    const intercept = vi.spyOn(agent, 'addRequest').mockImplementation((request, options) => {
      expect(inGuard).toBe(true);
      requests.push({ method: request.method, socketPath: (options as typeof options & { socketPath?: string }).socketPath, path: request.path });
      vi.spyOn(request, 'write').mockReturnValue(true);
      vi.spyOn(request, 'end').mockImplementation(() => {
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), { statusCode: status, headers: { location: 'http://redirect.invalid/unverified' } });
          request.emit('response', response);
          response.end();
        });
        return request;
      });
    });
    try {
      await expect(
        dispatchRestoreMutation(docker, 'a'.repeat(64), mutation, (dispatch) => {
          inGuard = true;
          try {
            dispatch();
          } finally {
            inGuard = false;
          }
        }),
      ).rejects.toThrow(/redirect/i);
      expect(requests).toEqual([
        { method: 'POST', socketPath: '/var/run/docker.sock', path: `/containers/${'a'.repeat(64)}/${mutation === 'start' ? 'start' : 'update'}` },
      ]);
    } finally {
      intercept.mockRestore();
    }
  }
});

async function fixture(options: { phase?: 'discarded' | 'rolled-back' | 'committing'; stopped?: boolean; dedicated?: boolean } = {}) {
  const phase = options.phase ?? 'rolled-back';
  const root = await files.realpath(await files.mkdtemp(path.join(os.tmpdir(), 'orbis-live-resume-')));
  roots.push(root);
  const data = path.join(root, 'data');
  const state = path.join(data, 'state');
  const cache = path.join(root, 'cache');
  await files.mkdir(state, { recursive: true, mode: 0o700 });
  await files.mkdir(cache, { mode: 0o700 });
  const raw = (digit: string, running = false, labels = {}) =>
    ({
      Id: digit.repeat(64),
      Name: `/fixture-${digit}`,
      Image: `sha256:${'a'.repeat(64)}`,
      Config: { Env: [], Labels: labels },
      HostConfig: { RestartPolicy: structuredClone(noRestart) },
      State: { Running: running },
      NetworkSettings: { Networks: {} },
      Mounts: [
        { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
        ...(options.dedicated ? [{ Type: 'bind', Source: '/srv/orbis/state', Destination: '/data/state', RW: true }] : []),
      ],
    }) as unknown as Dockerode.ContainerInspectInfo;
  const original = raw('1');
  const worker = raw('2', true);
  const verifier = raw('3');
  const app = raw('4', false, { 'com.docker.compose.project': 'photos_store' });
  const candidate =
    phase === 'committing'
      ? raw('5', false, {
          'io.orbis.restore': id,
          'io.orbis.restore.nonce': nonce,
          'io.orbis.restore.role': 'candidate',
        })
      : original;
  const store = path.join(data, 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id,
    nonce,
    originalController: original.Id,
    candidateController: candidate.Id,
    worker: worker.Id,
    verifierController: verifier.Id,
    roots: ['state'],
  });
  const journalPath = path.join(journal.directory, 'restore.json');
  const rewriteJournal = (values: object) => files.writeFile(journalPath, JSON.stringify({ ...journal.state, ...values }));
  await rewriteJournal({ phase, decision: phase === 'committing' ? 'commit' : 'rollback' });
  await journal.refresh();
  if (phase !== 'discarded') {
    const stat = await files.lstat(state, { bigint: true });
    await files.mkdir(journal.rootJournal('state'), { mode: 0o700 });
    await files.writeFile(
      path.join(journal.rootJournal('state'), 'swap.json'),
      JSON.stringify({
        id,
        version: 1,
        root: state,
        device: String(stat.dev),
        inode: String(stat.ino),
        phase: phase === 'committing' ? 'committed' : 'rolled-back',
      }),
      { mode: 0o600 },
    );
  }
  const identity: RestoreRuntimeIdentity = {
    version: 1,
    id,
    nonce,
    image: original.Image,
    queue: { host: 'queue', username: 'fixture', password: 'fixture' },
    original: { ...snapshotRestoreContainer(original), running: true, restart },
    candidate: phase === 'committing' ? snapshotRestoreContainer(candidate) : { ...snapshotRestoreContainer(original), running: true, restart },
    worker: snapshotRestoreContainer(worker),
    verifier: snapshotRestoreContainer(verifier),
    apps: [{ project: 'photos_store', container: { ...snapshotRestoreContainer(app), running: !options.stopped, restart } }],
  };
  const operation: RestoreOperation | RestoreRuntimeIdentity =
    phase === 'discarded'
      ? identity
      : {
          ...identity,
          database: {
            connection: { host: 'database', port: 5432, database: 'fixture', user: 'fixture', password: 'fixture' },
            owner: { name: 'restored-fixture', oid: 1, marker: 'fixture' },
            counts: { user: 0, app_store: 1, app: 1, link: 0 },
          },
          originalEnvSha256: 'a'.repeat(64),
          incomingEnvSha256: 'b'.repeat(64),
          resumeApps: [{ id: 1, appUrn }],
          files: { bytes: 0, sha256: 'c'.repeat(64), files: 0, directories: 0 },
        };
  const effects: string[] = [];
  const onInspect = vi.fn(async (_container: Dockerode.ContainerInspectInfo): Promise<void> => {});
  const onStart = vi.fn(async (_container: Dockerode.ContainerInspectInfo): Promise<void> => {});
  const containers = new Map([original, worker, verifier, candidate, app].map((value) => [value.Id, value]));
  const engine = { socket: '/var/run/docker.sock' };
  const onDial = vi.fn<() => void>();
  const onPolicy = vi.fn(async (_container: Dockerode.ContainerInspectInfo): Promise<void> => {});
  const onRequest = vi.fn<(opts: { path: string; socketPath: string }) => void>();
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock', host: undefined, protocol: 'http' });
  const modem = docker.modem as unknown as {
    getSocketPath: () => Promise<string>;
    buildRequest: (
      opts: { path: string; socketPath: string },
      context: unknown,
      data: string | undefined,
      reply: (error: unknown, result?: unknown) => void,
    ) => void;
  };
  modem.getSocketPath = function () {
    if (this !== modem) onDial();
    return Promise.resolve(engine.socket);
  };
  // Only the final socket request is replaced. Dockerode's start/update and
  // docker-modem's asynchronous Unix dispatch run unchanged.
  modem.buildRequest = (opts, _context, data, reply) => {
    onRequest(opts);
    const [, , identifier, verb] = opts.path.split('/');
    const container = identifier && containers.get(identifier);
    if (!container || opts.socketPath !== '/var/run/docker.sock') throw new Error('Unexpected Engine request');
    if (verb === 'start') {
      effects.push(`start:${identifier[0]}`);
      container.State.Running = true;
      void onStart(container).then(() => reply(null, {}), reply);
    } else if (verb === 'update' && data) {
      effects.push(`policy:${identifier[0]}`);
      container.HostConfig.RestartPolicy = JSON.parse(data).RestartPolicy;
      void onPolicy(container).then(() => reply(null, {}), reply);
    } else {
      throw new Error('Unexpected Engine mutation');
    }
  };
  const getContainer = docker.getContainer.bind(docker);
  vi.spyOn(docker, 'getContainer').mockImplementation((identifier) => {
    const container = containers.get(identifier);
    if (!container) throw new Error('Unexpected container');
    const handle = getContainer(identifier);
    handle.inspect = (async () => {
      await onInspect(container);
      return structuredClone(container);
    }) as typeof handle.inspect;
    return handle;
  });
  const runtime = new BackupRestoreDockerRuntime(docker, journal, operation, { data, appData: path.join(root, 'app-data'), cache });
  vi.spyOn(runtime, 'inspectVerifiedWorker').mockResolvedValue(worker);
  await runtime.verifyWorker(worker.Id);
  const hooks = runtime as unknown as { health: () => Promise<void> };
  const health = vi.spyOn(hooks, 'health').mockResolvedValue(undefined);
  const proc = { nested: false, unreadable: false, wrongFd: false };
  const read = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file, option) => {
    if (file === '/proc/self/mountinfo') {
      if (proc.unreadable) throw new Error('Mount authority is unavailable');
      return [
        '20 10 8:1 /srv/orbis/data /data rw - ext4 /dev/test rw',
        ...(options.dedicated ? ['21 20 8:1 /srv/orbis/state /data/state rw - ext4 /dev/test rw'] : []),
        ...(proc.nested ? ['22 20 8:1 /unexpected /data/state/orbis-install-requests rw - ext4 /dev/test rw'] : []),
        '',
      ].join('\n');
    }
    if (typeof file === 'string' && file.startsWith('/proc/self/fdinfo/')) return `mnt_id:\t${proc.wrongFd ? 99 : options.dedicated ? 21 : 20}\n`;
    return read(file, option);
  }) as typeof fs.readFileSync);
  const receipt = installRequestDirectory(data, appUrn);
  const hold = async () => {
    await files.mkdir(receipt, { recursive: true, mode: 0o700 });
    await files.writeFile(path.join(receipt, 'pending'), '', { mode: 0o600 });
  };
  return {
    state,
    operation,
    journal,
    runtime,
    worker,
    original,
    app,
    candidate,
    effects,
    health,
    onInspect,
    onStart,
    onDial,
    onPolicy,
    onRequest,
    hold,
    receipt,
    proc,
    engine,
    rewriteJournal,
  };
}

it.each([{ phase: 'rolled-back' }, { phase: 'discarded' }, { phase: 'rolled-back', dedicated: true }] as const)(
  'resumes an unheld legacy original using verified local bind state (%j)',
  async (options) => {
    const f = await fixture(options);
    await f.runtime.resumeOriginal();
    expect(f.effects).toEqual(['start:4', 'policy:4', 'start:1', 'policy:1']);
  },
);

it('restores a clear stopped policy without starting that app', async () => {
  const f = await fixture({ stopped: true });
  await files.mkdir(f.receipt, { recursive: true, mode: 0o700 });
  await f.runtime.resumeOriginal();
  expect(f.effects).toEqual(['policy:4', 'start:1', 'policy:1']);
});

it('keeps a verified stopped hold quiescent during discard replay', async () => {
  const f = await fixture({ stopped: true, phase: 'discarded' });
  await f.hold();
  await f.runtime.resumeOriginal();
  expect(f.effects).toEqual(['start:1', 'policy:1']);
  expect(await files.readdir(f.receipt)).toEqual(['pending']);
});

it('refuses a recorded running hold before touching any writer', async () => {
  const f = await fixture();
  await f.hold();
  await expect(f.runtime.resumeOriginal()).rejects.toThrow('unfinished install recovery');
  expect(f.effects).toEqual([]);
});

it.each(['running', 'stopped'] as const)('rechecks a receipt created by the last app inspect (%s)', async (intent) => {
  const f = await fixture({ stopped: intent === 'stopped' });
  f.onInspect.mockImplementation(async (container) => {
    if (container.Id === f.app.Id) await f.hold();
  });
  if (intent === 'running') {
    await expect(f.runtime.resumeOriginal()).rejects.toThrow('unfinished install recovery');
    expect(f.effects).toEqual([]);
  } else {
    await f.runtime.resumeOriginal();
    expect(f.effects).toEqual(['start:1', 'policy:1']);
  }
});

it('leaves auto-restart disabled if a hold appears during the admitted Engine start', async () => {
  const f = await fixture();
  f.onStart.mockImplementation(async () => f.hold());
  await expect(f.runtime.resumeOriginal()).rejects.toThrow('unfinished install recovery');
  expect(f.effects).toEqual(['start:4']);
  expect(f.app.HostConfig.RestartPolicy).toEqual(noRestart);
});

it.each([
  'missing-state',
  'replaced-state',
  'mount-shadow',
  'wrong-fd',
  'unreadable-mounts',
  'wrong-engine',
  'changed-worker',
  'journal-changed',
  'symlink-receipts',
] as const)('refuses before any Engine mutation when the live state is unverified (%s)', async (change) => {
  const f = await fixture();
  if (change === 'missing-state') await files.rmdir(f.state);
  if (change === 'replaced-state') {
    await files.rename(f.state, `${f.state}-old`);
    await files.mkdir(f.state, { mode: 0o700 });
  }
  if (change === 'mount-shadow') f.proc.nested = true;
  if (change === 'wrong-fd') f.proc.wrongFd = true;
  if (change === 'unreadable-mounts') f.proc.unreadable = true;
  if (change === 'wrong-engine') f.engine.socket = '/fixture/other-engine.sock';
  if (change === 'changed-worker') f.worker.State.Running = false;
  if (change === 'journal-changed') f.onInspect.mockImplementation(async () => f.rewriteJournal({ phase: 'committing', decision: 'commit' }));
  if (change === 'symlink-receipts') await files.symlink(f.journal.directory, path.dirname(f.receipt));
  await expect(f.runtime.resumeOriginal()).rejects.toMatchObject({ runtimeCheck: 'live-install-state' });
  expect(f.effects).toEqual([]);
});

it.each(['start', 'policy'] as const)('refuses a receipt written in docker-modem’s %s dispatch gap', async (action) => {
  const f = await fixture();
  f.onDial.mockImplementation(() => {
    if (f.effects.length !== (action === 'start' ? 0 : 1)) return;
    queueMicrotask(() => {
      fs.mkdirSync(f.receipt, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(f.receipt, 'pending'), '', { mode: 0o600 });
    });
  });
  await expect(f.runtime.resumeOriginal()).rejects.toThrow('unfinished install recovery');
  expect(f.effects).toEqual(action === 'start' ? [] : ['start:4']);
  expect(f.app.HostConfig.RestartPolicy).toEqual(noRestart);
});

it('pins state and receipt directories through actual Engine request construction and closes them afterward', async () => {
  const f = await fixture();
  await files.mkdir(f.receipt, { recursive: true, mode: 0o700 });
  const pinned = new Map<string, number>();
  const open = fs.openSync.bind(fs);
  vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
    const fd = open(name, flags, mode);
    if (name === f.state || name === f.receipt) pinned.set(name, fd);
    return fd;
  });
  f.onRequest.mockImplementation(({ path: request }) => {
    expect(pinned.size).toBe(2);
    for (const [name, fd] of pinned) expect(fs.fstatSync(fd).ino).toBe(fs.statSync(name).ino);
    expect(request).toMatch(/\/(start|update)$/);
  });
  await f.runtime.resumeOriginal();
  expect(f.onRequest).toHaveBeenCalledTimes(4);
  for (const fd of pinned.values()) expect(() => fs.fstatSync(fd)).toThrow();
});

it('refuses a changed Unix endpoint at the mutation request boundary', async () => {
  const f = await fixture();
  f.onDial.mockImplementationOnce(() => {
    f.engine.socket = '/fixture/other-engine.sock';
  });
  await expect(f.runtime.resumeOriginal()).rejects.toMatchObject({ runtimeCheck: 'live-install-state' });
  expect(f.effects).toEqual([]);
});

it.each(['discarded', 'rolled-back'] as const)('refuses replacement state created during app inspect (%s)', async (phase) => {
  const f = await fixture({ phase });
  f.onInspect.mockImplementation(async (container) => {
    if (container.Id !== f.app.Id) return;
    await f.hold();
    await files.rename(f.state, `${f.state}-previous`);
    await files.mkdir(f.state, { mode: 0o700 });
  });
  await expect(f.runtime.resumeOriginal()).rejects.toMatchObject({ runtimeCheck: 'live-install-state' });
  expect(await files.readdir(path.join(`${f.state}-previous`, path.relative(f.state, f.receipt)))).toEqual(['pending']);
  expect(f.effects).toEqual([]);
});

it('reconciles a lost app-start reply without issuing another start', async () => {
  const f = await fixture();
  f.onStart.mockRejectedValueOnce(new Error('start reply lost'));
  await expect(f.runtime.resumeOriginal()).rejects.toThrow('start reply lost');
  await f.runtime.resumeOriginal();
  expect(f.effects).toEqual(['start:4', 'policy:4', 'start:1', 'policy:1']);
  expect((await f.journal.refresh()).decision).toBe('rollback');
});

it.each(['app', 'original', 'candidate'] as const)('disables policy before a new %s start after a lost policy reply', async (target) => {
  const f = await fixture({ phase: target === 'candidate' ? 'committing' : 'rolled-back' });
  const selected = f[target];
  const go = () => (target === 'candidate' ? f.runtime.activate() : f.runtime.resumeOriginal());
  f.onPolicy.mockImplementation(async (container) => {
    if (container.Id === selected.Id) throw new Error('policy reply lost');
  });
  await expect(go()).rejects.toThrow('policy reply lost');
  expect(selected.HostConfig.RestartPolicy).toEqual(restart);
  selected.State.Running = false;
  f.onPolicy.mockReset().mockResolvedValue(undefined);
  f.onStart.mockImplementation(async (container) => {
    if (container.Id !== selected.Id) return;
    expect(container.HostConfig.RestartPolicy).toEqual(noRestart);
    await f.hold();
  });
  await expect(go()).rejects.toThrow('unfinished install recovery');
  const digit = selected.Id[0];
  expect(f.effects.filter((effect) => effect.endsWith(`:${digit}`))).toEqual([
    `start:${digit}`,
    `policy:${digit}`,
    `policy:${digit}`,
    `start:${digit}`,
  ]);
  expect(selected.HostConfig.RestartPolicy).toEqual(noRestart);
  expect((await f.journal.refresh()).decision).toBe(target === 'candidate' ? 'commit' : 'rollback');
});

it('inspects the target policy after checking the worker and before selecting a start', async () => {
  const f = await fixture();
  let workerInspections = 0;
  f.onInspect.mockImplementation(async (container) => {
    if (container.Id === f.worker.Id && ++workerInspections === 2) f.app.HostConfig.RestartPolicy = restart;
  });
  await f.runtime.resumeOriginal();
  expect(f.effects).toEqual(['policy:4', 'start:4', 'policy:4', 'start:1', 'policy:1']);
});

it('refuses a start if the disabled policy acknowledgement does not match the next inspection', async () => {
  const f = await fixture();
  f.app.HostConfig.RestartPolicy = restart;
  f.onPolicy.mockImplementation(async (container) => {
    container.HostConfig.RestartPolicy = restart;
  });
  await expect(f.runtime.resumeOriginal()).rejects.toMatchObject({ runtimeCheck: 'live-install-state' });
  expect(f.effects).toEqual(['policy:4']);
});

it('starts a verified committed candidate before restoring its controller policy', async () => {
  const f = await fixture({ phase: 'committing' });
  await f.runtime.activate();
  expect(f.effects).toEqual(['start:5', 'policy:5']);
  expect(f.health).toHaveBeenCalledOnce();
});

it('rechecks the live committed store after candidate health before restoring policy', async () => {
  const f = await fixture({ phase: 'committing' });
  f.health.mockImplementation(f.hold);
  await expect(f.runtime.activate()).rejects.toThrow('unfinished install recovery');
  expect(f.effects).toEqual(['start:5']);
  expect(f.candidate.HostConfig.RestartPolicy).toEqual(noRestart);
  expect((await f.journal.refresh()).decision).toBe('commit');
});

it('refuses controller startup and policy restoration on a held committed store', async () => {
  const f = await fixture({ phase: 'committing' });
  await f.hold();
  await expect(f.runtime.activate()).rejects.toThrow('unfinished install recovery');
  expect(f.effects).toEqual([]);
});

it.each(['late-receipt', 'retained-request', 'unverified-state', 'clear'] as const)('guards direct app dispatch (%s)', async (change) => {
  const f = await fixture({ phase: 'committing' });
  f.candidate.State.Running = true;
  const dispatch = vi.fn();
  if (change === 'late-receipt')
    f.onInspect.mockImplementation(async (container) => {
      if (container.Id === f.worker.Id) await f.hold();
    });
  if (change === 'retained-request') await files.writeFile(path.join(f.journal.directory, 'retained-root-request.json'), '{}', { mode: 0o600 });
  if (change === 'unverified-state') await files.rmdir(f.state);
  if (change === 'clear') {
    await f.runtime.candidateAppEffect(f.candidate.Id, appUrn, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
  } else {
    await expect(f.runtime.candidateAppEffect(f.candidate.Id, appUrn, dispatch)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  }
});
