import { expect, test } from 'bun:test';
import {
  backupPollingInterval,
  canRestore,
  exportListSchema,
  importJobSchema,
  parseBackupResponse,
  progressPercent,
  restoreStatusSchema,
  type ImportJob,
} from './contracts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reviewed: ImportJob = {
  id,
  status: 'reviewed',
  stage: 'complete',
  createdAt: 1,
  updatedAt: 2,
  completedBytes: 100,
  totalBytes: 100,
  uploadedBytes: 100,
  message: 'Verified',
  reviewExpiresAt: 1000,
  review: {
    formatVersion: 1,
    createdAt: 1,
    orbisVersion: '1.0.0',
    runtipiVersion: '4.1.0',
    architecture: 'amd64',
    fileCount: 10,
    appCount: 1,
    expandedBytes: 1000,
    manifestSha256: 'a'.repeat(64),
    databaseValidation: 'validated',
    compatibility: { compatible: true, blockers: [], architectureChanged: false },
  },
};

test('reviewed manifest is required, valid and unexpired before replacement becomes available', () => {
  const job = parseBackupResponse(importJobSchema, reviewed);
  if (!job.review) throw new Error('Missing test manifest');
  expect(canRestore(job, 999)).toBe(true);
  expect(canRestore(job, 1000)).toBe(false);
  expect(canRestore({ ...job, reviewExpiresAt: undefined }, 1)).toBe(false);
  expect(canRestore({ ...job, status: 'uploaded' }, 1)).toBe(false);
  expect(canRestore({ ...job, review: undefined }, 1)).toBe(false);
  expect(canRestore({ ...job, review: { ...job.review, databaseValidation: 'pending' } }, 1)).toBe(false);
  expect(canRestore({ ...job, review: { ...job.review, compatibility: { compatible: false, blockers: [], architectureChanged: false } } }, 1)).toBe(
    false,
  );
  expect(
    canRestore(
      { ...job, review: { ...job.review, compatibility: { compatible: true, blockers: ['runtipi-version'], architectureChanged: false } } },
      1,
    ),
  ).toBe(false);
});

test('architecture changes are disclosed without inventing an unsupported restore veto', () => {
  if (!reviewed.review) throw new Error('Missing test manifest');
  expect(
    canRestore({ ...reviewed, review: { ...reviewed.review, compatibility: { compatible: true, blockers: [], architectureChanged: true } } }, 1),
  ).toBe(true);
});

test('unknown states, invalid hash/IDs and unsafe byte counts fail closed', () => {
  for (const value of [
    { ...reviewed, status: 'complete' },
    { ...reviewed, id: '../data' },
    { ...reviewed, uploadedBytes: -1 },
    { ...reviewed, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...reviewed, review: { ...reviewed.review, manifestSha256: 'wrong' } },
    { ...reviewed, review: { ...reviewed.review, compatibility: { compatible: true, blockers: ['force'], architectureChanged: false } } },
  ])
    expect(() => parseBackupResponse(importJobSchema, value)).toThrow('unsupported backup response');
});

test('progress never promises completion for transferred bytes until server confirmation', () => {
  expect(progressPercent(0, 100)).toBe(0);
  expect(progressPercent(51, 100)).toBe(51);
  expect(progressPercent(100, 100)).toBe(99);
  expect(progressPercent(200, 100)).toBe(99);
  expect(progressPercent(100, 100, true)).toBe(100);
  expect(progressPercent(0, 0)).toBeUndefined();
  expect(progressPercent(5, null)).toBeUndefined();
  expect(progressPercent(-1, 100)).toBeUndefined();
  expect(progressPercent(Number.NaN, 100)).toBeUndefined();
});

test('empty capabilities and recovery status are real server states', () => {
  expect(parseBackupResponse(exportListSchema, { available: false, retentionHours: 24, jobs: [] }).available).toBe(false);
  expect(parseBackupResponse(restoreStatusSchema, { job: null }).job).toBeNull();
  const job = {
    id,
    status: 'recovery-required',
    stage: 'files',
    phase: 'staging',
    message: 'Recovery needs review.',
    needsRecovery: true,
    progressUnavailable: true,
    canCancel: true,
    canRecover: true,
  };
  expect(parseBackupResponse(restoreStatusSchema, { job }).job?.canRecover).toBe(true);
  expect(() => parseBackupResponse(restoreStatusSchema, { job: { ...job, canRecover: 'yes' } })).toThrow();
});

test('idle status polls slowly, active recovery polls promptly and hidden windows stop polling', () => {
  const idle = {
    exports: { available: true, retentionHours: 24, jobs: [] },
    imports: { available: true, retentionHours: 24, jobs: [] },
    restore: { job: null },
  };
  expect(backupPollingInterval(idle, true)).toBe(30_000);
  expect(backupPollingInterval(undefined, true)).toBe(30_000);
  expect(backupPollingInterval(idle, false)).toBe(false);
  expect(backupPollingInterval({ ...idle, imports: { ...idle.imports, jobs: [{ ...reviewed, status: 'reviewing' }] } }, true)).toBe(2500);
});
