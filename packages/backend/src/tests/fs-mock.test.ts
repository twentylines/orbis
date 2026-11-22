import { expect, it } from 'vitest';
import { vol } from 'memfs';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';

it.each([
  { verbatimSymlinks: true, dereference: false, expected: '../outside' },
  { verbatimSymlinks: false, dereference: false, expected: '/data/outside' },
  { verbatimSymlinks: true, dereference: true, expected: null },
])('copies a directory with native symlink semantics for $verbatimSymlinks / $dereference', async (options) => {
  vol.mkdirSync('/data/source', { recursive: true });
  vol.writeFileSync('/data/outside', 'retained target');
  vol.symlinkSync('../outside', '/data/source/link');
  const filesystem = new FilesystemService({ error: () => undefined } as unknown as LoggerService);
  expect(await filesystem.copyDirectory('/data/source', '/data/copied', options)).toBe(true);
  if (options.expected === null) {
    expect(vol.lstatSync('/data/copied/link').isFile()).toBe(true);
    expect(vol.readFileSync('/data/copied/link', 'utf8')).toBe('retained target');
  } else {
    expect(vol.lstatSync('/data/copied/link').isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync('/data/copied/link')).toBe(options.expected);
  }
  expect(vol.readFileSync('/data/outside', 'utf8')).toBe('retained target');
});
