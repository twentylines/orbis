import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  setSettingsRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { SettingsBackupTransaction } from './settings-backup-transaction';
import { withRestoreLease } from './backup-restore-lease';
import { prepareSettingsRestoreEnvironment } from './settings-restore-startup';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';

let root: string;
let restore: () => void;
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-startup-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  setSettingsRestoreRecoveryRequired(false);
});
afterEach(async () => {
  setSettingsRestoreRecoveryRequired(false);
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
it('holds interrupted settings recovery before generating any connection or seed files, then resumes normal generation only after rollback', async () => {
  const store = path.join(root, 'backups/settings-restores');
  await withRestoreLease(store, async () => {
    const transaction = await SettingsBackupTransaction.reserve({
      dataDir: root,
      ownerId: 7,
      importId: randomUUID(),
      reviewId: randomUUID(),
      archiveSha256: 'a'.repeat(64),
    });
    const generate = vi.fn(async () => fs.writeFile(path.join(root, 'generated-env'), 'generated'));
    expect(await prepareSettingsRestoreEnvironment(root, generate)).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(backupMaintenanceActive()).toBe(true);
    await expect(fs.stat(path.join(root, 'generated-env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await transaction.rollback(new AbortController().signal);
    expect(await prepareSettingsRestoreEnvironment(root, generate)).toBe(false);
    expect(generate).toHaveBeenCalledOnce();
    expect(backupMaintenanceActive()).toBe(false);
  });
});
it('does not rewrite an unverifiable recovery store or create one on ordinary first boot', async () => {
  const generate = vi.fn().mockResolvedValue(undefined);
  expect(await prepareSettingsRestoreEnvironment(root, generate)).toBe(false);
  await expect(fs.stat(path.join(root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  const store = path.join(root, 'backups/settings-restores');
  await fs.mkdir(store, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(store, 'active.json'), 'invalid pending receipt', { mode: 0o600 });
  generate.mockClear();
  expect(await prepareSettingsRestoreEnvironment(root, generate)).toBe(true);
  expect(generate).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(store, 'active.json'), 'utf8')).toBe('invalid pending receipt');
});
