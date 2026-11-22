import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@runtipi/common/types';
import { expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';

vi.unmock('node:fs');
vi.unmock('fs');

it('reads only ordered regular YAML migration IDs from the selected package', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'orbis-migration-discovery-'));
  try {
    const filesystem = mock<FilesystemService>();
    filesystem.getSafeFilePath.mockImplementation((name) => name);
    const files = new AppFilesManager(mock<ConfigurationService>(), filesystem, mock<LoggerService>());
    const urn = 'example:local' as AppUrn;
    const migrationDirectory = path.join(root, 'migrations');
    await expect(files.getAppMigrationIds(urn, root)).resolves.toEqual([]);
    await fs.mkdir(migrationDirectory);
    await fs.writeFile(path.join(migrationDirectory, '002-second.yml'), 'test');
    await fs.writeFile(path.join(migrationDirectory, '001-first.yml'), 'test');
    await fs.writeFile(path.join(migrationDirectory, 'README.md'), 'test');
    await expect(files.getAppMigrationIds(urn, root)).resolves.toEqual(['001-first', '002-second']);
    const link = path.join(migrationDirectory, '003-link.yml');
    await fs.symlink('001-first.yml', link);
    await expect(files.getAppMigrationIds(urn, root)).rejects.toThrow('Invalid application migration file.');
    await fs.unlink(link);
    await fs.link(path.join(migrationDirectory, '002-second.yml'), link);
    await expect(files.getAppMigrationIds(urn, root)).rejects.toThrow('Invalid application migration file.');
    await fs.unlink(link);
    await fs.writeFile(path.join(migrationDirectory, '004-unsupported.yaml'), 'test');
    await expect(files.getAppMigrationIds(urn, root)).rejects.toThrow('must use the .yml extension');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
