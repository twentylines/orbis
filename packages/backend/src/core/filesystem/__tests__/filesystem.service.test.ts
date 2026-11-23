import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { FilesystemService } from '../filesystem.service';

const filesystem = () => new FilesystemService({ error: vi.fn() } as never);
afterEach(() => vi.restoreAllMocks());

test('preserves the permission failure when temporary-directory cleanup also fails', async () => {
  const failure = new Error('Synthetic permission failure');
  const directory = '/temporary-fixture-created';
  vi.spyOn(fs.promises, 'mkdtemp').mockResolvedValue(directory);
  vi.spyOn(fs.promises, 'chmod').mockRejectedValue(failure);
  const cleanup = vi.spyOn(fs.promises, 'rmdir').mockRejectedValue(new Error('Synthetic cleanup failure'));

  await expect(filesystem().createTempDirectory('/temporary-fixture-')).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledWith(directory);
});

test('refuses and removes temporary storage whose permissions remain exposed', async () => {
  const directory = '/temporary-fixture-created';
  vi.spyOn(fs.promises, 'mkdtemp').mockResolvedValue(directory);
  vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);
  vi.spyOn(fs.promises, 'lstat').mockResolvedValue({ mode: 0o755 } as never);
  const cleanup = vi.spyOn(fs.promises, 'rmdir').mockResolvedValue(undefined);

  await expect(filesystem().createTempDirectory('/temporary-fixture-')).rejects.toThrow('not private');
  expect(cleanup).toHaveBeenCalledWith(directory);
});
