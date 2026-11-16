import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { acquireBackupMaintenance, setResetOperationActive, setResetRecoveryRequired } from '@/common/backup-maintenance';
import { notifyResetStarted, observeClientStatusChanges, readClientOperationStatus, readOperationStatus } from '@/common/restoration-status';
import type { ResetJournal } from './reset-contract';

const completed: ResetJournal = {
  version: 1,
  id: randomUUID(),
  controller: 'fixture-controller',
  accounts: 'remove',
  users: [1],
  phase: 'complete',
  createdAt: Date.now(),
};
const status = (readReset = async (): Promise<ResetJournal | null> => completed) =>
  readOperationStatus(
    async () => ({ state: 'idle' }),
    async () => 'idle',
    readReset,
  );

afterEach(() => {
  setResetOperationActive(false);
  setResetRecoveryRequired(false);
});

it('withholds idle and client departure while a completed reset is still settling', async () => {
  setResetOperationActive(true);
  expect(await status()).toEqual({ state: 'resetting', stage: 'resetting' });
  expect(
    await readClientOperationStatus(
      () => status(),
      async () => completed,
    ),
  ).toMatchObject({ status: { state: 'resetting' } });
  setResetOperationActive(false);
  expect(await status()).toEqual({ state: 'idle' });
});

it('does not infer idle from a missing journal while the authorized reset is active', async () => {
  setResetOperationActive(true);
  expect(await status(async () => null)).toEqual({ state: 'resetting', stage: 'resetting' });
});

it('retains recovery after a completed journal when ownership or lease cleanup failed', async () => {
  setResetRecoveryRequired(true);
  expect(await status()).toEqual({ state: 'resetting', stage: 'recovering' });
  setResetRecoveryRequired(false);
  expect(await status()).toEqual({ state: 'idle' });
});

it('does not infer idle from missing reset storage while recovery is held', async () => {
  setResetRecoveryRequired(true);
  expect(await status(async () => null)).toEqual({ state: 'checking' });
});

it('does not label an unrelated snapshot lease as reset activity', async () => {
  const release = await acquireBackupMaintenance(AbortSignal.timeout(1000));
  try {
    expect(await status()).toEqual({ state: 'idle' });
  } finally {
    release();
  }
});

it('preserves higher-priority restore authority while reset activity is marked', async () => {
  setResetOperationActive(true);
  expect(
    await readOperationStatus(
      async () => ({ state: 'restoring', stage: 'restoring' }),
      async () => 'idle',
      async () => completed,
    ),
  ).toEqual({
    state: 'restoring',
    stage: 'restoring',
  });
});

it('signals connected clients when the authorized reset starts without waiting for the held drain', () => {
  let received = 0;
  const subscription = observeClientStatusChanges().subscribe(() => received++);
  try {
    notifyResetStarted();
    expect(received).toBe(0);
    setResetOperationActive(true);
    notifyResetStarted();
    expect(received).toBe(1);
  } finally {
    subscription.unsubscribe();
  }
});
