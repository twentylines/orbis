import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { archiveBackedResetJournal, archiveResetJournalSchema, legacyResetJournalSchema, resetJournalSchema } from './reset-contract';
import { resetSafetyArchiveCommitmentSchema } from '../system-backups/reset-safety-commitment-contract';
import { prepareResetSafetyArchive, prepareResetSafetyArchiveFromInventory } from '../system-backups/reset-safety-preparation';
import { ResetState } from './reset-state';

const pending = () => {
  const id = randomUUID();
  return {
    version: 2,
    id,
    controller: 'synthetic-controller',
    accounts: 'remove',
    users: [7, 9],
    phase: 'prepared',
    createdAt: 1,
    safety: {
      format: 'orbis-reset-safety-commitment',
      version: 1,
      resetId: id,
      backupId: randomUUID(),
      accounts: 'remove',
      users: [7, 9],
      selectionSha256: 'a'.repeat(64),
      fullScopeSha256: 'b'.repeat(64),
      exportInventorySha256: 'c'.repeat(64),
      targetInventorySha256: 'd'.repeat(64),
      sha256: 'e'.repeat(64),
      bytes: 1024,
    },
  };
};

let root: string;
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-archive-journal-')));
  await fs.mkdir(path.join(root, 'state'), { mode: 0o700 });
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it('accepts the complete archive commitment only in the archive-backed journal version', () => {
  const value = pending();
  expect(resetJournalSchema.allows(value)).toBe(true);
  expect(resetJournalSchema.allows({ ...value, version: 1 })).toBe(false);
  const { safety: _safety, ...missing } = value;
  expect(resetJournalSchema.allows(missing)).toBe(false);
  expect(resetJournalSchema.allows({ ...missing, version: 1 })).toBe(true);
});

it('rejects a commitment for a different reset, account choice or user cohort', () => {
  const value = pending();
  for (const change of [{ resetId: randomUUID() }, { accounts: 'keep' }, { users: [7] }, { users: [7, 7] }, { users: [9, 7] }]) {
    expect(resetJournalSchema.allows({ ...value, safety: { ...value.safety, ...change } })).toBe(false);
  }
});

it('rejects private fields, unbounded values and malformed archive bindings', () => {
  const value = pending();
  for (const change of [
    { passphrase: 'synthetic-only' },
    { path: '/outside/archive' },
    { sha256: 'bad' },
    { bytes: 0 },
    { bytes: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(resetJournalSchema.allows({ ...value, safety: { ...value.safety, ...change } })).toBe(false);
  }
  expect(resetJournalSchema.allows({ ...value, users: [] })).toBe(false);
});

it('creates an immutable journal from matching prepared intent and a separate commitment snapshot', () => {
  const value = pending();
  const { safety, ...body } = value;
  const source = legacyResetJournalSchema.assert({ ...body, version: 1 });
  const commitment = resetSafetyArchiveCommitmentSchema.assert(safety);
  const result = archiveBackedResetJournal(source, commitment);
  const expected = structuredClone(value);
  source.users.reverse();
  commitment.users.reverse();
  commitment.sha256 = 'f'.repeat(64);
  expect(result).toEqual(expected);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.users)).toBe(true);
  expect(Object.isFrozen(result.safety)).toBe(true);
  expect(Object.isFrozen(result.safety.users)).toBe(true);
  expect(() => archiveBackedResetJournal({ ...source, phase: 'recovery' }, result.safety)).toThrow('fresh prepared intent');
});

it('keeps the maximum cohort inside the journal reader byte limit', () => {
  const value = pending();
  value.users = Array.from({ length: 256 }, (_, index) => Number.MAX_SAFE_INTEGER - 255 + index);
  value.safety.users = [...value.users];
  value.controller = 'x'.repeat(253);
  expect(resetJournalSchema.allows(value)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(value)) + 1).toBeLessThan(16384);
});

it.each([prepareResetSafetyArchive, prepareResetSafetyArchiveFromInventory])(
  'rejects recapturing an archive-backed journal before requesting source or inventory access',
  async (prepare) => {
    const journal = archiveResetJournalSchema.assert(pending());
    await expect(prepare({ journal } as never)).rejects.toThrow('already has a recovery archive');
  },
);

it.each(['legacy', 'dedicated'])('roundtrips the commitment through %s storage and a new process facade', async (layout) => {
  const authority = path.join(root, 'orbis-reset');
  if (layout === 'dedicated') await fs.mkdir(authority, { mode: 0o700 });
  const options = {
    readMounts: async () =>
      `36 35 98:0 /application-data ${root} rw - ext4 /dev/sda1 rw\n` +
      (layout === 'dedicated' ? `37 35 98:0 /protected-reset ${authority} rw - ext4 /dev/sda1 rw\n` : ''),
    descriptorRoot: (_fd: number, directory: string) => directory,
  };
  const value = archiveResetJournalSchema.assert(pending());
  const initial = new ResetState(root, options);
  const release = await initial.acquireLease();
  await initial.save(value);
  await release();
  expect(await new ResetState(root, options).read()).toEqual(value);
  const stored = path.join(layout === 'dedicated' ? authority : path.join(root, 'state/orbis-reset'), 'active.json');
  expect((await fs.stat(stored)).mode & 0o777).toBe(0o600);
  expect((await fs.readFile(stored)).length).toBeLessThan(16384);
  const target = path.join(root, 'state/desktop/7.json');
  await fs.mkdir(path.dirname(target), { mode: 0o700 });
  await fs.writeFile(target, 'original preference', { mode: 0o600 });
  await expect(new ResetState(root, options).erasePreferences(value)).rejects.toThrow('archive');
  expect(await fs.readFile(target, 'utf8')).toBe('original preference');
  expect(await new ResetState(root, options).read()).toEqual(value);
  const state = new ResetState(root, options);
  const { safety, ...intent } = value;
  for (const replacement of [
    { ...intent, version: 1 },
    { ...value, safety: { ...safety, backupId: randomUUID() } },
    { ...value, safety: { ...safety, sha256: 'f'.repeat(64) } },
    { ...value, createdAt: 2 },
  ]) {
    await expect(state.save(resetJournalSchema.assert(replacement))).rejects.toThrow('binding must be preserved');
    expect(await state.read()).toEqual(value);
  }
  await state.save({ ...value, phase: 'recovery' });
  expect(await new ResetState(root, options).read()).toEqual({ ...value, phase: 'recovery' });
});
