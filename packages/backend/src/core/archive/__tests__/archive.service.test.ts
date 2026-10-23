import { spawnAsync } from '@/common/helpers/exec-helpers';
import type { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '../archive.service';
import { readTarMetadata } from '../tar-metadata';

vi.mock('@/common/helpers/exec-helpers', () => ({
  spawnAsync: vi.fn(),
}));

vi.mock('../tar-metadata', () => ({ readTarMetadata: vi.fn() }));
const metadataMock = vi.mocked(readTarMetadata);
const spawnAsyncMock = vi.mocked(spawnAsync);

const createLogger = () =>
  ({
    debug: vi.fn(),
  }) as unknown as LoggerService;

describe('ArchiveService', () => {
  beforeEach(() => {
    spawnAsyncMock.mockReset();
    metadataMock.mockReset();
  });

  it('reads structured paths, types and link targets without parsing tar display text', async () => {
    const archive = '/data/backups/store/demo/backup.tar.gz';
    const entries = [
      { path: 'app-data/', type: 'd' },
      { path: 'app-data/logs/latest.log', type: 'l', linkTarget: 'dated.log' },
    ];
    spawnAsyncMock.mockResolvedValueOnce({ stdout: 'application/gzip\n', stderr: '' });
    metadataMock.mockResolvedValueOnce(entries);
    await expect(new ArchiveService(createLogger()).listTarGz(archive)).resolves.toEqual(entries);
    expect(spawnAsyncMock).toHaveBeenCalledExactlyOnceWith('file', ['--brief', '--mime-type', archive]);
    expect(metadataMock).toHaveBeenCalledExactlyOnceWith(archive, true, undefined);
  });
});
