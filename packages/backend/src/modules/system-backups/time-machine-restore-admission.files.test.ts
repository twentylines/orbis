import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupRestoreJournal } from './backup-restore-journal';
import {
  recordRetainedRestoreAdmission,
  readRetainedRestoreReceipt,
  consumeRetainedRestorePermit,
  type RetainedRestorePermit,
} from './time-machine-restore-admission';

const binding = {
  pointId: randomUUID(),
  reviewId: randomUUID(),
  archiveSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  machineId: 'c'.repeat(64),
};
let root: string;
let journal: BackupRestoreJournal;
let importId: string;
const verify = vi.fn();
const record = () => recordRetainedRestoreAdmission(journal, 1, importId, binding, { sha256: 'd'.repeat(64), verify });
const receiptFile = () => path.join(journal.directory, 'time-machine-admission.json');
const createJournal = () =>
  BackupRestoreJournal.create(root, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '1'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-retained-admission-')));
  journal = await createJournal();
  importId = randomUUID();
  verify.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('records only bounded recovery identity and consumes a distinct one-use permit', async () => {
  const permit = await record();
  const receipt = await readRetainedRestoreReceipt(journal);
  expect(receipt).toMatchObject({
    restoreId: journal.state.id,
    nonce: journal.state.nonce,
    ownerId: 1,
    importId,
    binding,
    authorizationSha256: 'd'.repeat(64),
  });
  expect((await fs.stat(receiptFile())).mode & 0o777).toBe(0o600);
  const claimed = await consumeRetainedRestorePermit(permit, journal, 1, importId, binding);
  expect(claimed.receipt).toEqual(receipt);
  await claimed.verify();
  expect(verify).toHaveBeenCalledTimes(2);
  await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow();
});

it.each(['pointId', 'reviewId', 'archiveSha256', 'manifestSha256', 'machineId'] as const)(
  'burns a permit presented for a different %s',
  async (field) => {
    const permit = await record();
    const changed = { ...binding, [field]: field.endsWith('Id') && field !== 'machineId' ? randomUUID() : 'f'.repeat(64) };
    await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, changed)).rejects.toThrow();
    await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
  },
);

it.each(['owner', 'import', 'journal'] as const)('refuses a different %s before any source ownership change', async (field) => {
  const permit = await record();
  const target = field === 'journal' ? ({ directory: path.join(root, randomUUID()) } as BackupRestoreJournal) : journal;
  await expect(
    consumeRetainedRestorePermit(permit, target, field === 'owner' ? 2 : 1, field === 'import' ? randomUUID() : importId, binding),
  ).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(journal.directory, 'source'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires an existing active staging journal before writing a durable receipt', async () => {
  await fs.rm(path.join(root, 'active.json'));
  await expect(record()).rejects.toThrow();
  await expect(fs.stat(receiptFile())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reloads an inert receipt without authority, discards the unstarted journal, and allows fresh admission in a new journal', async () => {
  const oldPermit = await record();
  vi.resetModules();
  const reloaded = await import('./time-machine-restore-admission');
  expect(await reloaded.readRetainedRestoreReceipt(journal)).toMatchObject({ binding, importId });
  await expect(reloaded.consumeRetainedRestorePermit(oldPermit, journal, 1, importId, binding)).rejects.toThrow();
  await expect(reloaded.consumeRetainedRestorePermit(JSON.parse(JSON.stringify(oldPermit)), journal, 1, importId, binding)).rejects.toThrow();
  await journal.discardStaging();
  expect(journal.state.phase).toBe('discarded');
  journal = await createJournal();
  const fresh = await reloaded.recordRetainedRestoreAdmission(journal, 1, importId, binding, { sha256: 'e'.repeat(64), verify });
  await expect(reloaded.consumeRetainedRestorePermit(fresh, journal, 1, importId, binding)).resolves.toMatchObject({ receipt: { binding } });
});

it.each([120_000, -1])('refuses an expired or backwards-clock permit (%i)', async (elapsed) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const permit = await record();
  clock.mockReturnValue(now + elapsed);
  await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow();
});

it('rejects a tampered or publicly readable receipt, and never upgrades a serialized receipt into authority', async () => {
  const permit = await record();
  const receipt = await readRetainedRestoreReceipt(journal);
  await expect(consumeRetainedRestorePermit(receipt as unknown as RetainedRestorePermit, journal, 1, importId, binding)).rejects.toThrow();
  await fs.writeFile(receiptFile(), JSON.stringify({ ...receipt, authorizationSha256: 'e'.repeat(64) }));
  await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow();
  await fs.chmod(receiptFile(), 0o644);
  await expect(readRetainedRestoreReceipt(journal)).rejects.toThrow();
});

it('rereads the actor at consumption and does not leave a revoked permit retryable', async () => {
  const permit = await record();
  verify.mockRejectedValueOnce(new Error('Session revoked'));
  await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow('Session revoked');
  await expect(consumeRetainedRestorePermit(permit, journal, 1, importId, binding)).rejects.toThrow();
});
