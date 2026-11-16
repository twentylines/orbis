import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import type { ResetJournal } from '../system-reset/reset-contract';
import { ResetBackupCustody, type CustodyBackupJob } from './reset-backup-custody';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let directory: string;
let root: string;
let restore: () => void;
let custody: ResetBackupCustody;
let journal: ResetJournal;
let job: CustodyBackupJob;
const record = (suffix = '') => path.join(root, `${journal.id}${suffix}`, 'record.json');
const complete = () => custody.complete({ ...journal, phase: 'complete' }, async () => true);
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  directory = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-backup-custody-')));
  restore = stabilizeDarwinFixtureCreation(() => directory);
  root = path.join(directory, 'backups', 'reset-custody');
  custody = new ResetBackupCustody(root);
  journal = {
    version: 1,
    id: randomUUID(),
    controller: 'original-controller',
    createdAt: Date.now(),
    accounts: 'remove',
    users: [7],
    phase: 'prepared',
  };
  job = {
    version: 1,
    id: randomUUID(),
    ownerId: 7,
    createdAt: Date.now(),
    status: 'ready',
    stage: 'complete',
    completedBytes: 42,
    totalBytes: 42,
    bytes: 42,
    sha256: 'a'.repeat(64),
    selection: defaultSettingsBackupSelection(),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(directory, { recursive: true, force: true });
});

it('keeps the captured reset identity immutable across an authorized controller recreation', async () => {
  await custody.prepare(journal, [job]);
  const original = await fs.readFile(record());
  await custody.prepare({ ...journal, controller: 'replacement-controller' }, []);
  await custody.complete({ ...journal, controller: 'replacement-controller', phase: 'complete' }, async () => true);
  expect(await fs.readFile(record())).toEqual(original);
  expect(await custody.quarantined()).toEqual(new Set([job.id]));
  await expect(custody.prepare({ ...journal, users: [8] }, [job])).rejects.toThrow();
  await expect(custody.complete({ ...journal, createdAt: journal.createdAt + 1, phase: 'complete' }, async () => true)).rejects.toThrow();
});

it('does not fabricate custody for a legacy reset and does nothing for a reset that keeps accounts', async () => {
  const receipt = vi.fn(async () => true);
  await custody.complete({ ...journal, phase: 'complete' }, receipt);
  expect(receipt).not.toHaveBeenCalled();
  await custody.prepare({ ...journal, accounts: 'keep' }, [job]);
  await custody.complete({ ...journal, accounts: 'keep', phase: 'complete' }, receipt);
  expect(await custody.pending()).toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
  await expect(custody.prepare({ ...journal, phase: 'complete' }, [job])).rejects.toThrow();
  expect(await fs.readdir(root)).toEqual([]);
});

it('requires the real receipt before publishing availability and rejects a malformed prepared record', async () => {
  await custody.prepare(journal, [job]);
  await expect(custody.complete({ ...journal, phase: 'complete' }, async () => false)).rejects.toThrow();
  expect(await custody.quarantined()).toEqual(new Set());
  const value = JSON.parse(await fs.readFile(record(), 'utf8'));
  await fs.writeFile(record(), JSON.stringify({ ...value, unwitnessed: true }), { mode: 0o600 });
  stabilizeExistingDarwinFixtures(directory);
  await expect(complete()).rejects.toThrow();
  await expect(fs.lstat(record('.available'))).rejects.toHaveProperty('code', 'ENOENT');
});

it.each(['symlink', 'hardlink', 'public-mode', 'oversized', 'missing-content'] as const)(
  'rejects a prepared ledger record with %s without weakening the private filesystem reader',
  async (variant) => {
    await custody.prepare(journal, [job]);
    if (variant === 'symlink' || variant === 'hardlink') {
      const other = path.join(directory, 'preserved-record');
      await fs.rename(record(), other);
      if (variant === 'symlink') await fs.symlink(other, record());
      else await fs.link(other, record());
    } else if (variant === 'public-mode') await fs.chmod(record(), 0o644);
    else if (variant === 'oversized') await fs.writeFile(record(), ' '.repeat(65_537), { mode: 0o600 });
    else await fs.unlink(record());
    stabilizeExistingDarwinFixtures(directory);
    await expect(complete()).rejects.toThrow();
  },
);

it('rejects an unsafe ledger directory, unknown residue and orphaned availability markers', async () => {
  await custody.prepare(journal, [job]);
  await fs.chmod(root, 0o755);
  await expect(custody.pending()).rejects.toThrow();
  await fs.chmod(root, 0o700);
  await fs.writeFile(path.join(root, 'unknown-record'), 'review', { mode: 0o600 });
  await expect(custody.pending()).rejects.toThrow();
  await fs.unlink(path.join(root, 'unknown-record'));
  await fs.mkdir(path.join(root, `${randomUUID()}.available`), { mode: 0o700 });
  await expect(custody.pending()).rejects.toThrow();
});

it('atomically records one claimant before any metadata writes when independent callers race', async () => {
  await custody.prepare(journal, [job]);
  await complete();
  const other = new ResetBackupCustody(root);
  let admitted = 0;
  let both: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    both = resolve;
  });
  const validate = async () => {
    admitted++;
    if (admitted === 2) both();
    await barrier;
  };
  const writes = vi.fn(async (value: CustodyBackupJob) => {
    const claim = JSON.parse(await fs.readFile(record('.claim'), 'utf8'));
    expect(claim.claimantId).toBe(value.ownerId);
  });
  const results = await Promise.allSettled([custody.claim(8, validate, async () => job, writes), other.claim(9, validate, async () => job, writes)]);
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
  expect(writes).toHaveBeenCalledOnce();
  expect(await custody.pending()).toEqual([]);
});

it('preserves a synced, unpublished temporary record after a simulated crash without treating it as availability', async () => {
  await custody.prepare(journal, [job]);
  const temporary = path.join(root, `.custody-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  await fs.writeFile(path.join(temporary, 'record.json'), JSON.stringify({ version: 1, resetId: journal.id }), { mode: 0o600 });
  expect(await custody.pending()).toEqual([]);
  expect(await fs.readFile(path.join(temporary, 'record.json'), 'utf8')).toContain(journal.id);
  await complete();
  expect(await custody.quarantined()).toEqual(new Set([job.id]));
});
