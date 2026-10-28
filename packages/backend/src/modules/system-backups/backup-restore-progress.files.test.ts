import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreProgress } from './backup-restore-progress';

let root: string;
let journal: BackupRestoreJournal;
let file: string;
const record = () => ({
  status: 'running',
  stage: 'files',
  message: 'private worker detail',
  updatedAt: Date.now(),
  preparation: { stage: 'files', completedBytes: 12, totalBytes: 40, records: 1, totalRecords: 3 },
});
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-progress-')));
  journal = await BackupRestoreJournal.create(path.join(root, 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    verifierController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  file = path.join(journal.directory, 'worker-status.json');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('returns measured progress without exposing private worker messages', async () => {
  const value = record();
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const { message: _message, ...expected } = value;
  expect(await readRestoreProgress(journal)).toEqual(expected);
});
it('allows indeterminate totals without fabricating a percentage', async () => {
  const value = record();
  await fs.writeFile(file, JSON.stringify({ ...value, preparation: { ...value.preparation, totalBytes: null, totalRecords: null } }), {
    mode: 0o600,
  });
  expect((await readRestoreProgress(journal))?.preparation?.totalBytes).toBeNull();
});
it('returns no progress before the worker has written its first record', async () => {
  expect(await readRestoreProgress(journal)).toBeUndefined();
});
it.each(['symlink', 'hardlink', 'readable', 'oversize', 'directory'] as const)('rejects %s progress storage', async (kind) => {
  if (kind === 'symlink') {
    const target = path.join(root, 'outside');
    await fs.writeFile(target, JSON.stringify(record()), { mode: 0o600 });
    await fs.symlink(target, file);
  } else if (kind === 'directory') await fs.mkdir(file);
  else {
    await fs.writeFile(file, kind === 'oversize' ? ' '.repeat(16385) : JSON.stringify(record()), { mode: 0o600 });
    if (kind === 'hardlink') await fs.link(file, path.join(root, 'linked'));
    if (kind === 'readable') await fs.chmod(file, 0o644);
  }
  await expect(readRestoreProgress(journal)).rejects.toThrow();
});
it.each([
  { status: 'unknown' },
  { stage: 'unknown' },
  { check: '../private' },
  { path: '/private' },
  { updatedAt: -1 },
  { preparation: { ...record().preparation, completedBytes: 41 } },
  { preparation: { ...record().preparation, records: 4 } },
  { preparation: { ...record().preparation, completedBytes: -1 } },
  { preparation: { ...record().preparation, records: 0.5 } },
  { preparation: { ...record().preparation, secret: 'private' } },
])('rejects invalid or unbounded progress fields %#', async (override) => {
  await fs.writeFile(file, JSON.stringify({ ...record(), ...override }), { mode: 0o600 });
  await expect(readRestoreProgress(journal)).rejects.toThrow('could not be verified');
});
