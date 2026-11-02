import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackupRetentionPolicy, backupExpiresAt, parseBackupRetentionUpdate } from './backup-retention-policy';
let directory: string;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-backup-retention-')));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
it('defaults to24h, persists private settings and rejects stale concurrent revisions', async () => {
  const store = new BackupRetentionPolicy(path.join(directory, 'settings'));
  expect(await store.read()).toEqual({ version: 1, revision: 0, retentionHours: 24 });
  const results = await Promise.allSettled([store.update({ revision: 0, retentionHours: 168 }), store.update({ revision: 0, retentionHours: 720 })]);
  expect(results.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
  expect(await new BackupRetentionPolicy(path.join(directory, 'settings')).read()).toEqual({ version: 1, revision: 1, retentionHours: 168 });
  expect((await fs.stat(path.join(directory, 'settings', 'retention.json'))).mode & 0o777).toBe(0o600);
});
it.each([
  {},
  { revision: 0, retentionHours: 23 },
  { revision: 0, retentionHours: 8761 },
  { revision: 0, retentionHours: 24.5 },
  { revision: 0, retentionHours: 24, path: '/outside' },
])('rejects unsafe retention input', (input) => {
  expect(() => parseBackupRetentionUpdate(input)).toThrow();
});
it('never shortens an existing backup deadline', () => {
  const start = 1000;
  const longer = backupExpiresAt(start, 168);
  expect(backupExpiresAt(start, 24, longer)).toBe(longer);
  expect(backupExpiresAt(start, 720, longer)).toBeGreaterThan(longer);
});
it('fails closed on malformed settings without deleting sibling encrypted files', async () => {
  await fs.mkdir(path.join(directory, 'settings'), { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'settings', 'retention.json'), '{bad', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'preserved.orbis'), 'encrypted fixture', { mode: 0o600 });
  await expect(new BackupRetentionPolicy(path.join(directory, 'settings')).read()).rejects.toThrow();
  expect(await fs.readFile(path.join(directory, 'preserved.orbis'), 'utf8')).toBe('encrypted fixture');
});
it('rejects symlinked or public policy files', async () => {
  await fs.mkdir(path.join(directory, 'settings'), { mode: 0o700 });
  const file = path.join(directory, 'settings', 'retention.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, revision: 0, retentionHours: 24 }), { mode: 0o644 });
  await expect(new BackupRetentionPolicy(path.join(directory, 'settings')).read()).rejects.toThrow();
  await fs.rename(file, path.join(directory, 'outside'));
  await fs.symlink(path.join(directory, 'outside'), file);
  await expect(new BackupRetentionPolicy(path.join(directory, 'settings')).read()).rejects.toThrow();
});
