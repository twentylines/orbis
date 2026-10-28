import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireRestoreLease, withRestoreLease } from './backup-restore-lease';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRestoreJournal, restoreControllerRetired, restoreStartupAllowed } from './backup-restore-journal';
import { RestoreRolledBackError, runRestoreTransaction, type RestoreRuntime } from './backup-restore-coordinator';
import { waitForRestoreStartup } from './backup-restore-startup';
import { inventoryBackup } from './backup-files';

let directory: string;
const signal = () => new AbortController().signal;
const originalController = '1'.repeat(64);
const candidateController = '2'.repeat(64);
const worker = '3'.repeat(64);
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-coordinator-')));
  await fs.chmod(directory, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(controller = candidateController) {
  const data = path.join(directory, 'data');
  const store = path.join(data, 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController: controller,
    worker,
    roots: ['state', 'app-data'],
  });
  const roots: BackupDirectorySwap[] = [];
  for (const name of journal.state.roots) {
    const root = path.join(directory, name);
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, 'value'), `original ${name}`, { mode: 0o600 });
    const swap = await BackupDirectorySwap.create({ id: journal.state.id, root, journal: journal.rootJournal(name) });
    await fs.writeFile(path.join(swap.incomingDirectory, 'value'), `restored ${name}`, { mode: 0o600 });
    await swap.seal(signal());
    roots.push(swap);
  }
  await journal.advance('prepared');
  const pointer = path.join(directory, 'connection');
  await fs.writeFile(pointer, 'original', { mode: 0o600 });
  const events: string[] = [];
  let running = true;
  const runtime: RestoreRuntime = {
    stopWriters: async (current) => {
      current.throwIfAborted();
      running = false;
      events.push('stop');
    },
    installDatabasePointer: async () => {
      expect(running).toBe(false);
      await fs.writeFile(pointer, 'restored');
      events.push('pointer');
    },
    verify: async () => {
      expect(running).toBe(false);
      for (const name of journal.state.roots) expect(await fs.readFile(path.join(directory, name, 'value'), 'utf8')).toBe(`restored ${name}`);
      expect(await fs.readFile(pointer, 'utf8')).toBe('restored');
      events.push('verify');
    },
    activate: async () => {
      expect((await journal.refresh()).decision).toBe('commit');
      running = true;
      events.push('activate');
    },
    restoreDatabasePointer: async () => {
      expect(running).toBe(false);
      await fs.writeFile(pointer, 'original');
      events.push('old-pointer');
    },
    resumeOriginal: async () => {
      expect((await journal.refresh()).phase).toBe('rolled-back');
      for (const name of journal.state.roots) expect(await fs.readFile(path.join(directory, name, 'value'), 'utf8')).toBe(`original ${name}`);
      running = true;
      events.push('resume');
    },
  };
  return { data, store, journal, roots, pointer, events, runtime };
}
async function reopen(test: Awaited<ReturnType<typeof fixture>>) {
  const journal = await BackupRestoreJournal.active(test.store);
  expect(journal).toBeDefined();
  return journal as BackupRestoreJournal;
}

it('commits one global decision before either root becomes irreversible and activates after both', async () => {
  const test = await fixture();
  const commit = BackupDirectorySwap.prototype.commit;
  const decisions: (string | null)[] = [];
  vi.spyOn(BackupDirectorySwap.prototype, 'commit').mockImplementation(async function (this: BackupDirectorySwap) {
    decisions.push((await test.journal.refresh()).decision);
    return commit.call(this);
  });
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).resolves.toBe('completed');
  expect(decisions).toEqual(['commit', 'commit']);
  expect(test.events).toEqual(['stop', 'pointer', 'verify', 'activate']);
  expect((await reopen(test)).state.phase).toBe('completed');
  await expect(runRestoreTransaction(await reopen(test), test.runtime, signal())).resolves.toBe('completed');
  expect(test.events.filter((event) => event === 'activate')).toHaveLength(1);
});

