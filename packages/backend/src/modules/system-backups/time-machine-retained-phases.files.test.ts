import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRestoreJournal } from './backup-restore-journal';
import { runRetainedRestorePhase, type RetainedPhase, type RetainedPhaseAuthority, type RetainedPhaseRuntime } from './time-machine-retained-phases';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-phases-')));
  roots.push(root);
  const store = path.join(root, 'store');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  const data = path.join(root, 'data');
  await fs.mkdir(data, { mode: 0o700 });
  await fs.writeFile(path.join(data, 'value'), 'old');
  const swap = await BackupDirectorySwap.create({ id: journal.state.id, root: data, journal: journal.rootJournal('state') });
  await fs.writeFile(path.join(swap.incomingDirectory, 'value'), 'historical');
  await swap.seal(new AbortController().signal);
  await journal.advance('prepared');
  const runtime: RetainedPhaseRuntime = {
    prepare: vi.fn(),
    discardPreparation: vi.fn(),
    stopWriters: vi.fn(),
    installDatabasePointer: vi.fn(),
    verifyCandidate: vi.fn(),
    restoreDatabasePointer: vi.fn(),
    resumeOriginal: vi.fn(),
    confirmRootActivation: vi.fn(),
  };
  const run = (
    phase: RetainedPhase,
    decision: RetainedPhaseAuthority['decision'],
    commitStage: RetainedPhaseAuthority['commitStage'] = null,
    overrides: Partial<RetainedPhaseAuthority> = {},
  ) =>
    runRetainedRestorePhase({
      journal,
      phase,
      runtime,
      signal: new AbortController().signal,
      authority: {
        restoreId: journal.state.id,
        nonce: journal.state.nonce,
        phase,
        decision,
        commitStage,
        verify: async () => undefined,
        ...overrides,
      },
    });
  return { journal, runtime, data, run };
}
it('requires the root decision and separates commit authorization from post-activation cleanup', async () => {
  const test = await fixture();
  await expect(test.run('promote', 'commit')).rejects.toThrow();
  await expect(test.run('promote', 'none', null, { nonce: randomUUID() })).rejects.toThrow();
  await expect(test.run('promote', 'none')).resolves.toBe('promoted');
  await expect(test.run('promote', 'none')).resolves.toBe('promoted');
  await expect(test.run('verify', 'none')).resolves.toBe('verified');
  await expect(test.run('commit', 'commit', 'finish')).rejects.toThrow();
  await expect(test.run('commit', 'commit', 'authorize')).resolves.toBe('authorized');
  expect((await test.journal.refresh()).phase).toBe('committing');
  expect(await fs.readFile(path.join(test.data, 'value'), 'utf8')).toBe('historical');
  await fs.rm(path.join(test.data, 'value'));
  await fs.writeFile(path.join(test.data, 'new-write'), 'new server write');
  await expect(test.run('rollback', 'rollback')).rejects.toThrow();
  await expect(test.run('commit', 'commit', 'finish')).resolves.toBe('completed');
  await expect(test.run('commit', 'commit', 'finish')).resolves.toBe('completed');
  expect(await fs.readFile(path.join(test.data, 'new-write'), 'utf8')).toBe('new server write');
  expect(await fs.readdir(test.data)).not.toContain('value');
});
it('rolls back only after root grants rollback and never retries an interrupted promotion', async () => {
  const test = await fixture();
  await test.journal.advance('quiescing');
  await test.journal.advance('promoting');
  await expect(test.run('promote', 'none')).rejects.toThrow();
  await expect(test.run('rollback', 'none')).rejects.toThrow();
  await expect(test.run('rollback', 'rollback')).resolves.toBe('rolled-back');
  expect(await fs.readFile(path.join(test.data, 'value'), 'utf8')).toBe('old');
  await expect(test.run('rollback', 'rollback')).resolves.toBe('rolled-back');
});
it('leaves commit pending if root activation cannot be confirmed and never rolls back after root commit', async () => {
  const test = await fixture();
  await test.run('promote', 'none');
  await test.run('verify', 'none');
  await test.run('commit', 'commit', 'authorize');
  vi.mocked(test.runtime.confirmRootActivation).mockRejectedValueOnce(new Error('unhealthy candidate'));
  await expect(test.run('commit', 'commit', 'finish')).rejects.toThrow();
  expect((await test.journal.refresh()).phase).toBe('committing');
  await expect(test.run('rollback', 'rollback')).rejects.toThrow();
  await expect(test.run('commit', 'commit', 'finish')).resolves.toBe('completed');
});

it.each(['rollback', 'commit'] as const)('leaves the live proxy tree untouched through six-root %s', async (outcome) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retained-live-proxy-')));
  roots.push(root);
  const names = ['state', 'apps', 'repos', 'media', 'user-config', 'app-data'];
  const journal = await BackupRestoreJournal.create(path.join(root, 'store'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: names,
  });
  const liveProxy = path.join(root, 'traefik');
  await fs.mkdir(liveProxy, { mode: 0o700 });
  await fs.writeFile(path.join(liveProxy, 'live.yml'), 'unchanged');
  for (const name of names) {
    const target = path.join(root, name);
    await fs.mkdir(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, 'value'), 'old');
    const swap = await BackupDirectorySwap.create({ id: journal.state.id, root: target, journal: journal.rootJournal(name) });
    await fs.writeFile(path.join(swap.incomingDirectory, 'value'), 'historical');
    await swap.seal(new AbortController().signal);
  }
  await journal.advance('prepared');
  const runtime: RetainedPhaseRuntime = {
    prepare: vi.fn(),
    discardPreparation: vi.fn(),
    stopWriters: vi.fn(),
    installDatabasePointer: vi.fn(),
    verifyCandidate: vi.fn(),
    restoreDatabasePointer: vi.fn(),
    resumeOriginal: vi.fn(),
    confirmRootActivation: vi.fn(),
  };
  const run = (phase: RetainedPhase, decision: RetainedPhaseAuthority['decision'], commitStage: RetainedPhaseAuthority['commitStage'] = null) =>
    runRetainedRestorePhase({
      journal,
      phase,
      runtime,
      signal: new AbortController().signal,
      authority: { restoreId: journal.state.id, nonce: journal.state.nonce, phase, decision, commitStage, verify: async () => undefined },
    });
  await run('promote', 'none');
  if (outcome === 'rollback') await run('rollback', 'rollback');
  else {
    await run('verify', 'none');
    await run('commit', 'commit', 'authorize');
    await run('commit', 'commit', 'finish');
  }
  expect(await fs.readdir(liveProxy)).toEqual(['live.yml']);
  expect(await fs.readFile(path.join(liveProxy, 'live.yml'), 'utf8')).toBe('unchanged');
  expect(await fs.readdir(path.join(journal.directory, 'roots'))).not.toContain('traefik');
});
