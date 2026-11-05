import { expect, test } from 'bun:test';
import { settingsBackupImportJobSchema, settingsBackupReviewSchema } from './settings-backup-import.js';

const id = '11111111-1111-4111-8111-111111111111';
const available = { version: 1, settings: false, dashboard: true, wallpapers: false, themes: false, timeMachine: [] };
const review = {
  version: 1,
  reviewId: id,
  archiveSha256: 'a'.repeat(64),
  createdAt: '2026-11-05T00:00:00.000Z',
  orbisVersion: '0.6.1-beta.3',
  contents: [{ kind: 'dashboard', id: null, bytes: 100, items: 2 }],
  available,
  expiresAt: 100,
};
test('review availability must exactly match the verified contents, including unique capture identities', () => {
  expect(settingsBackupReviewSchema.allows(review)).toBe(true);
  expect(settingsBackupReviewSchema.allows({ ...review, available: { ...available, themes: true } })).toBe(false);
  expect(settingsBackupReviewSchema.allows({ ...review, contents: [...review.contents, ...review.contents] })).toBe(false);
  expect(settingsBackupReviewSchema.allows({ ...review, available: { ...available, timeMachine: [id] } })).toBe(false);
  const capture = { kind: 'time-machine', id, pointId: id, bytes: 100, items: 1, capturedAt: 1, orbisVersion: '0.6.1' };
  expect(
    settingsBackupReviewSchema.allows({ ...review, contents: [capture], available: { ...available, dashboard: false, timeMachine: [id] } }),
  ).toBe(true);
  expect(settingsBackupReviewSchema.allows({ ...review, contents: [{ ...capture, pointId: undefined }] })).toBe(false);
});
test('public import jobs expose only safe verified summaries and honest bounded progress', () => {
  const job = {
    id,
    status: 'reviewed',
    createdAt: 1,
    updatedAt: 2,
    uploadedBytes: 100,
    completedBytes: 100,
    totalBytes: null,
    message: 'Verified',
    review,
  };
  expect(settingsBackupImportJobSchema.allows(job)).toBe(true);
  expect(settingsBackupImportJobSchema.allows({ ...job, review: undefined })).toBe(false);
  expect(settingsBackupImportJobSchema.allows({ ...job, status: 'uploaded' })).toBe(false);
  expect(settingsBackupImportJobSchema.allows({ ...job, totalBytes: 5 })).toBe(false);
  for (const key of ['passphrase', 'password', 'ownerId', 'directory', 'pointKey'])
    expect(settingsBackupImportJobSchema.allows({ ...job, [key]: 'private' })).toBe(false);
});
