import { spawnAsync } from '@/common/helpers/exec-helpers';
import type { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveService } from '../archive.service';
import { readTarMetadata } from '../tar-metadata';
import { availableParallelism } from 'node:os';

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

  it.each(['available', 'missing', 'rejected', 'unknown'] as const)('uses bounded parallel compression only when pigz is %s', async (state) => {
    if (state === 'rejected') spawnAsyncMock.mockRejectedValueOnce(new Error('Unavailable'));
    else spawnAsyncMock.mockResolvedValueOnce({ stdout: state === 'available' ? 'pigz 2.8\n' : '', stderr: state === 'missing' ? 'not found' : '' });
    spawnAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
    const archive = new ArchiveService(createLogger());
    await archive.createTarGz('/data/snapshot', '/data/one.tar.gz');
    await archive.createTarGz('/data/snapshot', '/data/two.tar.gz');
    expect(spawnAsyncMock.mock.calls.filter(([command]) => command === 'pigz')).toHaveLength(1);
    const compression = state === 'available' ? ['--use-compress-program', `pigz -p ${Math.min(4, availableParallelism())}`] : ['-z'];
    expect(spawnAsyncMock).toHaveBeenLastCalledWith(
      'tar',
      ['--format=pax', ...compression, '-cpf', '/data/two.tar.gz', '-C', '/data/snapshot', '.'],
      undefined,
    );
  });

  it('honors cancellation before the probe or after a pending compression probe', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new ArchiveService(createLogger()).createTarGz('/data/snapshot', '/data/one.tar.gz', controller.signal)).rejects.toThrow();
    expect(spawnAsyncMock).not.toHaveBeenCalled();
    const pending = new AbortController();
    let release!: (value: { stdout: string; stderr: string }) => void;
    spawnAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = new ArchiveService(createLogger()).createTarGz('/data/snapshot', '/data/one.tar.gz', pending.signal);
    pending.abort();
    release({ stdout: 'pigz 2.8', stderr: '' });
    await expect(result).rejects.toThrow();
    expect(spawnAsyncMock.mock.calls.every(([command]) => command === 'pigz')).toBe(true);
  });
});