for (const failure of ['stopWriters', 'installDatabasePointer', 'verify'] as const) {
  it(`restores both roots and the original connection after ${failure} fails`, async () => {
    const test = await fixture();
    const actual = test.runtime[failure];
    let once = true;
    test.runtime[failure] = async (current) => {
      if (once) {
        once = false;
        throw new Error('declared operation failure');
      }
      return actual(current);
    };
    const error = await runRestoreTransaction(test.journal, test.runtime, signal()).then(
      () => undefined,
      (reason) => reason,
    );
    expect(error).toBeInstanceOf(RestoreRolledBackError);
    expect(error).toMatchObject({ cancelled: false, cause: expect.objectContaining({ message: 'declared operation failure' }) });
    expect((await reopen(test)).state.phase).toBe('rolled-back');
    expect(await fs.readFile(test.pointer, 'utf8')).toBe('original');
    expect(test.events.at(-1)).toBe('resume');
  });
}
it('rolls back a failure between promoting the two roots', async () => {
  const test = await fixture();
  const promote = BackupDirectorySwap.prototype.promote;
  let count = 0;
  vi.spyOn(BackupDirectorySwap.prototype, 'promote').mockImplementation(async function (this: BackupDirectorySwap, current) {
    if (++count === 2) throw new Error('second root failure');
    return promote.call(this, current);
  });
  const error = await runRestoreTransaction(test.journal, test.runtime, signal()).then(
    () => undefined,
    (reason) => reason,
  );
  expect(error).toBeInstanceOf(RestoreRolledBackError);
  expect(error).toMatchObject({ cancelled: false, cause: expect.objectContaining({ message: 'second root failure' }) });
  expect((await reopen(test)).state.phase).toBe('rolled-back');
  expect(test.events.at(-1)).toBe('resume');
});
it('cancellation uses a fresh recovery signal and resumes the original', async () => {
  const test = await fixture();
  const abort = new AbortController();
  const verify = test.runtime.verify;
  test.runtime.verify = async (current) => {
    await verify(current);
    abort.abort();
  };
  const error = await runRestoreTransaction(test.journal, test.runtime, abort.signal).then(
    () => undefined,
    (reason) => reason,
  );
  expect(error).toBeInstanceOf(RestoreRolledBackError);
  expect(error).toMatchObject({ cancelled: true, cause: expect.anything() });
  expect(test.events.filter((event) => event === 'stop')).toHaveLength(2);
  expect((await reopen(test)).state.phase).toBe('rolled-back');
});
it('does not report settled rollback when resuming the original controller fails', async () => {
  const test = await fixture();
  test.runtime.verify = async () => {
    throw new Error('verification failed');
  };
  test.runtime.resumeOriginal = async () => {
    expect((await test.journal.refresh()).phase).toBe('rolled-back');
    throw new Error('original controller is not healthy');
  };

  const error = await runRestoreTransaction(test.journal, test.runtime, signal()).then(
    () => undefined,
    (reason) => reason,
  );

  expect(error).not.toBeInstanceOf(RestoreRolledBackError);
  expect(error).toMatchObject({ message: expect.stringContaining('recovery is incomplete') });
  expect((await reopen(test)).state.phase).toBe('rolled-back');
});
for (const stage of ['quiescing', 'promoting', 'verifying', 'rolling-back'] as const) {
  it(`a new coordinator recovers an interrupted ${stage} operation instead of guessing forward`, async () => {
    const test = await fixture();
    await test.journal.advance('quiescing');
    await test.runtime.stopWriters(signal());
    if (stage !== 'quiescing') {
      await test.journal.advance('promoting');
      const first = test.roots[0];
      if (!first) throw new Error('Missing fixture root');
      await first.promote(signal());
      if (stage === 'verifying') {
        const second = test.roots[1];
        if (!second) throw new Error('Missing fixture root');
        await second.promote(signal());
        await test.runtime.installDatabasePointer(signal());
        await test.journal.advance('verifying');
      } else if (stage === 'rolling-back') await test.journal.advance('rolling-back');
    }
    await expect(runRestoreTransaction(await reopen(test), test.runtime, signal())).resolves.toBe('rolled-back');
    expect(test.events.at(-1)).toBe('resume');
    expect(test.events).not.toContain('activate');
  });
}
it('leaves data stopped if recovery cannot stop writers', async () => {
  const test = await fixture();
  test.runtime.stopWriters = async () => {
    throw new Error('cannot stop writers');
  };
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).rejects.toThrow('recovery is incomplete');
  expect((await reopen(test)).state.phase).toBe('rolling-back');
  expect(test.events).not.toContain('old-pointer');
  expect(test.events).not.toContain('resume');
});
it('retries forward after the global commit even if the second per-root commit failed', async () => {
  const test = await fixture();
  const commit = BackupDirectorySwap.prototype.commit;
  let count = 0;
  const spy = vi.spyOn(BackupDirectorySwap.prototype, 'commit').mockImplementation(async function (this: BackupDirectorySwap) {
    if (++count === 2) throw new Error('second commit interrupted');
    return commit.call(this);
  });
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).rejects.toThrow('second commit interrupted');
  expect((await reopen(test)).state.decision).toBe('commit');
  expect(test.events).not.toContain('resume');
  spy.mockRestore();
  await expect(runRestoreTransaction(await reopen(test), test.runtime, signal())).resolves.toBe('completed');
  expect(test.events.at(-1)).toBe('activate');
});
it('does not roll back a globally published commit whose directory fsync reported failure', async () => {
  const test = await fixture();
  const advance = test.journal.advance.bind(test.journal);
  vi.spyOn(test.journal, 'advance').mockImplementation(async (phase) => {
    await advance(phase);
    if (phase === 'committing') throw new Error('published commit, failed sync');
  });
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).rejects.toThrow('recovery is incomplete');
  expect((await reopen(test)).state.decision).toBe('commit');
  expect(test.events).not.toContain('old-pointer');
  await expect(runRestoreTransaction(await reopen(test), test.runtime, signal())).resolves.toBe('completed');
});
it('retries activation without reversing committed data', async () => {
  const test = await fixture();
  const activate = test.runtime.activate;
  test.runtime.activate = async () => {
    throw new Error('controller not ready');
  };
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).rejects.toThrow('controller not ready');
  test.runtime.activate = activate;
  await expect(runRestoreTransaction(await reopen(test), test.runtime, signal())).resolves.toBe('completed');
  expect(test.events).not.toContain('resume');
});
it('rejects a concurrent invocation and never stops its writers', async () => {
  const test = await fixture();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = test.runtime.stopWriters;
  test.runtime.stopWriters = async (current) => {
    entered();
    await blocked;
    await stop(current);
  };
  const first = runRestoreTransaction(test.journal, test.runtime, signal());
  await ready;
  const other = { ...test.runtime, stopWriters: vi.fn(test.runtime.stopWriters) };
  try {
    await expect(runRestoreTransaction(await reopen(test), other, signal())).rejects.toThrow('recovery is incomplete');
    expect(other.stopWriters).not.toHaveBeenCalled();
  } finally {
    release();
    await first;
  }
});
it('does not replace an already active restore claim', async () => {
  const test = await fixture();
  await expect(
    BackupRestoreJournal.create(test.store, {
      id: randomUUID(),
      nonce: randomUUID(),
      originalController,
      candidateController,
      worker,
      roots: ['state'],
    }),
  ).rejects.toThrow('journal needs recovery');
  expect((await reopen(test)).state.id).toBe(test.journal.state.id);
});
it('rejects illegal phase reversal and mutated immutable controller identity', async () => {
  const test = await fixture();
  await expect(test.journal.advance('completed')).rejects.toThrow('journal needs recovery');
  const file = path.join(test.journal.directory, 'restore.json');
  await fs.writeFile(file, JSON.stringify({ ...test.journal.state, worker: '4'.repeat(64) }));
  await expect(test.journal.refresh()).rejects.toThrow('journal needs recovery');
});
for (const corrupt of ['permissions', 'symlink', 'nonce', 'phase'] as const) {
  it(`fails closed on ${corrupt} journal corruption`, async () => {
    const test = await fixture();
    const file = path.join(test.journal.directory, 'restore.json');
    if (corrupt === 'permissions') await fs.chmod(file, 0o644);
    else if (corrupt === 'symlink') {
      await fs.rename(file, `${file}.original`);
      await fs.symlink(`${file}.original`, file);
    } else
      await fs.writeFile(
        file,
        JSON.stringify({ ...test.journal.state, [corrupt === 'nonce' ? 'nonce' : 'phase']: corrupt === 'nonce' ? randomUUID() : 'completed' }),
      );
    await expect(BackupRestoreJournal.active(test.store)).rejects.toThrow('journal needs recovery');
  });
}
it('blocks startup before any data directories are generated, with one notice and abortable waiting', async () => {
  const test = await fixture();
  const abort = new AbortController();
  const notice = vi.fn(() => abort.abort());
  await expect(
    waitForRestoreStartup({ dataDirectory: test.data, controller: originalController.slice(0, 12), signal: abort.signal, onHeld: notice }),
  ).rejects.toThrow();
  expect(notice).toHaveBeenCalledTimes(1);
  await expect(fs.lstat(path.join(test.data, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('a server with no restore journal starts without creating backup storage', async () => {
  const dataDirectory = path.join(directory, 'untouched-data');
  await waitForRestoreStartup({ dataDirectory, controller: 'ordinary-host', onHeld: vi.fn() });
  await expect(fs.lstat(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('only the committed candidate or rolled-back original passes the startup gate', async () => {
  const test = await fixture();
  const state = test.journal.state;
  for (const id of [originalController, candidateController, worker]) expect(restoreStartupAllowed(state, id.slice(0, 12))).toBe(false);
  const committed = { ...state, phase: 'committing' as const, decision: 'commit' as const };
  expect(restoreStartupAllowed(committed, candidateController.slice(0, 12))).toBe(true);
  expect(restoreStartupAllowed(committed, originalController.slice(0, 12))).toBe(false);
  expect(restoreStartupAllowed(committed, '2')).toBe(false);
  expect(restoreStartupAllowed(committed, `${'2'.repeat(63)}1`)).toBe(false);
  const rollback = { ...state, phase: 'rolled-back' as const, decision: 'rollback' as const };
  expect(restoreStartupAllowed(rollback, originalController.slice(0, 12))).toBe(true);
  expect(restoreStartupAllowed(rollback, candidateController.slice(0, 12))).toBe(false);
});
it('allows only the recorded verifier in matching held mode before committing', async () => {
  const test = await fixture();
  const state = { ...test.journal.state, verifierController: '4'.repeat(64), phase: 'verifying' as const };
  expect(restoreStartupAllowed(state, '4'.repeat(12), { phase: 'hold', transactionId: state.id })).toBe(true);
  expect(restoreStartupAllowed(state, '4'.repeat(12), { phase: 'resume', transactionId: state.id })).toBe(false);
  expect(restoreStartupAllowed(state, '4'.repeat(12), { phase: 'hold', transactionId: randomUUID() })).toBe(false);
  expect(restoreStartupAllowed(state, candidateController.slice(0, 12), { phase: 'hold', transactionId: state.id })).toBe(false);
  expect(restoreStartupAllowed(state, '4'.repeat(12))).toBe(false);
});
it('rejects a swap journal belonging to another transaction before stopping anything', async () => {
  const test = await fixture();
  const file = path.join(test.journal.rootJournal('state'), 'swap.json');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...value, id: randomUUID() }));
  await expect(runRestoreTransaction(test.journal, test.runtime, signal())).rejects.toThrow('journal needs recovery');
  expect(test.events).toEqual([]);
});

it('a later successful restore can claim the journal while retired controllers stay blocked', async () => {
  const test = await fixture();
  await runRestoreTransaction(test.journal, test.runtime, signal());
  const next = await BackupRestoreJournal.create(test.store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: candidateController,
    candidateController: '4'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  expect((await BackupRestoreJournal.active(test.store))?.state.id).toBe(next.state.id);
  expect(await restoreControllerRetired(test.store, originalController.slice(0, 12))).toBe(true);
  expect(await restoreControllerRetired(test.store, candidateController.slice(0, 12))).toBe(false);
  expect(restoreStartupAllowed(next.state, candidateController.slice(0, 12))).toBe(true);
  expect(await fs.readFile(path.join(test.journal.directory, 'restore.json'), 'utf8')).toContain('completed');
  const nextSwap = await BackupDirectorySwap.create({ id: next.state.id, root: path.join(directory, 'state'), journal: next.rootJournal('state') });
  await fs.writeFile(path.join(nextSwap.incomingDirectory, 'value'), 'next generation', { mode: 0o600 });
  await nextSwap.seal(signal());
  await next.advance('prepared');
  const abort = new AbortController();
  await expect(
    waitForRestoreStartup({
      dataDirectory: test.data,
      controller: originalController.slice(0, 12),
      signal: abort.signal,
      onHeld: () => abort.abort(),
    }),
  ).rejects.toThrow();
});

it('restarts the same controller after commit and keeps it eligible for subsequent restores', async () => {
  const test = await fixture(originalController);
  expect(restoreStartupAllowed(test.journal.state, originalController.slice(0, 12))).toBe(false);
  await runRestoreTransaction(test.journal, test.runtime, signal());
  expect(restoreStartupAllowed(test.journal.state, originalController.slice(0, 12))).toBe(true);
  const next = await BackupRestoreJournal.create(test.store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController: originalController,
    verifierController: '6'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  expect(await restoreControllerRetired(test.store, originalController)).toBe(false);
  expect(restoreStartupAllowed(next.state, originalController.slice(0, 12))).toBe(true);
});
it('a rolled-back transaction permits another preparation from its original controller', async () => {
  const test = await fixture();
  test.runtime.verify = async () => {
    throw new Error('verify failed');
  };
  const error = await runRestoreTransaction(test.journal, test.runtime, signal()).then(
    () => undefined,
    (reason) => reason,
  );
  expect(error).toBeInstanceOf(RestoreRolledBackError);
  expect(error).toMatchObject({ cancelled: false, cause: expect.objectContaining({ message: 'verify failed' }) });
  const next = await BackupRestoreJournal.create(test.store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController: '4'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  expect(next.state.phase).toBe('staging');
  expect(await restoreControllerRetired(test.store, candidateController)).toBe(true);
});
it('does not adopt a terminal restore from an unrelated controller', async () => {
  const test = await fixture();
  await runRestoreTransaction(test.journal, test.runtime, signal());
  await expect(
    BackupRestoreJournal.create(test.store, {
      id: randomUUID(),
      nonce: randomUUID(),
      originalController: '6'.repeat(64),
      candidateController: '4'.repeat(64),
      worker: '5'.repeat(64),
      roots: ['state'],
    }),
  ).rejects.toThrow('journal needs recovery');
  expect((await reopen(test)).state.phase).toBe('completed');
});
it('rejects a reused generation ID before deleting any retained rollback files', async () => {
  const test = await fixture();
  await runRestoreTransaction(test.journal, test.runtime, signal());
  const previous = path.join(directory, 'state', `.orbis-restore-${test.journal.state.id}.previous`, 'value');
  expect(await fs.readFile(previous, 'utf8')).toBe('original state');
  await expect(
    BackupRestoreJournal.create(test.store, {
      id: test.journal.state.id,
      nonce: randomUUID(),
      originalController: candidateController,
      candidateController: '4'.repeat(64),
      worker: '5'.repeat(64),
      roots: ['state'],
    }),
  ).rejects.toThrow('journal needs recovery');
  expect(await fs.readFile(previous, 'utf8')).toBe('original state');
  expect((await reopen(test)).state.phase).toBe('completed');
});
it('keeps the original controller available during incomplete inert preparation', async () => {
  const store = path.join(directory, 'data', 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController,
    worker,
    roots: ['state'],
  });
  expect(journal.state.phase).toBe('staging');
  expect(restoreStartupAllowed(journal.state, originalController.slice(0, 12))).toBe(true);
  await waitForRestoreStartup({
    dataDirectory: path.join(directory, 'data'),
    controller: originalController,
    onHeld: () => {
      throw new Error('Should not hold');
    },
  });
  await expect(journal.advance('prepared')).rejects.toThrow();
});
it('shares an exclusive lease with another process and releases it after that process is killed', async () => {
  const store = path.join(directory, 'lease');
  await withRestoreLease(store, async () => undefined);
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked');
    setInterval(() => {}, 1000);
  `,
      path.join(store, 'lease.sqlite'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    const [data] = await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error('Lease fixture exited before locking');
      }),
    ]);
    expect(String(data)).toBe('locked');
    const mutation = vi.fn();
    await expect(withRestoreLease(store, mutation)).rejects.toThrow('database is locked');
    expect(mutation).not.toHaveBeenCalled();
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  await expect(withRestoreLease(store, async () => 'recovered')).resolves.toBe('recovered');
});
it('keeps an acquired lease exclusive until idempotent release', async () => {
  const store = path.join(directory, 'acquired-lease');
  const release = await acquireRestoreLease(store);

  await expect(acquireRestoreLease(store)).rejects.toThrow('database is locked');
  release();
  release();

  const releaseAgain = await acquireRestoreLease(store);
  releaseAgain();
  releaseAgain();
  const finalRelease = await acquireRestoreLease(store);
  finalRelease();
});
it('exposes backup exclusions only for terminal plans bound to the exact roots and transaction', async () => {
  const test = await fixture();
  const expectedRoots = {
    state: path.join(directory, 'state'),
    'app-data': path.join(directory, 'app-data'),
  };
  await expect(withRestoreLease(test.store, () => test.journal.backupExclusions(expectedRoots))).rejects.toThrow('Finish or discard');

  await runRestoreTransaction(test.journal, test.runtime, signal());
  const exclusions = await withRestoreLease(test.store, () => test.journal.backupExclusions(expectedRoots));
  expect(exclusions.sort()).toEqual(
    [
      path.join(expectedRoots.state, `.orbis-restore-${test.journal.state.id}.incoming`),
      path.join(expectedRoots.state, `.orbis-restore-${test.journal.state.id}.previous`),
      path.join(expectedRoots['app-data'], `.orbis-restore-${test.journal.state.id}.incoming`),
      path.join(expectedRoots['app-data'], `.orbis-restore-${test.journal.state.id}.previous`),
    ].sort(),
  );
  await expect(
    withRestoreLease(test.store, () => test.journal.backupExclusions({ ...expectedRoots, state: path.join(directory, 'wrong-root') })),
  ).rejects.toThrow();
  await expect(withRestoreLease(test.store, () => test.journal.backupExclusions({ state: expectedRoots.state }))).rejects.toThrow();

  const planFile = path.join(test.journal.rootJournal('state'), 'swap.json');
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8')) as { id: string };
  await fs.writeFile(planFile, JSON.stringify({ ...plan, id: randomUUID() }), { mode: 0o600 });
  await expect(withRestoreLease(test.store, () => test.journal.backupExclusions(expectedRoots))).rejects.toThrow();
});

it('keeps current data in a full inventory and allows another restore generation afterward', async () => {
  const test = await fixture();
  await runRestoreTransaction(test.journal, test.runtime, signal());
  const firstRoots = {
    state: path.join(directory, 'state'),
    'app-data': path.join(directory, 'app-data'),
  };
  const { firstExclusions, inventory } = await withRestoreLease(test.store, async () => {
    const exclusions = await test.journal.backupExclusions(firstRoots);
    const sourceInventory = await inventoryBackup(
      [
        { name: 'state', source: firstRoots.state, required: true },
        { name: 'app-data', source: firstRoots['app-data'], required: true },
      ],
      signal(),
      exclusions,
    );
    return { firstExclusions: exclusions, inventory: sourceInventory };
  });
  expect(inventory.files.map((file) => file.name).sort()).toEqual(['app-data/value', 'state/value']);
  expect(await fs.readFile(path.join(firstRoots.state, 'value'), 'utf8')).toBe('restored state');
  expect(await fs.readFile(path.join(firstRoots['app-data'], 'value'), 'utf8')).toBe('restored app-data');
  for (const excluded of firstExclusions) await expect(fs.stat(excluded)).resolves.toBeDefined();

  const next = await BackupRestoreJournal.create(test.store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: candidateController,
    candidateController: '4'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  const nextSwap = await BackupDirectorySwap.create({ id: next.state.id, root: firstRoots.state, journal: next.rootJournal('state') });
  await fs.writeFile(path.join(nextSwap.incomingDirectory, 'value'), 'next restored state', { mode: 0o600 });
  await nextSwap.seal(signal());
  await next.advance('prepared');
  const nextRuntime: RestoreRuntime = {
    stopWriters: async () => undefined,
    installDatabasePointer: async () => undefined,
    verify: async () => expect(await fs.readFile(path.join(firstRoots.state, 'value'), 'utf8')).toBe('next restored state'),
    activate: async () => undefined,
    restoreDatabasePointer: async () => undefined,
    resumeOriginal: async () => undefined,
  };
  await expect(runRestoreTransaction(next, nextRuntime, signal())).resolves.toBe('completed');
  await expect(withRestoreLease(test.store, () => next.backupExclusions({ state: firstRoots.state }))).resolves.toHaveLength(2);
  expect(await fs.readFile(path.join(firstRoots.state, 'value'), 'utf8')).toBe('next restored state');
});

it('does not follow a symlink used as the lease database', async () => {
  const store = path.join(directory, 'lease');
  await fs.mkdir(store, { mode: 0o700 });
  const untouched = path.join(directory, 'untouched');
  await fs.writeFile(untouched, 'original', { mode: 0o600 });
  await fs.symlink(untouched, path.join(store, 'lease.sqlite'));
  await expect(withRestoreLease(store, async () => undefined)).rejects.toThrow('storage needs review');
  expect(await fs.readFile(untouched, 'utf8')).toBe('original');
});
it('discards interrupted inert staging without touching live files or root attributes', async () => {
  const store = path.join(directory, 'data', 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController,
    worker,
    roots: ['state', 'missing-plan'],
  });
  const root = path.join(directory, 'state');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'live'), 'unchanged', { mode: 0o600 });
  const swap = await BackupDirectorySwap.create({ id: journal.state.id, root, journal: journal.rootJournal('state') });
  await fs.writeFile(path.join(swap.incomingDirectory, 'staged'), 'unused incoming', { mode: 0o600 });
  await swap.seal(signal());
  await fs.chmod(root, 0o750);
  await fs.writeFile(path.join(root, 'new-live-file'), 'written during preparation');
  await journal.discardStaging();
  await journal.discardStaging();
  expect(journal.state.phase).toBe('discarded');
  expect((await fs.stat(root)).mode & 0o777).toBe(0o750);
  expect((await fs.readdir(root)).sort()).toEqual(['live', 'new-live-file']);
  expect(await fs.readFile(path.join(root, 'live'), 'utf8')).toBe('unchanged');
  const next = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController,
    candidateController: '4'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  await expect(BackupDirectorySwap.create({ id: next.state.id, root, journal: next.rootJournal('state') })).resolves.toBeDefined();
});
it('recovers a create call that published its staging pointer before reporting an I/O failure', async () => {
  const store = path.join(directory, 'data', 'backups', 'restores');
  const link = fs.link.bind(fs);
  const spy = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
    await link(from, to);
    if (String(to) === path.join(store, 'active.json')) throw new Error('published pointer, failed sync');
  });
  await expect(
    BackupRestoreJournal.create(store, {
      id: randomUUID(),
      nonce: randomUUID(),
      originalController,
      candidateController,
      worker,
      roots: ['state'],
    }),
  ).rejects.toThrow('published pointer');
  spy.mockRestore();
  const active = await BackupRestoreJournal.active(store);
  if (!active) throw new Error('Published fixture disappeared');
  await active.discardStaging();
  expect(active.state.phase).toBe('discarded');
  await expect(
    BackupRestoreJournal.create(store, {
      id: randomUUID(),
      nonce: randomUUID(),
      originalController,
      candidateController: '4'.repeat(64),
      worker: '5'.repeat(64),
      roots: ['state'],
    }),
  ).resolves.toBeDefined();
});
it('never discards prepared or already promoted work as inert staging', async () => {
  const test = await fixture();
  await expect(test.journal.discardStaging()).rejects.toThrow('journal needs recovery');
  await test.journal.advance('quiescing');
  await test.runtime.stopWriters(signal());
  await test.journal.advance('promoting');
  const root = test.roots[0];
  if (!root) throw new Error('Missing fixture root');
  await root.promote(signal());
  await expect(root.discardPrepared()).rejects.toThrow('restore files need recovery');
  await expect(root.cleanup()).rejects.toThrow('restore files need recovery');
  expect(await fs.readFile(path.join(directory, 'state', 'value'), 'utf8')).toBe('restored state');
  await runRestoreTransaction(await reopen(test), test.runtime, signal());
});
