import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import type { ArchiveService } from '@/core/archive/archive.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppUrn } from '@runtipi/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupManager } from '../backup.manager';

const writeFile = async (filePath: string, content: string) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);
};

describe('BackupManager file security', () => {
  let manager: BackupManager;

  beforeEach(() => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as LoggerService;

    const config = {
      get: vi.fn().mockReturnValue({ dataDir: DATA_DIR }),
    } as unknown as ConfigurationService;

    manager = new BackupManager({} as ArchiveService, logger, config, new FilesystemService(logger), {} as AppFilesManager);
  });

  it('does not return backup paths for symlink targets', async () => {
    const backupPath = path.join(DATA_DIR, 'backups', 'store', 'demo', 'demo-store-1.tar.gz');
    await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.promises.symlink(path.join(DATA_DIR, '.env'), backupPath);

    await expect(manager.getBackupPath('demo:store' as AppUrn, 'demo-store-1.tar.gz')).rejects.toThrow('The backup file does not exist');
  });

  it('still returns regular backup file paths', async () => {
    const backupPath = path.join(DATA_DIR, 'backups', 'store', 'demo', 'demo-store-1.tar.gz');
    await writeFile(backupPath, 'backup');

    await expect(manager.getBackupPath('demo:store' as AppUrn, 'demo-store-1.tar.gz')).resolves.toBe(backupPath);
  });
});
