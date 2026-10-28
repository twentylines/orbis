import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackupRestoreJournal, restoreStartupAllowed } from './backup-restore-journal';
import {
  readRestoreBootstrap,
  requestRestoreCancellation,
  restoreCancellationRequested,
  writeRestoreBootstrap,
  type RestoreBootstrap,
} from './backup-restore-bootstrap';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-restore-bootstrap-')));
  await fs.chmod(root, 0o700);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const digest = createHash('sha256').update('synthetic bootstrap fixture').digest('hex');
async function fixture() {
  const journal = await BackupRestoreJournal.create(path.join(root, 'restores'), {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    verifierController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  const snapshot = (digit: string) => ({
    id: digit.repeat(64),
    fingerprint: digit.repeat(64),
    running: digit === '1',
    restart: { Name: 'no' as const, MaximumRetryCount: 0 },
  });
  const value: RestoreBootstrap = {
    version: 1,
    ownerId: 1,
    identity: {
      version: 1,
      id: journal.state.id,
      nonce: journal.state.nonce,
      image: `sha256:${digest}`,
      original: snapshot('1'),
      candidate: snapshot('1'),
      verifier: snapshot('2'),
      worker: snapshot('3'),
      apps: [],
      queue: { host: 'fixture-queue', username: 'fixture', password: 'synthetic fixture' },
    },
    connection: { host: 'fixture-db', port: 5432, user: 'fixture', password: 'synthetic fixture', database: 'original' },
    source: {
      version: 1,
      manifest: { bytes: 1, sha256: digest },
      recovery: { bytes: 1, sha256: digest },
      database: { bytes: 1, sha256: digest },
      normalized: { bytes: 1, sha256: digest, counts: { user: 1, app: 0, app_store: 0, link: 0 } },
    },
    environmentSha256: digest,
  };
  return { journal, value };
}

it('persists an exclusive, private handoff without inventing database ownership or prepared files', async () => {
  const { journal, value } = await fixture();
  expect(await writeRestoreBootstrap(journal, value)).toEqual(value);
  const file = await fs.stat(path.join(journal.directory, 'bootstrap.json'));
  expect(file.mode & 0o777).toBe(0o600);
  expect(file.nlink).toBe(1);
  expect(await readRestoreBootstrap(journal)).toEqual(value);
  await expect(fs.lstat(path.join(journal.directory, 'runtime.json'))).rejects.toHaveProperty('code', 'ENOENT');
  await expect(writeRestoreBootstrap(journal, value)).rejects.toHaveProperty('code', 'EEXIST');
});

it('keeps the original controller blocked throughout interrupted preparation', async () => {
  const { journal, value } = await fixture();
  await writeRestoreBootstrap(journal, value);
  await journal.advance('preparing');
  const reopened = await BackupRestoreJournal.active(path.dirname(journal.directory));
  if (!reopened) throw new Error('Missing fixture journal');
  for (const id of [value.identity.original.id, value.identity.verifier.id, value.identity.worker?.id])
    expect(restoreStartupAllowed(reopened.state, id ?? '')).toBe(false);
  await reopened.advance('discarded');
  expect(restoreStartupAllowed(reopened.state, value.identity.original.id)).toBe(true);
});

it.each(['nonce', 'id'] as const)('refuses a handoff with a different %s', async (key) => {
  const { journal, value } = await fixture();
  value.identity[key] = randomUUID();
  await expect(writeRestoreBootstrap(journal, value)).rejects.toThrow();
});

it('refuses a worker snapshot belonging to another container', async () => {
  const { journal, value } = await fixture();
  if (!value.identity.worker) throw new Error('Missing fixture worker');
  value.identity.worker.id = '4'.repeat(64);
  await expect(writeRestoreBootstrap(journal, value)).rejects.toThrow();
});

it('does not accept prepared database fields in a bootstrap identity', async () => {
  const { journal, value } = await fixture();
  Object.assign(value.identity, { database: { owner: 'unverified' } });
  await expect(writeRestoreBootstrap(journal, value)).rejects.toThrow();
});

it.each(['symlink', 'hardlink', 'readable'] as const)('refuses an unsafe %s handoff', async (kind) => {
  const { journal, value } = await fixture();
  const file = path.join(journal.directory, 'bootstrap.json');
  if (kind === 'symlink') {
    const external = path.join(root, 'external');
    await fs.writeFile(external, JSON.stringify(value), { mode: 0o600 });
    await fs.symlink(external, file);
  } else {
    await writeRestoreBootstrap(journal, value);
    if (kind === 'hardlink') await fs.link(file, path.join(root, 'linked'));
    else await fs.chmod(file, 0o644);
  }
  await expect(readRestoreBootstrap(journal)).rejects.toThrow();
});

it('persists concurrent cancellation requests as a single durable identity-bound intent', async () => {
  const { journal } = await fixture();
  expect(await restoreCancellationRequested(journal)).toBe(false);
  await Promise.all(Array.from({ length: 5 }, () => requestRestoreCancellation(journal)));
  const reopened = await BackupRestoreJournal.active(path.dirname(journal.directory));
  if (!reopened) throw new Error('Missing fixture journal');
  expect(await restoreCancellationRequested(reopened)).toBe(true);
  const stat = await fs.stat(path.join(journal.directory, 'cancel.json'));
  expect(stat.nlink).toBe(1);
  expect(stat.mode & 0o777).toBe(0o600);
});

it('rejects cancellation material from another transaction', async () => {
  const { journal } = await fixture();
  await fs.writeFile(path.join(journal.directory, 'cancel.json'), JSON.stringify({ version: 1, id: randomUUID(), nonce: journal.state.nonce }), {
    mode: 0o600,
  });
  await expect(restoreCancellationRequested(journal)).rejects.toThrow();
});

it('does not accept a new cancellation after the transaction settles', async () => {
  const { journal } = await fixture();
  await journal.advance('discarded');
  await expect(requestRestoreCancellation(journal)).rejects.toThrow('no longer be cancelled');
  expect(await restoreCancellationRequested(journal)).toBe(false);
});
